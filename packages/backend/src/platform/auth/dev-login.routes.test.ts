import { describe, expect, it } from "vitest";
import { createDevLoginRoutes } from "./dev-login.routes.js";

describe("Dev login routes", () => {
  it("redirects provider logout to the fixed local login route without caching", async () => {
    const routes = createDevLoginRoutes({
      establishSession: () => Promise.reject(new Error("not used")),
      sessionCookie: {
        name: "session",
        secure: false,
        maxAgeSeconds: 600,
      },
    });

    const response = await routes.request("/provider-logout");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
