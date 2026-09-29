import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { RedactedSecret } from "./redacted-secret.js";

const canary = "client-secret-canary~.+:";

describe("RedactedSecret", () => {
  it("returns the raw value only through reveal", () => {
    expect(new RedactedSecret(canary).reveal()).toBe(canary);
  });

  it.each([
    ["JSON.stringify", (secret: RedactedSecret) => JSON.stringify({ secret })],
    ["String", (secret: RedactedSecret) => String(secret)],
    ["util.inspect", (secret: RedactedSecret) => inspect({ secret })],
    [
      "util.inspect with hidden fields",
      (secret: RedactedSecret) =>
        inspect({ secret }, { showHidden: true, depth: Infinity }),
    ],
    [
      "Object.entries",
      (secret: RedactedSecret) => inspect(Object.entries(secret)),
    ],
    [
      "structuredClone",
      (secret: RedactedSecret) => inspect(structuredClone(secret)),
    ],
  ])("does not expose the value through %s", (_name, render) => {
    const rendered = render(new RedactedSecret(canary));

    expect(rendered).not.toContain("canary");
    expect(rendered).not.toContain(canary);
  });
});
