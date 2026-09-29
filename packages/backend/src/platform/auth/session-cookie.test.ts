import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../app/app-env.js";
import {
  clearSessionCookie,
  setSessionCookie,
  type SessionCookieConfig,
} from "./session-cookie.js";

const productionCookie: SessionCookieConfig = {
  name: "__Host-session",
  secure: true,
  maxAgeSeconds: 604_800,
};

const developmentCookie: SessionCookieConfig = {
  name: "session",
  secure: false,
  maxAgeSeconds: 604_800,
};

const responseCookie = async (
  config: SessionCookieConfig,
  operation: "set" | "clear",
) => {
  const app = new Hono<AppEnv>().get("/cookie", (context) => {
    if (operation === "set") {
      setSessionCookie(context, config, "raw_session");
    } else {
      clearSessionCookie(context, config);
    }
    return context.body(null, 204);
  });

  const response = await app.request("/cookie");
  const cookie = response.headers.get("set-cookie");
  expect(cookie).not.toBeNull();
  return cookie!;
};

describe("session cookies", () => {
  it("sets the production cookie with host-prefix security attributes", async () => {
    const cookie = await responseCookie(productionCookie, "set");

    expect(cookie).toContain("__Host-session=raw_session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).not.toContain("Domain=");
  });

  it("sets a plain-HTTP development cookie without Secure", async () => {
    const cookie = await responseCookie(developmentCookie, "set");

    expect(cookie).toContain("session=raw_session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).not.toContain("Domain=");
  });

  it.each([
    ["production", productionCookie, "__Host-session=", true],
    ["development", developmentCookie, "session=", false],
  ] as const)(
    "clears the %s cookie with matching attributes",
    async (_name, config, cookiePrefix, secure) => {
      const cookie = await responseCookie(config, "clear");

      expect(cookie).toContain(cookiePrefix);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=0");
      expect(cookie.includes("Secure")).toBe(secure);
      expect(cookie).not.toContain("Domain=");
    },
  );
});
