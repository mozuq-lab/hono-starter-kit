import { once } from "node:events";
import { request } from "node:http";
import { serve } from "@hono/node-server";
import {
  createVerifiedIdentity,
  InMemoryAuthSessionStore,
  InMemoryExternalLoginTransactionStore,
  type ExternalIdentityProvider,
} from "@starter/backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthConfig } from "./auth-config.js";
import { createNodeApp } from "./composition-root.js";
import { createFixturePersistence } from "./fixtures.js";
import {
  closeAllOidcFixtures,
  getOpenOidcFixtureCount,
  startOidcFixture,
} from "./testing/oidc-fixture.js";

afterEach(async () => {
  await closeAllOidcFixtures();
  expect(getOpenOidcFixtureCount()).toBe(0);
});

const createTestNodeApp = () => {
  const { knownIdentities, ...persistence } =
    createFixturePersistence("success");
  return createNodeApp({
    ...persistence,
    authStore: new InMemoryAuthSessionStore({ knownIdentities }),
    authConfig: resolveAuthConfig({ NODE_ENV: "test" }),
    externalLoginTransactionStore: new InMemoryExternalLoginTransactionStore(),
  });
};

const responseCookie = (response: Response): string => {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
};

const assertAuthDependenciesAreRequired = () => {
  // @ts-expect-error 合成時に authStore と authConfig は必須。
  createNodeApp(createFixturePersistence("success"));
};
void assertAuthDependenciesAreRequired;

