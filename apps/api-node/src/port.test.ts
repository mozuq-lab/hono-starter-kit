import { describe, expect, it } from "vitest";
import { parseHost, parsePort } from "./port.js";

describe("parseHost", () => {
  it("uses loopback by default and accepts explicit bind hosts", () => {
    expect(parseHost(undefined)).toBe("127.0.0.1");
    expect(parseHost("127.0.0.1")).toBe("127.0.0.1");
    expect(parseHost("0.0.0.0")).toBe("0.0.0.0");
  });

  it.each(["", "localhost", "::", "127.0.0.1 "])(
    "rejects unsupported host %j",
    (rawHost) => {
      expect(() => parseHost(rawHost)).toThrowError(
        /^HOST must be 127\.0\.0\.1 or 0\.0\.0\.0$/,
      );
    },
  );
});

describe("parsePort", () => {
  it("uses 3000 by default and accepts decimal ports in range", () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  it.each(["0", "65536", "1.5", "3000junk", "1e2"])(
    "rejects invalid port %j",
    (rawPort) => {
      expect(() => parsePort(rawPort)).toThrowError(/^PORT must be 1-65535$/);
    },
  );
});
