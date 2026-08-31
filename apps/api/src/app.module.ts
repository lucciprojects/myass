import { Module } from "@nestjs/common";
import { HealthController } from "./modules/health/health.controller.js";
import { DevicesModule } from "./modules/devices/devices.module.js";
import { DeviceGateway } from "./websocket/device.gateway.js";

@Module({
  imports: [DevicesModule],
  controllers: [HealthController],
  providers: [DeviceGateway],
})
export class AppModule {}
