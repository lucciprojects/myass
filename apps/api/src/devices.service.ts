import { Injectable } from "@nestjs/common";
import type { Chain, LooperAction, LooperState, Waveform } from "@myass/protocol";
import { ControlClient } from "./agent/control.client.js";

@Injectable()
export class DevicesService {
  constructor(private readonly control: ControlClient) {}

  getValues() {
    // The agent still needs a telemetry push path for real levels.
    return {
      input: 0,
      output: 0,
    };
  }

  async getChain(): Promise<Chain> {
    return this.control.getChain();
  }

  async setChain(chain: Chain): Promise<Chain> {
    return { slots: await this.control.setChain(chain.slots) };
  }

  async getLooper(): Promise<LooperState> {
    return this.control.getLooper();
  }

  /**
   * State read back after the change rather than before it, so the UI renders
   * the layer as the agent now has it instead of guessing from what it asked
   * for. The looper owns the playhead, so a pre-action read would be stale by
   * the time it arrived.
   */
  async sendLoop(action: LooperAction): Promise<LooperState> {
    await this.control.sendLoop(action);
    return this.control.getLooper();
  }

  // No waveform here on purpose. Rendering is a UI affordance, not a
  // measurement of the signal, so it is computed in the browser rather than
  // putting the agent on the hook for a picture.
}
