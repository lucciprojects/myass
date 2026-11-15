import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { connect, type Socket } from "node:net";
import type {
  Chain,
  ClickMode,
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

// One base64 line carries this many floats. The agent enforces the same
// ceiling, so a mismatch fails loudly rather than as a truncated line.
const TRANSFER_CHUNK_SAMPLES = 8192;

type CommandMode = "single" | "multi";

/** One layer of a project being restored into the agent. */
export interface ProjectLayerPayload {
  index: number;
  /** Interleaved mono samples; length must equal `loopSamples` when non-empty. */
  samples: Float32Array;
  /** Percent, as the manifest and the UI both store it. */
  level: number;
  muted: boolean;
  playing: boolean;
  truncated: boolean;
  chain: EffectSlot[];
}

/** A whole project as the agent's staged-load protocol expects it. */
export interface ProjectPayload {
  bpm: number;
  beatsPerBar: number;
  bars: number;
  click: ClickMode;
  loopSamples: number;
  layers: ProjectLayerPayload[];
  /** Omit to leave the live board untouched. */
  board?: EffectSlot[];
}

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
  return slotLine("SLOT", index, slot);
}

function slotLine(prefix: string, index: number, slot: EffectSlot): string {
  const parts = [
    `${prefix} ${index}`,
    `kind=${slot.kind}`,
    `enabled=${slot.enabled ? 1 : 0}`,
  ];

  for (const [key, value] of Object.entries(slot.params)) {
    parts.push(`${key}=${value.toFixed(4)}`);
  }

  return parts.join(" ");
}

// PCM is little-endian float32 on the wire, base64 encoded so the line
// protocol never has to look at a raw zero byte. Both helpers are explicit
// about byte order rather than trusting the host, because the agent may end
// up on an ARM board.
function encodePcm(samples: Float32Array): string {
  const bytes = Buffer.allocUnsafe(samples.length * 4);

  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeFloatLE(samples[index], index * 4);
  }

  return bytes.toString("base64");
}

