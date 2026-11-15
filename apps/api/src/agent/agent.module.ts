import { Module } from "@nestjs/common";
import { ControlClient } from "./control.client.js";

// One control socket for the whole API. Both the device endpoints and the
// project store talk to the same agent, so the client is a shared provider
// rather than a per-module instance.
@Module({
  providers: [ControlClient],
  exports: [ControlClient],
})
export class AgentModule {}
