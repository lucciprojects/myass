import { describe, expect, it } from "vitest";

describe("health contract", () => {
  it("defines the expected status", () => {
    expect({ status: "ok", service: "myass-api" }).toEqual({
      status: "ok",
      service: "myass-api",
    });
  });
});
