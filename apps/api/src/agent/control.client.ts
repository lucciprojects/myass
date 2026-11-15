import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { connect, type Socket } from "node:net";
import type {
  Chain,
  EffectKind,
  EffectSlot,
  LooperAction,
  LooperLayer,
  LooperState,
} from "@myass/protocol";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3002;
const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 3_000;
const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 5_000;
const MULTI_TERMINATOR = "end";

type CommandMode = "single" | "multi";

interface PendingCommand {
  mode: CommandMode;
  lines: string[];
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

export class AgentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRejectedError";
  }
}

function optionOf(tokens: string[], key: string): string | undefined {
  const prefix = `${key}=`;

  for (const token of tokens) {
    if (token.startsWith(prefix)) {
      return token.slice(prefix.length);
    }
  }

  return undefined;
}

function encodeSlot(index: number, slot: EffectSlot): string {
  const parts = [
    `SLOT ${index}`,
    `kind=${slot.kind}`,
    `enabled=${slot.enabled ? 1 : 0}`,
  ];

  for (const [key, value] of Object.entries(slot.params)) {
    parts.push(`${key}=${value.toFixed(4)}`);
  }

  return parts.join(" ");
}

// The agent stores kinds, flags and params, not client ids, so a read-back
// synthesises an id from the slot position.
function decodeSlot(line: string): EffectSlot {
  const tokens = line.trim().split(/\s+/);
  const kind = optionOf(tokens, "kind");
  const enabled = optionOf(tokens, "enabled");

  if (!kind) {
    throw new AgentRejectedError(`slot line missing kind: ${line}`);
  }

  const params: Record<string, number> = {};

  for (const token of tokens) {
    const equals = token.indexOf("=");

    if (equals <= 0) {
      continue;
    }

    const value = Number(token.slice(equals + 1));

    if (Number.isFinite(value)) {
      params[token.slice(0, equals)] = value;
    }
  }

  return {
    id: `agent-${tokens[2] ?? "0"}`,
    kind: kind as EffectKind,
    enabled: enabled === "1",
    params,
  };
}

// The layer index is positional on the wire ("layer 3 playing=1 ..."), so it is
// read from the second token rather than as a key=value pair.
function decodeLoopLayer(line: string): LooperLayer {
  const tokens = line.trim().split(/\s+/);
  const isSet = (key: string) => optionOf(tokens, key) === "1";
  const read = (key: string) => Number(optionOf(tokens, key) ?? "0");
  const index = Number(tokens[1]);

  if (!Number.isFinite(index)) {
    throw new AgentRejectedError(`loop layer line missing index: ${line}`);
  }

  return {
    index,
    playing: isSet("playing"),
    recording: isSet("recording"),
    waiting: isSet("waiting"),
    muted: isSet("muted"),
    truncated: isSet("truncated"),
    chainCurrent: isSet("chain"),
    level: read("level"),
    seconds: read("seconds"),
    position: read("pos"),
    countdown: read("countdown"),
    max: read("max"),
  };
}

@Injectable()
export class ControlClient implements OnModuleDestroy {
  private readonly logger = new Logger(ControlClient.name);
  private readonly host: string;
  private readonly port: number;

  private socket: Socket | undefined;
  private buffer = "";
  private queue: PendingCommand[] = [];
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor() {
    this.host = process.env.MYASS_AGENT_HOST ?? DEFAULT_HOST;
    this.port = Number(process.env.MYASS_AGENT_PORT ?? DEFAULT_PORT);
    this.open();
  }

  onModuleDestroy(): void {
    this.disposed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.socket?.destroy();
    this.failAll(new Error("control client disposed"));
  }

  async setChain(slots: EffectSlot[]): Promise<EffectSlot[]> {
    // RESET first so a chain rejected part way through is cleared by the next
    // attempt rather than lingering in the agent's staging area.
    const [reset] = await this.command("CHAIN RESET");

    if (reset !== "ok staging=0") {
      throw new AgentRejectedError(`agent refused chain reset: ${reset}`);
    }

    for (const [index, slot] of slots.entries()) {
      const [reply] = await this.command(encodeSlot(index, slot));

      if (!reply.startsWith("ok ")) {
        throw new AgentRejectedError(`agent refused slot ${index}: ${reply}`);
      }
    }

    const [commit] = await this.command("CHAIN COMMIT");

    if (!commit.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused chain commit: ${commit}`);
    }

    return slots;
  }

  async getChain(): Promise<Chain> {
    const lines = await this.command("CHAIN GET", "multi");
    const header = lines[0];

    if (!header.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused chain read: ${header}`);
    }

