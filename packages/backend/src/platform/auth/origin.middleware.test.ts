import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../app/app-env.js";
import { requestIdMiddleware } from "../../app/request-id.js";
import { createOriginMiddleware } from "./origin.middleware.js";

const allowedOrigin = "http://127.0.0.1:5173";

const createProbe = () => {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware);
  app.use("*", createOriginMiddleware({ allowedOrigin }));
  return app
    .post("/probe", (context) => context.json({ continued: true }, 200))
    .get("/probe", (context) => context.json({ continued: true }, 200));
};

describe("createOriginMiddleware", () => {
  it("continues an unsafe request from the exact configured Origin", async () => {
    const response = await createProbe().request("/probe", {
      method: "POST",
      headers: { Origin: allowedOrigin },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ continued: true });
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not an origin"],
    ["different host spelling", "http://localhost:5173"],
    ["different port", "http://127.0.0.1:5174"],
  ])("rejects a %s Origin before the unsafe handler", async (_name, origin) => {
    const response = await createProbe().request("/probe", {
      method: "POST",
      ...(origin === undefined ? {} : { headers: { Origin: origin } }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
    });
  });

  it("continues a safe GET without an Origin", async () => {
    const response = await createProbe().request("/probe");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ continued: true });
  });
});
