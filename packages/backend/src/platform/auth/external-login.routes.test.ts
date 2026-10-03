import { describe, expect, it, vi } from "vitest";
import { createAuthenticateSession } from "./authenticate-session.js";
import { InMemoryAuthSessionStore } from "./auth-session-store.memory.js";
import { createBeginExternalLogin } from "./begin-external-login.js";
import { createCompleteExternalLogin } from "./complete-external-login.js";
import {
  createEstablishSession,
  type EstablishSession,
} from "./establish-session.js";
import type { ExternalIdentityProvider } from "./external-identity-provider.js";
import {
  createExternalLoginRoutes,
  type ExternalLoginCookieConfig,
} from "./external-login.routes.js";
import { InMemoryExternalLoginTransactionStore } from "./external-login-transaction-store.memory.js";
import type {
  ReportSuppressedError,
  SuppressedErrorEvent,
} from "../errors/report-suppressed-error.js";

const redirectUri = "https://app.example/auth/callback";
const state = "s".repeat(43);
const nonce = "n".repeat(43);
const verifier = "v".repeat(43);
const sessionCookie = {
  name: "__Host-session" as const,
  secure: true,
  maxAgeSeconds: 604_800,
};
const transactionCookie: ExternalLoginCookieConfig = {
  name: "__Secure-oidc-transaction",
  secure: true,
  path: "/auth/callback",
  maxAgeSeconds: 600,
};
const policy = {
  absoluteTtlMs: 604_800_000,
  idleTtlMs: 86_400_000,
  touchIntervalMs: 300_000,
};
const now = new Date("2026-08-10T00:00:00.000Z");
const hash = (value: string) => `hash:${value}`;

const cookieValue = (response: Response, name: string): string => {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`(?:^|, )${name}=([^;]+)`).exec(setCookie);
  expect(match).not.toBeNull();
  return match![1]!;
};

const expectTransactionCookieCleared = (response: Response) => {
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("__Secure-oidc-transaction=");
  expect(setCookie).toContain("Max-Age=0");
  expect(setCookie).toContain("Path=/auth/callback");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
};

