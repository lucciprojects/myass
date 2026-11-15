import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OutputSink, OutputState } from "@myass/protocol";

const execFileAsync = promisify(execFile);

// The rig's playback stream is a PipeWire ALSA node; where it is heard is
// purely a routing decision. Each destination is an Audio/Sink node — the
// amp's USB codec, the built-in speakers, any connected Bluetooth headset —
// discovered from the running graph, so this file never hardcodes a device.
// The agent's stream is named after its session (alsa_playback.myass-agent)
// and exposes one output port per channel; every sink exposes a
// playback_FL/playback_FR pair to link those into.
const AGENT_OUTPUT = "alsa_playback.myass-agent:output_";

async function run(tool: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(tool, args);
    return stdout;
  } catch (error) {
    throw new ServiceUnavailableException(
      `${tool} ${args.join(" ")}: ${
        error instanceof Error ? error.message : "command failed"
      }`,
    );
  }
}

interface WireObject {
  id: number;
  type?: string;
  info?: { props?: Record<string, unknown> };
}

@Injectable()
export class OutputService {
  /**
   * Every Audio/Sink node in the graph right now, i.e. everywhere the rig
   * could go. Display names come from node.description so a Bluetooth headset
   * shows up as its own name.
   */
  private async listSinks(): Promise<OutputSink[]> {
    const objects: WireObject[] = JSON.parse(await run("pw-dump", []));
    const sinks = objects.filter(
      (object) =>
        object.type === "PipeWire:Interface:Node" &&
        object.info?.props?.["media.class"] === "Audio/Sink",
    );

    return sinks
      .map((sink) => {
        const props = sink.info?.props ?? {};
        const node = String(props["node.name"] ?? "");
        const description = String(
          props["node.description"] ?? props["node.name"] ?? "",
        );
        return { node, description };
      })
      .filter((sink) => sink.node !== "");
  }

  /**
   * Which of the given sinks the agent's stream is linked into, by reading the
   * block of pw-link -l output around the stream's output_FL entry. The sink
   * name sits on a neighbouring line of that block; the capture links always
   * mention the codec, so the whole listing must never be grepped directly.
   */
  private async currentSink(
    sinks: OutputSink[],
  ): Promise<OutputSink | null> {
    const links = await run("pw-link", ["-l"]);
    const lines = links.split("\n");
    const index = lines.findIndex((line) =>
      line.includes(`${AGENT_OUTPUT}FL`),
    );

    if (index < 0) {
      return null;
    }

    const block = [
      lines[index - 1],
      lines[index],
      lines[index + 1],
      lines[index + 2],
    ].join("\n");

    return sinks.find((sink) => block.includes(sink.node)) ?? null;
  }

  async getState(): Promise<OutputState> {
    const sinks = await this.listSinks();

    if (sinks.length === 0) {
      throw new ServiceUnavailableException(
        "no audio sinks found: is PipeWire running?",
      );
    }

    const sink = (await this.currentSink(sinks)) ?? sinks[0];
    return { sink, sinks };
  }

  /**
   * Move the rig to a sink without touching the agent: relink the running
   * stream, then make the target the PipeWire default so a future agent
   * restart comes up on the same sink, and unmute + raise the target so the
   * swap is actually heard (the built-in speakers start muted, and freshly
   * connected headphones often come in quiet).
   */
  async routeTo(node: string): Promise<OutputState> {
    const sinks = await this.listSinks();
    const target = sinks.find((sink) => sink.node === node);

    if (!target) {
      throw new ServiceUnavailableException(
        `unknown output sink: ${node}`,
      );
    }

    const from = await this.currentSink(sinks);

    if (from && from.node !== target.node) {
      // Disconnect exactly the links we have — the two-argument form removes
      // a single link, so this cannot error on an already-empty port — then
      // link into the target sink.
      await run("pw-link", ["-d", `${AGENT_OUTPUT}FL`, `${from.node}:playback_FL`]);
      await run("pw-link", ["-d", `${AGENT_OUTPUT}FR`, `${from.node}:playback_FR`]);
      await run("pw-link", [`${AGENT_OUTPUT}FL`, `${target.node}:playback_FL`]);
      await run("pw-link", [`${AGENT_OUTPUT}FR`, `${target.node}:playback_FR`]);
    }

    // wpctl takes numeric node ids, which change every boot or reconnect;
    // resolve them from the stable node name so this file does not rot.
    const id = await this.nodeId(target.node);
    await run("wpctl", ["set-default", id]);
    await run("wpctl", ["set-mute", id, "0"]);
    await run("wpctl", ["set-volume", id, "0.9"]);

    return this.getState();
  }

  private async nodeId(nodeName: string): Promise<string> {
    const dump = await run("pw-dump", []);
    const objects: WireObject[] = JSON.parse(dump);
    const node = objects.find(
      (object) =>
        object.type === "PipeWire:Interface:Node" &&
        object.info?.props?.["node.name"] === nodeName,
    );

    if (!node) {
      throw new ServiceUnavailableException(
        `PipeWire node not found: ${nodeName}`,
      );
    }

    return String(node.id);
  }
}