    return { slots: lines.slice(1, -1).map(decodeSlot) };
  }

  async getLooper(): Promise<LooperState> {
    const lines = await this.command("LOOP state", "multi");
    const header = lines[0];

    if (!header.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused loop state: ${header}`);
    }

    // max=, countdown= and transport= come off the header. The layer count is
    // taken from the array rather than trusted from the wire, so a truncated
    // reply cannot invent layers.
    const headerTokens = header.split(/\s+/);
    const maxSeconds = Number(optionOf(headerTokens, "max"));
    const countdownSeconds = Number(optionOf(headerTokens, "countdown"));
    const transportSeconds = Number(optionOf(headerTokens, "transport"));
    // Defaults to false so an older agent that never sends paused= still
    // parses; the UI simply never reports a freeze until the firmware catches
    // up with the LOOP state header.
    const paused = optionOf(headerTokens, "paused") === "1";

    if (
      !Number.isFinite(maxSeconds) ||
      !Number.isFinite(countdownSeconds) ||
      !Number.isFinite(transportSeconds)
    ) {
      throw new AgentRejectedError(`loop state header incomplete: ${header}`);
    }

    return {
      maxSeconds,
      countdownSeconds,
      transportSeconds,
      paused,
      layers: lines.slice(1, -1).map(decodeLoopLayer),
    };
  }

  /**
   * Every looper verb in one method, because the agent takes the layer and the
   * value as bare positional arguments after the verb, and max as a key=value
   * option. The agent owns whether an index is in range, so an ok prefix is all
   * that is checked here.
   */
  async sendLoop(action: LooperAction): Promise<void> {
    const parts = ["LOOP", action.action];

    if (action.layer !== undefined) {
      parts.push(String(action.layer));
    }

    if (action.value !== undefined) {
      parts.push(action.value.toFixed(4));
    }

    if (action.max !== undefined) {
      parts.push(`max=${action.max.toFixed(4)}`);
    }

    const command = parts.join(" ");
    const [reply] = await this.command(command);

    if (!reply.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused ${command}: ${reply}`);
    }
  }

  private command(line: string, mode: CommandMode = "single"): Promise<string[]> {
    const socket = this.socket;

    if (!socket || socket.destroyed || !socket.writable) {
      return Promise.reject(
        new AgentUnavailableError(`no agent at ${this.host}:${this.port}`),
      );
    }

    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((entry) => entry.timer !== timer);
        reject(new Error(`agent command timed out: ${line}`));
      }, COMMAND_TIMEOUT_MS);

      this.queue.push({ mode, lines: [], resolve, reject, timer });

      socket.write(`${line}\n`, (error) => {
        if (error) {
          this.settle(error);
        }
      });
    });
  }

  private settle(reply: string | Error): void {
    const entry = this.queue[0];

    if (!entry) {
      return;
    }

    if (reply instanceof Error) {
      this.queue.shift();
      clearTimeout(entry.timer);
      entry.reject(reply);
      return;
    }

    if (entry.mode === "single") {
      this.queue.shift();
      clearTimeout(entry.timer);
      entry.resolve([reply]);
      return;
    }

    entry.lines.push(reply);

    if (reply === MULTI_TERMINATOR) {
      this.queue.shift();
      clearTimeout(entry.timer);
      entry.resolve(entry.lines);
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }

    this.queue = [];
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");

    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);

      if (line) {
        this.settle(line);
      }

      newline = this.buffer.indexOf("\n");
    }
  }

  private open(): void {
    if (this.disposed) {
      return;
    }

    const socket = connect({ host: this.host, port: this.port });
    this.socket = socket;

    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.once("connect", () => {
      this.backoff = BACKOFF_MIN_MS;
      this.logger.log(`connected to agent at ${this.host}:${this.port}`);
      // An idle control connection is normal; only the handshake is bounded.
      socket.setTimeout(0);
    });

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("timeout", () => socket.destroy());
    socket.on("error", (error) => {
      this.logger.debug(`agent socket error: ${error.message}`);
    });
    socket.on("close", () => this.onClose());
  }

  private onClose(): void {
    this.socket = undefined;
    this.buffer = "";
    this.failAll(
      new AgentUnavailableError(
        `agent at ${this.host}:${this.port} disconnected`,
      ),
    );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }

    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);

    this.logger.warn(`reconnecting to agent in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }
}
