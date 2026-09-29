import { describe, expect, it } from "vitest";
import { authUrls, createAuthClient } from "./auth.js";
import { ApiError, UnexpectedApiResponseError } from "./errors.js";

describe("authUrls", () => {
  it("owns the full-page authentication endpoints", () => {
    expect(authUrls.login()).toBe("/auth/login");
    expect(authUrls.providerLogout()).toBe("/auth/provider-logout");
  });

  it("encodes the returnTo target", () => {
    expect(authUrls.login("/projects?tab=a&b=c")).toBe(
      "/auth/login?returnTo=%2Fprojects%3Ftab%3Da%26b%3Dc",
    );
  });
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("createAuthClient", () => {
  it("returns a runtime-validated current user", async () => {
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            user: {
              id: "user_123",
              displayName: "Local Developer",
              roles: ["projects:read"],
            },
          }),
        ),
    });

    await expect(client.getMe()).resolves.toEqual({
      user: {
        id: "user_123",
        displayName: "Local Developer",
        roles: ["projects:read"],
      },
    });
  });

  it("gets the current user through the typed route with same-origin credentials", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: (input, init) => {
        seenUrl = input instanceof Request ? input.url : String(input);
        seenInit = init;
        return Promise.resolve(
          jsonResponse({
            user: { id: "user_123", displayName: "Dev", roles: [] },
          }),
        );
      },
    });

    await client.getMe();

    expect(new URL(seenUrl ?? "").pathname).toBe("/api/me");
    expect(seenInit).toMatchObject({ credentials: "same-origin" });
  });

  it("posts logout with same-origin credentials", async () => {
    const calls: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: (input, init) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });

    await client.logout();

    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error("expected a logout request");
    const requestUrl =
      call.input instanceof URL
        ? call.input
        : typeof call.input === "string"
          ? new URL(call.input)
          : new URL(call.input.url);
    expect(requestUrl.pathname).toBe("/auth/logout");
    expect(call.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
    });
  });

  it("normalizes a current-user 401 Problem to ApiError", async () => {
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            {
              type: "about:blank",
              title: "Unauthorized",
              status: 401,
              code: "UNAUTHORIZED",
              requestId: "request_auth_401",
            },
            401,
          ),
        ),
    });

    await expect(client.getMe()).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a malformed logout error response with its status", async () => {
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: () =>
        Promise.resolve(jsonResponse({ error: "Unauthorized" }, 401)),
    });

    await expect(client.logout()).rejects.toMatchObject({
      name: "UnexpectedApiResponseError",
      status: 401,
    });
  });

  it("rejects an invalid successful current-user response", async () => {
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: () =>
        Promise.resolve(jsonResponse({ user: { id: 1, roles: [] } })),
    });

    await expect(client.getMe()).rejects.toBeInstanceOf(
      UnexpectedApiResponseError,
    );
  });

  it("rejects a successful logout response whose status is not 204", async () => {
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: () => Promise.resolve(jsonResponse({})),
    });

    await expect(client.logout()).rejects.toBeInstanceOf(
      UnexpectedApiResponseError,
    );
  });

  it("normalizes a logout 401 Problem to ApiError", async () => {
    const client = createAuthClient({
      baseUrl: "http://starter.test",
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            {
              type: "about:blank",
              title: "Unauthorized",
              status: 401,
              code: "UNAUTHORIZED",
              requestId: "request_logout_401",
            },
            401,
          ),
        ),
    });

    await expect(client.logout()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "UNAUTHORIZED",
      requestId: "request_logout_401",
    });
  });
});
