import { describe, expect, it } from "vitest";
import { effectDefinitions } from "./index";

describe("effect definitions", () => {
  it("contains distortion", () => {
    expect(effectDefinitions.some((e) => e.type === "distortion")).toBe(true);
  });
});