describe("Node composition", () => {
  it("serves projects from the injected repository port", async () => {
    const app = createTestNodeApp();
    const login = await app.request("/auth/login");
    const response = await app.request("/api/projects", {
      headers: { Cookie: responseCookie(login) },
    });

    expect(await response.json()).toEqual({
      items: [
        {
          id: "project_alpha",
          name: "Alpha",
          status: "active",
          version: 1,
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      ],
    });
  });

  it("preserves repository failures as API failures and logs them once", async () => {
    const logLines: string[] = [];
    const app = createNodeApp({
      ...createFixturePersistence("error"),
      authStore: new InMemoryAuthSessionStore(),
      authConfig: resolveAuthConfig({ NODE_ENV: "test" }),
      externalLoginTransactionStore:
        new InMemoryExternalLoginTransactionStore(),
      writeLog: (line) => {
        logLines.push(line);
      },
    });

    const login = await app.request("/auth/login");
    const response = await app.request("/api/projects", {
      headers: {
        Cookie: responseCookie(login),
        "X-Request-Id": "request_composed_failure",
      },
    });

    expect(response.status).toBe(500);
    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0]!)).toMatchObject({
      level: "error",
      message: "unexpected error",
      requestId: "request_composed_failure",
      method: "GET",
      route: "/api/projects",
      status: 500,
    });
    expect(logLines[0]).not.toContain(responseCookie(login));
  });

  it("composes Dev login into a usable application session", async () => {
    const app = createTestNodeApp();

    const login = await app.request("/auth/login?returnTo=%2Fprojects");
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/projects");
    const cookie = responseCookie(login);
    expect(cookie).toMatch(/^session=[A-Za-z0-9_-]{43}$/);

    const me = await app.request("/api/me", {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: {
        email: "developer@starter.local",
        displayName: "Local Developer",
        roles: ["projects:read", "projects:write"],
      },
    });
  });

  it("records a failed session cleanup as one warn line without failing the login", async () => {
    const logLines: string[] = [];
    class FailingCleanupAuthSessionStore extends InMemoryAuthSessionStore {
      override deleteExpired(): Promise<number> {
        // pg の DatabaseError と同じ形（SQLSTATE の code と severity）にする。
        const error = Object.assign(
          new Error("canceling statement due to statement timeout"),
          { code: "57014", severity: "ERROR" },
        );
        return Promise.reject(error);
      }
    }
    const app = createNodeApp({
      ...createFixturePersistence("success"),
      authStore: new FailingCleanupAuthSessionStore(),
      authConfig: resolveAuthConfig({ NODE_ENV: "test" }),
      externalLoginTransactionStore:
        new InMemoryExternalLoginTransactionStore(),
      writeLog: (line) => {
        logLines.push(line);
      },
    });

    const login = await app.request("/auth/login");
    expect(login.status).toBe(303);
    const cookie = responseCookie(login);
    const me = await app.request("/api/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);

    const warnLines = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === "warn");
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toMatchObject({
      level: "warn",
      message: "suppressed error",
      operation: "auth.session-cleanup",
      errorName: "DatabaseError",
      sqlState: "57014",
    });
    expect(logLines.join("\n")).not.toContain(cookie.split("=", 2)[1]!);
  });

  it("records a failed OIDC callback as one warn line without the provider's message", async () => {
    const authConfig = resolveAuthConfig({
      NODE_ENV: "test",
      AUTH_PROVIDER: "oidc",
      APP_ORIGIN: "http://127.0.0.1:5173",
      OIDC_ISSUER: "http://127.0.0.1:4000",
      OIDC_CLIENT_ID: "public-client-id",
      OIDC_LOGOUT_ENDPOINT: "http://127.0.0.1:4000/logout",
    });
    const state = "state-0123456789012345678901234567";
    const provider: ExternalIdentityProvider = {
      begin: () =>
        Promise.resolve({
          authorizationUrl: `http://127.0.0.1:4000/authorize?state=${state}`,
          state,
          nonce: "nonce-0123456789012345678901234567",
          verifier: "verifier-0123456789012345678901234567",
        }),
      complete: () =>
        Promise.reject(new Error("invalid_client token=must-not-leak")),
      logoutUrl: () => "http://127.0.0.1:4000/logout",
    };
    const logLines: string[] = [];
    const app = createNodeApp({
      ...createFixturePersistence("success"),
      authStore: new InMemoryAuthSessionStore(),
      externalLoginTransactionStore:
        new InMemoryExternalLoginTransactionStore(),
      authConfig,
      createIdentityProvider: () => provider,
      writeLog: (line) => {
        logLines.push(line);
      },
    });

    const login = await app.request("/auth/login");
    const callback = await app.request(
      `/auth/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: responseCookie(login) } },
    );

    expect(callback.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    const warnLines = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === "warn");
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toMatchObject({
      message: "suppressed error",
      operation: "auth.external-login-callback",
      errorName: "Error",
    });
    expect(logLines.join("\n")).not.toContain("must-not-leak");
  });

  it("composes the external login flow with the injected identity provider", async () => {
    const authConfig = resolveAuthConfig({
      NODE_ENV: "test",
      AUTH_PROVIDER: "oidc",
      APP_ORIGIN: "http://127.0.0.1:5173",
      OIDC_ISSUER: "http://127.0.0.1:4000",
      OIDC_CLIENT_ID: "public-client-id",
      OIDC_LOGOUT_ENDPOINT: "http://127.0.0.1:4000/logout",
    });
    if (authConfig.provider !== "oidc") {
      throw new Error("Expected an OIDC auth configuration");
    }
    // 取引クッキーは 32 文字以上の protocol value しか受け付けない。
    const state = "state-0123456789012345678901234567";
    const nonce = "nonce-0123456789012345678901234567";
    const verifier = "verifier-0123456789012345678901234567";
    const seenRedirectUris: string[] = [];
    const provider: ExternalIdentityProvider = {
      begin: ({ redirectUri }) => {
        seenRedirectUris.push(redirectUri);
        return Promise.resolve({
          authorizationUrl: `http://127.0.0.1:4000/authorize?state=${state}`,
          state,
          nonce,
          verifier,
        });
      },
      complete: ({ redirectUri }) => {
        seenRedirectUris.push(redirectUri);
        return Promise.resolve(
          createVerifiedIdentity({
            provider: "stub",
            issuer: "http://127.0.0.1:4000",
            subject: "subject-1",
            email: "user@example.com",
            displayName: "Injected User",
            roles: [],
          }),
        );
      },
      logoutUrl: ({ postLogoutRedirectUri }) =>
        `http://127.0.0.1:4000/logout?redirect=${encodeURIComponent(postLogoutRedirectUri)}`,
    };
    const createIdentityProvider = vi.fn(() => provider);
    const identityProviderDependencies = { now: () => 1_700_000_000_000 };

    const app = createNodeApp({
      ...createFixturePersistence("success"),
      authStore: new InMemoryAuthSessionStore(),
      externalLoginTransactionStore:
        new InMemoryExternalLoginTransactionStore(),
      authConfig,
      createIdentityProvider,
      identityProviderDependencies,
    });

    expect(createIdentityProvider).toHaveBeenCalledOnce();
    expect(createIdentityProvider).toHaveBeenCalledWith(
      authConfig.oidc,
      identityProviderDependencies,
    );

    const login = await app.request("/auth/login?returnTo=%2Fprojects");
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe(
      `http://127.0.0.1:4000/authorize?state=${state}`,
    );
    const callback = await app.request(
      `/auth/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: responseCookie(login) } },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/projects");
    const applicationCookie = callback.headers
      .get("set-cookie")
      ?.match(/(?:^|, )(session=[^;]+)/)?.[1];
    expect(applicationCookie).toBeTruthy();

    const me = await app.request("/api/me", {
      headers: { Cookie: applicationCookie! },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { email: "user@example.com", displayName: "Injected User" },
    });

    const providerLogout = await app.request("/auth/provider-logout");
    expect(providerLogout.status).toBe(303);
    expect(providerLogout.headers.get("location")).toBe(
      `http://127.0.0.1:4000/logout?redirect=${encodeURIComponent(
        "http://127.0.0.1:5173/login",
      )}`,
    );
    expect(seenRedirectUris).toEqual([
      authConfig.oidc.redirectUri,
      authConfig.oidc.redirectUri,
    ]);
  });

  it("composes the provider-neutral OIDC flow into a usable application session", async () => {
    const fixture = await startOidcFixture({
      claims: {
        sub: "subject-1",
        email: "user@example.com",
        email_verified: true,
        name: "OIDC User",
      },
    });
    const appOrigin = new URL(fixture.redirectUri).origin;
    const app = createNodeApp({
      ...createFixturePersistence("success"),
      authStore: new InMemoryAuthSessionStore(),
      externalLoginTransactionStore:
        new InMemoryExternalLoginTransactionStore(),
      authConfig: resolveAuthConfig({
        NODE_ENV: "test",
        AUTH_PROVIDER: "oidc",
        APP_ORIGIN: appOrigin,
        OIDC_ISSUER: fixture.issuer,
        OIDC_CLIENT_ID: fixture.clientConfig.clientId,
        OIDC_LOGOUT_ENDPOINT: fixture.clientConfig.logoutEndpoint,
      }),
    });

    const login = await app.request("/auth/login?returnTo=%2Fprojects");
    expect(login.status).toBe(303);
    expect(login.headers.get("cache-control")).toBe("no-store");
    const transactionCookie = responseCookie(login);
    const callbackUrl = await fixture.authorize(
      new URL(login.headers.get("location")!),
    );
    const callback = await app.request(callbackUrl, {
      headers: { Cookie: transactionCookie },
    });

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/projects");
    const applicationCookie = callback.headers
      .get("set-cookie")
      ?.match(/(?:^|, )(session=[^;]+)/)?.[1];
    expect(applicationCookie).toBeTruthy();
    const me = await app.request("/api/me", {
      headers: { Cookie: applicationCookie! },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { email: "user@example.com", displayName: "OIDC User" },
    });

    const providerLogout = await app.request("/auth/provider-logout");
    const expectedLogout = new URL(fixture.clientConfig.logoutEndpoint);
    expectedLogout.searchParams.set("client_id", fixture.clientConfig.clientId);
    expectedLogout.searchParams.set(
      "logout_uri",
      new URL("/login", appOrigin).toString(),
    );
    expect(providerLogout.status).toBe(303);
    expect(providerLogout.headers.get("location")).toBe(
      expectedLogout.toString(),
    );
  });

  it("keeps callback and /api/me successful when verified optional profile claims are invalid", async () => {
    const fixture = await startOidcFixture({
      claims: {
        sub: "subject-invalid-profile",
        email: "not-an-email",
        email_verified: true,
        name: "",
      },
    });
    const appOrigin = new URL(fixture.redirectUri).origin;
    const app = createNodeApp({
      ...createFixturePersistence("success"),
      authStore: new InMemoryAuthSessionStore(),
      externalLoginTransactionStore:
        new InMemoryExternalLoginTransactionStore(),
      authConfig: resolveAuthConfig({
        NODE_ENV: "test",
        AUTH_PROVIDER: "oidc",
        APP_ORIGIN: appOrigin,
        OIDC_ISSUER: fixture.issuer,
        OIDC_CLIENT_ID: fixture.clientConfig.clientId,
        OIDC_LOGOUT_ENDPOINT: fixture.clientConfig.logoutEndpoint,
      }),
    });

    const login = await app.request("/auth/login");
    const callbackUrl = await fixture.authorize(
      new URL(login.headers.get("location")!),
    );
    const callback = await app.request(callbackUrl, {
      headers: { Cookie: responseCookie(login) },
    });
    const applicationCookie = callback.headers
      .get("set-cookie")
      ?.match(/(?:^|, )(session=[^;]+)/)?.[1];

    expect(callback.status).toBe(303);
    expect(applicationCookie).toBeTruthy();
    const me = await app.request("/api/me", {
      headers: { Cookie: applicationCookie! },
    });
    expect(me.status).toBe(200);
    const body: unknown = await me.json();
    if (
      body === null ||
      typeof body !== "object" ||
      !("user" in body) ||
      body.user === null ||
      typeof body.user !== "object"
    ) {
      throw new Error("Expected a user response object");
    }
    expect(Object.keys(body.user).sort()).toEqual(["id", "roles"]);
    expect("roles" in body.user ? body.user.roles : undefined).toEqual([]);
  });

  it.each(["valid", "wrong state", "duplicate code"] as const)(
    "validates a %s callback over the proxy HTTP transport",
    async (scenario) => {
      const appOrigin = "https://127.0.0.1:5173";
      const fixture = await startOidcFixture({
        claims: { sub: "proxy-user" },
        redirectUri: `${appOrigin}/auth/callback`,
      });
      const app = createNodeApp({
        ...createFixturePersistence("success"),
        authStore: new InMemoryAuthSessionStore(),
        externalLoginTransactionStore:
          new InMemoryExternalLoginTransactionStore(),
        authConfig: resolveAuthConfig({
          NODE_ENV: "test",
          AUTH_PROVIDER: "oidc",
          APP_ORIGIN: appOrigin,
          OIDC_ISSUER: fixture.issuer,
          OIDC_CLIENT_ID: fixture.clientConfig.clientId,
          OIDC_LOGOUT_ENDPOINT: fixture.clientConfig.logoutEndpoint,
        }),
      });
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: app.fetch,
      });
      try {
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("Expected an HTTP listener address");
        }
        const login = await app.request("/auth/login?returnTo=%2Fprojects");
        const callbackUrl = await fixture.authorize(
          new URL(login.headers.get("location")!),
        );
        if (scenario === "wrong state") {
          callbackUrl.searchParams.set("state", "unrelated-transaction");
        } else if (scenario === "duplicate code") {
          callbackUrl.searchParams.append("code", "unexpected-code");
        }

        const callback = await new Promise<{
          status: number | undefined;
          location: string | undefined;
          cookies: string[];
        }>((resolve, reject) => {
          const outgoing = request(
            {
              hostname: "127.0.0.1",
              port: address.port,
              path: `${callbackUrl.pathname}${callbackUrl.search}`,
              headers: {
                Host: "internal-alb.example",
                Cookie: responseCookie(login),
                "X-Forwarded-Host": "attacker.example",
                "X-Forwarded-Proto": "http",
                Forwarded: "host=attacker.example;proto=http",
              },
            },
            (response) => {
              response.resume();
              response.once("end", () => {
                resolve({
                  status: response.statusCode,
                  location: response.headers.location,
                  cookies: response.headers["set-cookie"] ?? [],
                });
              });
            },
          );
          outgoing.once("error", reject);
          outgoing.end();
        });

        expect(callback.status).toBe(303);
        const applicationCookie = callback.cookies
          .find((cookie) => cookie.startsWith("session="))
          ?.split(";", 1)[0];
        if (scenario === "valid") {
          expect(callback.location).toBe("/projects");
          expect(applicationCookie).toBeTruthy();
          const me = await app.request("/api/me", {
            headers: { Cookie: applicationCookie! },
          });
          expect(me.status).toBe(200);
          expect(fixture.requestCounts.token).toBe(1);
        } else {
          expect(callback.location).toBe("/login?error=authentication_failed");
          expect(applicationCookie).toBeUndefined();
          expect(fixture.requestCounts.token).toBe(0);
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
