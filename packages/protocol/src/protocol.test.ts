import { describe, expect, it } from "vitest";
import { DeviceCommand } from "./index";

describe("MYASS device protocol", () => {
  it("accepts a parameter command", () => {
    const result = DeviceCommand.safeParse({
      type: "effect.set_parameter",
      requestId: "test-1",
      effectId: "distortion-1",
      parameter: "drive",
      value: 0.72,
    });

    expect(result.success).toBe(true);
  });
});
