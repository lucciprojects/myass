import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ChainSchema,
  DeviceValuesSchema,
  LooperActionSchema,
  LooperStateSchema,
  OutputRouteSchema,
  OutputStateSchema,
  validateChain,
  type Chain,
} from "@myass/protocol";
import { DevicesService } from "./devices.service.js";
import { OutputService } from "./output.service.js";

@Controller("devices")
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly output: OutputService,
  ) {}

  @Get("values")
  getValues() {
    return DeviceValuesSchema.parse(this.devices.getValues());
  }

  @Get("chain")
  async getChain() {
    const chain = await this.agent(() => this.devices.getChain());

    return ChainSchema.parse(chain);
  }

  @Put("chain")
  async setChain(@Body() body: unknown) {
    const parsed = ChainSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }

    const chain: Chain = parsed.data;
    const issues = validateChain(chain);

    if (issues.length > 0) {
      throw new BadRequestException({ issues });
    }

    return ChainSchema.parse(await this.agent(() => this.devices.setChain(chain)));
  }

  @Get("looper")
  async getLooper() {
    return LooperStateSchema.parse(
      await this.agent(() => this.devices.getLooper()),
    );
  }

  // POST rather than PUT: this moves a transport forward in time, so a replay
  // would be wrong, and the action names itself in the body.
  @Post("looper")
  async postLooper(@Body() body: unknown) {
    const parsed = LooperActionSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }

    return LooperStateSchema.parse(
      await this.agent(() => this.devices.sendLoop(parsed.data)),
    );
  }

  // The rig's output is a PipeWire route, not an agent control: both of these
  // move the running stream to whichever sink the user picked — the amp's USB
  // codec, the built-in speakers, or a connected Bluetooth headset — without
  // touching the agent, so loops keep playing through the swap.
  @Get("output")
  async getOutput() {
    return OutputStateSchema.parse(await this.output.getState());
  }

  @Post("output")
  async routeOutput(@Body() body: unknown) {
    const { node } = OutputRouteSchema.parse(body);
    return OutputStateSchema.parse(await this.output.routeTo(node));
  }

  private async agent<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : "Agent unavailable",
      );
    }
  }
}