function decodePcm(text: string): Float32Array {
  const bytes = Buffer.from(text, "base64");

  if (bytes.length % 4 !== 0) {
    throw new AgentRejectedError("agent sent a partial float in a PCM chunk");
  }

  const samples = new Float32Array(bytes.length / 4);

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readFloatLE(index * 4);
  }

  return samples;
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
    samples: read("samples"),
    position: read("pos"),
    countdown: read("countdown"),
    max: read("max"),
    revision: read("rev"),
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
    const readHeaderNumber = (key: string, fallback: number) => {
      const raw = optionOf(headerTokens, key);

      if (raw === undefined) {
        return fallback;
      }

      const value = Number(raw);
      return Number.isFinite(value) ? value : fallback;
    };
    // Defaults keep the decoder working against an agent that predates the
    // tempo work: 120 BPM, 4/4, FREE, no click, no revision.
    const sampleRate = readHeaderNumber("rate", 48000);
    const bpm = readHeaderNumber("bpm", 120);
    const beatsPerBar = readHeaderNumber("beats", 4);
    const bars = readHeaderNumber("bars", 0);
    const loopSamples = readHeaderNumber("loop", 0);
    const revision = readHeaderNumber("rev", 0);
    const clickRaw = optionOf(headerTokens, "click");
    const click =
      clickRaw === "off" || clickRaw === "countin" ||
      clickRaw === "countin-record"
        ? clickRaw
        : "countin-record";
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
      sampleRate,
      bpm,
      beatsPerBar,
      bars,
      click,
      loopSamples,
      revision,
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

    // The transport settings are bare positional words on the wire, unlike
    // level's value (0-100) and record's max= option. Keeping them out of that
    // shared path avoids sending a 120 BPM tempo through a percentage field.
    if (action.action === "tempo") {
      parts.push((action.bpm ?? 120).toFixed(4));

      if (action.beats !== undefined) {
        parts.push(`beats=${String(action.beats)}`);
      }
    } else if (action.action === "bars") {
      parts.push(String(action.bars ?? 0));
    } else if (action.action === "click") {
      parts.push(action.click ?? "countin-record");
    } else {
      if (action.value !== undefined) {
        parts.push(action.value.toFixed(4));
      }

      if (action.max !== undefined) {
        parts.push(`max=${action.max.toFixed(4)}`);
      }
    }

    const command = parts.join(" ");
    const [reply] = await this.command(command);

    if (!reply.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused ${command}: ${reply}`);
    }
  }

  /**
   * Reads one layer back as PCM. The first dump asks for zero samples just to
   * learn the total, then each chunk is fetched separately so every command
   * stays inside the per-command timeout.
   */
  async dumpLayer(layer: number): Promise<Float32Array> {
    const [head] = await this.command(`LOOP dump ${layer} 0 0`);

    if (head === "error busy") {
      throw new AgentRejectedError(`layer ${layer} is still recording`);
    }

    if (!head.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused layer dump: ${head}`);
    }

    const total = Math.trunc(Number(optionOf(head.split(/\s+/), "total")));

    if (!Number.isFinite(total) || total < 0) {
      throw new AgentRejectedError(`layer dump missing total: ${head}`);
    }

    const result = new Float32Array(total);
    let offset = 0;

    while (offset < total) {
      const count = Math.min(TRANSFER_CHUNK_SAMPLES, total - offset);
      const [reply] = await this.command(
        `LOOP dump ${layer} ${offset} ${count}`,
      );

      if (!reply.startsWith("ok ")) {
        throw new AgentRejectedError(
          `agent refused dump at ${offset}: ${reply}`,
        );
      }

      const tokens = reply.split(/\s+/);
      const chunkOffset = Number(optionOf(tokens, "offset"));
      const chunk = decodePcm(optionOf(tokens, "data") ?? "");

      if (chunkOffset !== offset) {
        throw new AgentRejectedError(
          `agent dumped offset ${chunkOffset}, expected ${offset}`,
        );
      }

      if (chunk.length === 0) {
        break;
      }

      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  /**
   * Restores a whole project. The agent stages every layer and chain first, so
   * this either replaces the session in one commit or leaves it exactly as it
   * was. Any failure aborts the staged session before rethrowing.
   */
  async loadProject(project: ProjectPayload): Promise<void> {
    const [begin] = await this.command("PROJECT LOAD BEGIN");

    if (!begin.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused load begin: ${begin}`);
    }

    try {
      for (const layer of project.layers) {
        if (layer.samples.length === 0) {
          continue;
        }

        if (layer.samples.length !== project.loopSamples) {
          throw new AgentRejectedError(
            `layer ${layer.index} is ${layer.samples.length} samples, ` +
              `but the project loop is ${project.loopSamples}`,
          );
        }

        const [started] = await this.command(
          `PROJECT LOAD LAYER ${layer.index} BEGIN ${layer.samples.length}`,
        );

        if (!started.startsWith("ok ")) {
          throw new AgentRejectedError(
            `agent refused layer ${layer.index}: ${started}`,
          );
        }

        for (
          let offset = 0;
          offset < layer.samples.length;
          offset += TRANSFER_CHUNK_SAMPLES
        ) {
          const chunk = layer.samples.subarray(
            offset,
            offset + TRANSFER_CHUNK_SAMPLES,
          );
          const [reply] = await this.command(
            `PROJECT LOAD LAYER ${layer.index} DATA ${offset} ${encodePcm(chunk)}`,
          );

          if (!reply.startsWith("ok ")) {
            throw new AgentRejectedError(
              `agent refused layer ${layer.index} at ${offset}: ${reply}`,
            );
          }
        }

        const [meta] = await this.command(
          `PROJECT LOAD LAYER ${layer.index} META ` +
            `level=${layer.level.toFixed(4)} ` +
            `muted=${layer.muted ? 1 : 0} ` +
            `playing=${layer.playing ? 1 : 0} ` +
            `truncated=${layer.truncated ? 1 : 0}`,
        );

        if (!meta.startsWith("ok ")) {
          throw new AgentRejectedError(
            `agent refused layer ${layer.index} meta: ${meta}`,
          );
        }

        if (layer.chain.length > 0) {
          await this.stageSlots("PROJECT CHAIN", layer.chain);

          const [chain] = await this.command(
            `PROJECT CHAIN COMMIT ${layer.index}`,
          );

          if (!chain.startsWith("ok ")) {
            throw new AgentRejectedError(
              `agent refused layer ${layer.index} chain: ${chain}`,
            );
          }
        }
      }

      if (project.board) {
        await this.stageSlots("PROJECT BOARD", project.board);

        const [board] = await this.command("PROJECT BOARD COMMIT");

        if (!board.startsWith("ok ")) {
          throw new AgentRejectedError(
            `agent refused project board: ${board}`,
          );
        }
      }

      const [commit] = await this.command(
        `PROJECT LOAD COMMIT ` +
          `bpm=${project.bpm.toFixed(4)} ` +
          `beats=${project.beatsPerBar} ` +
          `bars=${project.bars} ` +
          `click=${project.click} ` +
          `loop=${project.loopSamples}`,
      );

      if (!commit.startsWith("ok ")) {
        throw new AgentRejectedError(`agent refused project commit: ${commit}`);
      }
    } catch (error) {
      // A malformed line aborts the agent's session by itself, but a timeout
      // or a locally rejected layer leaves it open. Aborting again is
      // harmless when it is already closed.
      await this.command("PROJECT LOAD ABORT").catch(() => undefined);
      throw error;
    }
  }

  async getLayerChain(layer: number): Promise<EffectSlot[]> {
    const lines = await this.command(`CHAIN GET layer=${layer}`, "multi");
    const header = lines[0];

    if (!header.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused layer chain read: ${header}`);
    }

    return lines.slice(1, -1).map(decodeSlot);
  }

  async setLayerChain(layer: number, slots: EffectSlot[]): Promise<void> {
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

    const [commit] = await this.command(`CHAIN COMMIT layer=${layer}`);

    if (!commit.startsWith("ok ")) {
      throw new AgentRejectedError(
        `agent refused layer chain commit: ${commit}`,
      );
    }
  }

  /**
   * Runs PCM through a private copy of a chain, never the live board. Used by
   * the export path to print processed stems without disturbing the session.
   */
  async renderChain(
    slots: EffectSlot[],
    pcm: Float32Array,
  ): Promise<Float32Array> {
    const [begin] = await this.command("RENDER BEGIN");

    if (!begin.startsWith("ok ")) {
      throw new AgentRejectedError(`agent refused render begin: ${begin}`);
    }

    try {
      await this.stageSlots("RENDER", slots);

      const [commit] = await this.command("RENDER COMMIT");

      if (!commit.startsWith("ok ")) {
        throw new AgentRejectedError(`agent refused render commit: ${commit}`);
      }

      const result = new Float32Array(pcm.length);

      for (
        let offset = 0;
        offset < pcm.length;
        offset += TRANSFER_CHUNK_SAMPLES
      ) {
        const chunk = pcm.subarray(offset, offset + TRANSFER_CHUNK_SAMPLES);
        const [reply] = await this.command(`RENDER DATA ${encodePcm(chunk)}`);

        if (!reply.startsWith("ok ")) {
          throw new AgentRejectedError(
            `agent refused render at ${offset}: ${reply}`,
          );
        }

        const rendered = decodePcm(optionOf(reply.split(/\s+/), "data") ?? "");

        if (rendered.length !== chunk.length) {
          throw new AgentRejectedError(
            `render chunk at ${offset} is ${rendered.length} samples, ` +
              `expected ${chunk.length}`,
          );
        }

        result.set(rendered, offset);
      }

      return result;
    } finally {
      await this.command("RENDER END").catch(() => undefined);
    }
  }

  private async stageSlots(
    prefix: "PROJECT CHAIN" | "PROJECT BOARD" | "RENDER",
    slots: EffectSlot[],
  ): Promise<void> {
    const [reset] = await this.command(`${prefix} RESET`);

    if (reset !== "ok staging=0") {
      throw new AgentRejectedError(`agent refused ${prefix} reset: ${reset}`);
    }

    for (const [index, slot] of slots.entries()) {
      const [reply] = await this.command(slotLine(prefix, index, slot));

      if (!reply.startsWith("ok ")) {
        throw new AgentRejectedError(
          `agent refused ${prefix} slot ${index}: ${reply}`,
        );
      }
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
