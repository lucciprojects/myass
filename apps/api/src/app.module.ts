import { Module } from "@nestjs/common";
import { ControlClient } from "./agent/control.client.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesService } from "./devices.service.js";
import { OutputService } from "./output.service.js";

@Module({
  controllers: [DevicesController],
  providers: [ControlClient, DevicesService, OutputService],
})
export class AppModule {}
