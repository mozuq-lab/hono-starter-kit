import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./loopback-host.js";

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "127.0.0.2",
    "127.1.1.1",
    "127.255.255.255",
    "[::1]",
  ])("accepts the loopback host %s", (hostname) => {
    expect(isLoopbackHost(hostname)).toBe(true);
  });

  it.each([
    "127.0.0.1.evil.com",
    "localhost.evil.com",
    "evil.com",
    "evil.com/127.0.0.1",
    "127.0.0.1.",
    "0127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "169.254.169.254",
    "[::2]",
    "[::ffff:127.0.0.1]",
    "::1",
    "127.0.0.1:8080",
    "",
  ])("rejects the non-loopback host %s", (hostname) => {
    expect(isLoopbackHost(hostname)).toBe(false);
  });

  it("matches the hostname a URL exposes for every loopback form", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
    ]) {
      expect(isLoopbackHost(new URL(origin).hostname)).toBe(true);
    }
    expect(isLoopbackHost(new URL("http://127.0.0.1.evil.com").hostname)).toBe(
      false,
    );
  });
});
