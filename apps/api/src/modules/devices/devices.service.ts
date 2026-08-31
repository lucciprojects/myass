import { Injectable } from "@nestjs/common";

@Injectable()
export class DevicesService {
  private readonly devices = [
    {
      id: "sim-001",
      name: "MYASS Simulator",
      status: "online" as const,
      firmwareVersion: "simulator-0.1.0",
    },
  ];

  list() {
    return this.devices;
  }

  get(id: string) {
    return this.devices.find((device) => device.id === id) ?? null;
  }
}
