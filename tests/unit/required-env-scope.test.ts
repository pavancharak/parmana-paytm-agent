import { describe, expect, it } from "vitest";
import { requiredEnvCheckApplies } from "../../scripts/required-env-scope.js";

describe("requiredEnvCheckApplies", () => {
  it("checks production builds and local runs", () => {
    expect(requiredEnvCheckApplies("production")).toBe(true);
    expect(requiredEnvCheckApplies(undefined)).toBe(true);
    expect(requiredEnvCheckApplies("")).toBe(true);
  });

  it("skips preview and development builds, whose settings exist only for production", () => {
    expect(requiredEnvCheckApplies("preview")).toBe(false);
    expect(requiredEnvCheckApplies("development")).toBe(false);
  });
});
