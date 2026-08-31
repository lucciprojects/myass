import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import {
  DeviceCommand,
  ParameterChangedEvent,
  EffectBypassChangedEvent,
  PresetLoadedEvent,
  DeviceTelemetryEvent,
} from "@myass/protocol";

const port = Number(process.env.SIMULATOR_PORT ?? 3002);
const deviceId = "sim-001";

const state = {
  effects: {
    "distortion-1": {
      enabled: true,
      parameters: {
        drive: 0.5,
        tone: 0.5,
        level: 0.8,
      },
    },
  },
};

const server = new WebSocketServer({ port });

server.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "device.telemetry",
      deviceId,
      cpuPercent: 8.2,
      temperatureC: 42.1,
      sampleRate: 48_000,
      bufferSize: 128,
    } satisfies DeviceTelemetryEvent),
  );

  socket.on("message", (raw) => {
    const parsed = DeviceCommand.safeParse(JSON.parse(raw.toString()));

    if (!parsed.success) {
      socket.send(JSON.stringify({
        type: "error",
        message: "Invalid MYASS device command",
      }));
      return;
    }

    const command = parsed.data;

    if (command.type === "effect.set_parameter") {
      const effect = state.effects[command.effectId as keyof typeof state.effects];

      if (effect) {
        effect.parameters[command.parameter as keyof typeof effect.parameters] = command.value;
      }

      const event: ParameterChangedEvent = {
        type: "effect.parameter_changed",
        requestId: command.requestId,
        effectId: command.effectId,
        parameter: command.parameter,
        value: command.value,
      };

      socket.send(JSON.stringify(event));
      return;
    }

    if (command.type === "effect.set_bypass") {
      const effect = state.effects[command.effectId as keyof typeof state.effects];

      if (effect) effect.enabled = !command.bypassed;

      const event: EffectBypassChangedEvent = {
        type: "effect.bypass_changed",
        requestId: command.requestId,
        effectId: command.effectId,
        bypassed: command.bypassed,
      };

      socket.send(JSON.stringify(event));
      return;
    }

    if (command.type === "preset.load") {
      const event: PresetLoadedEvent = {
        type: "preset.loaded",
        requestId: command.requestId || randomUUID(),
        presetId: command.presetId,
      };

      socket.send(JSON.stringify(event));
    }
  });
});

console.log(`MYASS simulator listening on ws://localhost:${port}`);
