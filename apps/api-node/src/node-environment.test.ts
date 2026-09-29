import { describe, expect, it } from "vitest";
import { resolveNodeEnvironment } from "./node-environment.js";

describe("resolveNodeEnvironment", () => {
  it.each(["development", "production", "test"])(
    "accepts and trims %s",
    (nodeEnv) => {
      expect(resolveNodeEnvironment(` ${nodeEnv} `)).toBe(nodeEnv);
    },
  );

  it("defaults an unset value to development", () => {
    expect(resolveNodeEnvironment(undefined)).toBe("development");
  });

  it.each(["staging", "prod", "Development", "", " "])(
    "rejects the unknown environment %s",
    (nodeEnv) => {
      expect(() => resolveNodeEnvironment(nodeEnv)).toThrow(
        "NODE_ENV must be development, production, or test",
      );
    },
  );
});