const createRouteFixture = ({
  establishSession: establishSessionOverride,
  complete: completeOverride,
}: {
  establishSession?: EstablishSession;
  complete?: ExternalIdentityProvider["complete"];
} = {}) => {
  const reported: SuppressedErrorEvent[] = [];
  const reportSuppressedError: ReportSuppressedError = (event) => {
    reported.push(event);
  };
  const clock = () => new Date(now.getTime());
  const transactionStore = new InMemoryExternalLoginTransactionStore();
  const authStore = new InMemoryAuthSessionStore();
  let sessionSequence = 0;
  const completeCalls: Parameters<ExternalIdentityProvider["complete"]>[0][] =
    [];
  const provider: ExternalIdentityProvider = {
    begin: () =>
      Promise.resolve({
        authorizationUrl: `https://issuer.example/authorize?state=${state}`,
        state,
        nonce,
        verifier,
      }),
    complete: (input) => {
      completeCalls.push(input);
      if (completeOverride !== undefined) return completeOverride(input);
      if (
        input.callbackUrl.searchParams.has("error") ||
        input.callbackUrl.searchParams.get("code") === "provider-failure"
      ) {
        return Promise.reject(
          new Error("access_denied code=must-not-leak token=must-not-leak"),
        );
      }
      return Promise.resolve({
        provider: "oidc",
        issuer: "https://issuer.example",
        subject: "subject-1",
        email: "user@example.com",
        displayName: "OIDC User",
        roles: [],
      });
    },
    logoutUrl: () =>
      "https://issuer.example/logout?client_id=public&logout_uri=https%3A%2F%2Fapp.example%2Flogin",
  };
  const establishSession =
    establishSessionOverride ??
    createEstablishSession({
      clock,
      generateSessionId: () => `new_session_${++sessionSequence}`,
      generateUserId: () => "user_oidc",
      hashSessionId: hash,
      policy,
      store: authStore,
    });
  const beginExternalLogin = createBeginExternalLogin({
    clock,
    hash,
    provider,
    redirectUri,
    store: transactionStore,
    ttlMs: 600_000,
  });
  const completeExternalLogin = createCompleteExternalLogin({
    clock,
    hash,
    provider,
    redirectUri,
    store: transactionStore,
  });
  const routes = createExternalLoginRoutes({
    beginExternalLogin,
    completeExternalLogin,
    establishSession,
    providerLogoutUrl: provider.logoutUrl({
      postLogoutRedirectUri: "https://app.example/login",
    }),
    redirectUri,
    reportSuppressedError,
    sessionCookie,
    transactionCookie,
  });

  const begin = async (returnTo = "/projects") => {
    const response = await routes.request(
      `/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
    return {
      response,
      cookie: `${transactionCookie.name}=${cookieValue(
        response,
        transactionCookie.name,
      )}`,
    };
  };

  return {
    authStore,
    begin,
    completeCalls,
    establishSession,
    reported,
    routes,
  };
};

describe("external login routes", () => {
  it("sets a no-store transaction cookie and redirects to the provider", async () => {
    const fixture = createRouteFixture();

    const { response } = await fixture.begin();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://issuer.example/authorize?state=${state}`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Secure-oidc-transaction=");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("Path=/auth/callback");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("establishes one app session and redirects only to the stored return path", async () => {
    const fixture = createRouteFixture();
    const login = await fixture.begin("/projects/project_alpha");

    const response = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/projects/project_alpha");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    expectTransactionCookieCleared(response);

    const replay = await fixture.routes.request(
      `/callback?state=${state}&code=access_denied`,
      { headers: { Cookie: login.cookie } },
    );
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    expect(await replay.text()).not.toContain("access_denied");
    expect(fixture.completeCalls).toHaveLength(1);
    expectTransactionCookieCleared(replay);
  });

  it.each([
    ["duplicate state", `state=${state}&state=${state}&code=code`],
    ["duplicate code", `state=${state}&code=one&code=two`],
    ["duplicate error", `state=${state}&error=one&error=two`],
    ["code and error", `state=${state}&code=code&error=access_denied`],
    ["missing state", "code=code"],
    ["missing result", `state=${state}`],
    ["empty state", "state=&code=code"],
    ["empty code", `state=${state}&code=`],
    ["empty error", `state=${state}&error=`],
  ])("rejects %s and clears the transaction cookie", async (_label, query) => {
    const fixture = createRouteFixture();
    const login = await fixture.begin();

    const response = await fixture.routes.request(`/callback?${query}`, {
      headers: { Cookie: login.cookie },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    expect(fixture.completeCalls).toHaveLength(0);
    expectTransactionCookieCleared(response);
  });

  it("consumes provider errors without reflecting them or creating a session", async () => {
    const establishSession = vi.fn<EstablishSession>();
    const fixture = createRouteFixture({ establishSession });
    const login = await fixture.begin();

    const response = await fixture.routes.request(
      `/callback?state=${state}&error=access_denied&error_description=secret`,
      { headers: { Cookie: login.cookie } },
    );
    const replay = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );

    expect(response.headers.get("location")).toBe(
      "/login?error=authentication_failed&returnTo=%2Fprojects",
    );
    expect(replay.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    for (const candidate of [response, replay]) {
      expect(candidate.status).toBe(303);
      expect(await candidate.text()).not.toContain("access_denied");
      expectTransactionCookieCleared(candidate);
    }
    expect(fixture.completeCalls).toHaveLength(1);
    expect(establishSession).not.toHaveBeenCalled();
  });

  it("redirects provider exchange failures generically after consuming the transaction", async () => {
    const establishSession = vi.fn<EstablishSession>();
    const fixture = createRouteFixture({ establishSession });
    const login = await fixture.begin();

    const response = await fixture.routes.request(
      `/callback?state=${state}&code=provider-failure`,
      { headers: { Cookie: login.cookie } },
    );
    const replay = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );

    expect(response.headers.get("location")).toBe(
      "/login?error=authentication_failed&returnTo=%2Fprojects",
    );
    expect(replay.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    expect(await response.text()).not.toContain("must-not-leak");
    expect(fixture.completeCalls).toHaveLength(1);
    expect(establishSession).not.toHaveBeenCalled();
    expectTransactionCookieCleared(response);
    expectTransactionCookieCleared(replay);
  });

  it("consumes the transaction before session establishment fails", async () => {
    const establishSession = vi
      .fn<EstablishSession>()
      .mockRejectedValue(new Error("raw session must not leak"));
    const fixture = createRouteFixture({ establishSession });
    const login = await fixture.begin();

    const first = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );
    const replay = await fixture.routes.request(
      `/callback?state=${state}&code=provider-failure`,
      { headers: { Cookie: login.cookie } },
    );

    expect(first.headers.get("location")).toBe(
      "/login?error=authentication_failed&returnTo=%2Fprojects",
    );
    expect(replay.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    expect(fixture.completeCalls).toHaveLength(1);
    expect(establishSession).toHaveBeenCalledOnce();
    expect(await first.text()).not.toContain("raw session");
    expect(await replay.text()).not.toContain("provider-failure");
  });

  it("rotates a previous application session during callback", async () => {
    const fixture = createRouteFixture();
    const previous = await fixture.establishSession({
      identity: {
        provider: "oidc",
        issuer: "https://issuer.example",
        subject: "subject-1",
        roles: [],
      },
    });
    const login = await fixture.begin();

    const response = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      {
        headers: {
          Cookie: `${login.cookie}; ${sessionCookie.name}=${previous.sessionId}`,
        },
      },
    );
    const currentSessionId = cookieValue(response, sessionCookie.name);
    const authenticate = createAuthenticateSession({
      clock: () => new Date(now.getTime()),
      hashSessionId: hash,
      policy,
      store: fixture.authStore,
    });

    await expect(authenticate(previous.sessionId)).resolves.toBeUndefined();
    await expect(authenticate(currentSessionId)).resolves.toMatchObject({
      user: { id: "user_oidc", email: "user@example.com" },
    });
  });

  it("rejects malformed transaction cookies and always clears them", async () => {
    const fixture = createRouteFixture();

    const response = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      {
        headers: {
          Cookie: `${transactionCookie.name}=malformed=padding`,
        },
      },
    );

    expect(response.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    expect(fixture.completeCalls).toHaveLength(0);
    expectTransactionCookieCleared(response);
  });

  it("records nothing when the login succeeds", async () => {
    const fixture = createRouteFixture();
    const login = await fixture.begin();

    await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );

    expect(fixture.reported).toEqual([]);
  });

  it("records the stage of a failed exchange and returns to the stored path", async () => {
    const fixture = createRouteFixture();
    const login = await fixture.begin();

    const response = await fixture.routes.request(
      `/callback?state=${state}&code=provider-failure`,
      { headers: { Cookie: login.cookie } },
    );

    expect(response.headers.get("location")).toBe(
      "/login?error=authentication_failed&returnTo=%2Fprojects",
    );
    expect(fixture.reported).toHaveLength(1);
    expect(fixture.reported[0]!.operation).toBe(
      "auth.external-login-callback.provider",
    );
    expect(fixture.reported[0]!.error).toBeInstanceOf(Error);
  });

  it("records a replayed callback as the transaction stage without a return path", async () => {
    const fixture = createRouteFixture();
    const login = await fixture.begin("/projects/project_alpha");
    await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );

    const replay = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );

    expect(replay.headers.get("location")).toBe(
      "/login?error=authentication_failed",
    );
    expect(fixture.reported.map((event) => event.operation)).toEqual([
      "auth.external-login-callback.transaction",
    ]);
  });

  it("records a failed session establishment and keeps the stored return path", async () => {
    const fixture = createRouteFixture({
      establishSession: () => Promise.reject(new Error("db down")),
    });
    const login = await fixture.begin("/projects/project_alpha");

    const response = await fixture.routes.request(
      `/callback?state=${state}&code=authorization-code`,
      { headers: { Cookie: login.cookie } },
    );

    expect(response.headers.get("location")).toBe(
      "/login?error=authentication_failed&returnTo=%2Fprojects%2Fproject_alpha",
    );
    expect(fixture.reported.map((event) => event.operation)).toEqual([
      "auth.external-login-callback",
    ]);
  });

  it("records a callback that arrives without its transaction cookie", async () => {
    const fixture = createRouteFixture();

    for (const headers of [
      {},
      { Cookie: `${transactionCookie.name}=malformed=padding` },
    ]) {
      await fixture.routes.request(
        `/callback?state=${state}&code=authorization-code`,
        { headers },
      );
    }

    expect(fixture.reported.map((event) => event.operation)).toEqual([
      "auth.external-login-callback.missing-transaction",
      "auth.external-login-callback.missing-transaction",
    ]);
    expect(fixture.completeCalls).toHaveLength(0);
  });

  it("records a malformed callback query without recording its values", async () => {
    const fixture = createRouteFixture();
    const login = await fixture.begin();

    await fixture.routes.request(
      `/callback?code=authorization-code&code=duplicate-must-not-leak`,
      { headers: { Cookie: login.cookie } },
    );

    expect(fixture.reported).toHaveLength(1);
    expect(fixture.reported[0]!.operation).toBe(
      "auth.external-login-callback.invalid-query",
    );
    expect(JSON.stringify(fixture.reported)).not.toContain("must-not-leak");
  });

  it("records an error returned by the provider without recording its code", async () => {
    const fixture = createRouteFixture({
      complete: () =>
        Promise.resolve({
          provider: "oidc",
          issuer: "https://issuer.example",
          subject: "subject-1",
          roles: [],
        }),
    });
    const login = await fixture.begin();

    const response = await fixture.routes.request(
      `/callback?state=${state}&error=access_denied-must-not-leak`,
      { headers: { Cookie: login.cookie } },
    );

    expect(response.headers.get("location")).toBe(
      "/login?error=authentication_failed&returnTo=%2Fprojects",
    );
    expect(fixture.reported).toHaveLength(1);
    expect(fixture.reported[0]!.operation).toBe(
      "auth.external-login-callback.provider-error",
    );
    expect(JSON.stringify(fixture.reported)).not.toContain("must-not-leak");
  });

  it("redirects provider logout to the exact configured URL", async () => {
    const fixture = createRouteFixture();

    const response = await fixture.routes.request("/provider-logout");

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "https://issuer.example/logout?client_id=public&logout_uri=https%3A%2F%2Fapp.example%2Flogin",
    );
  });
});
