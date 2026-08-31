import { Controller, Get, Param } from "@nestjs/common";
import { DevicesService } from "./devices.service.js";

@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list() {
    return this.devices.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.devices.get(id);
  }
}
