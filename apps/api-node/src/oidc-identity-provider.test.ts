import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeError } from "./error-summary.js";
import {
  createOidcIdentityProvider,
  OidcClientAuthenticationUnsupportedError,
} from "./oidc-identity-provider.js";
import { RedactedSecret } from "./redacted-secret.js";
import {
  clientSecretWireForms,
  closeAllOidcFixtures,
  getOpenOidcFixtureCount,
  startOidcFixture,
} from "./testing/oidc-fixture.js";

afterEach(async () => {
  await closeAllOidcFixtures();
  expect(getOpenOidcFixtureCount()).toBe(0);
});

describe("OIDC identity provider", () => {
  it("uses discovery, state, nonce, S256 PKCE, and verified claims", async () => {
    const fixture = await startOidcFixture({
      claims: {
        sub: "subject-1",
        email: "user@example.com",
        email_verified: true,
        name: "OIDC User",
      },
    });
    expect(new URL(fixture.issuer).hostname).toBe("127.0.0.1");
    const provider = createOidcIdentityProvider(fixture.clientConfig);

    const begun = await provider.begin({ redirectUri: fixture.redirectUri });

    const authorization = new URL(begun.authorizationUrl);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("scope")).toBe(
      "openid profile email",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      fixture.redirectUri,
    );
    expect(authorization.searchParams.get("state")).toBe(begun.state);
    expect(authorization.searchParams.get("nonce")).toBe(begun.nonce);
    expect(begun.state).not.toBe(begun.nonce);
    expect(begun.verifier).not.toBe(begun.state);

    const callbackUrl = await fixture.authorize(authorization);
    await expect(
      provider.complete({
        callbackUrl,
        redirectUri: fixture.redirectUri,
        expectedState: begun.state,
        expectedNonce: begun.nonce,
        verifier: begun.verifier,
      }),
    ).resolves.toEqual({
      provider: "oidc",
      issuer: fixture.issuer,
      subject: "subject-1",
      email: "user@example.com",
      displayName: "OIDC User",
      roles: [],
    });

    const second = await provider.begin({ redirectUri: fixture.redirectUri });
    expect(second.state).not.toBe(begun.state);
    expect(second.nonce).not.toBe(begun.nonce);
    expect(second.verifier).not.toBe(begun.verifier);
  });

  it.each([
    ["bad signature", { idToken: { signature: "untrusted" as const } }],
    ["wrong issuer", { idToken: { issuer: "https://wrong.example" } }],
    ["wrong audience", { idToken: { audience: "wrong-client" } }],
    ["wrong nonce", { idToken: { nonce: "wrong-nonce" } }],
    ["expired ID token", { idToken: { expiresInSeconds: -60 } }],
    ["missing ID token", { idToken: { omit: true } }],
  ])("rejects a %s", async (_name, overrides) => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      ...overrides,
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig);
    const begun = await provider.begin({ redirectUri: fixture.redirectUri });
    const callbackUrl = await fixture.authorize(
      new URL(begun.authorizationUrl),
    );

    await expect(
      provider.complete({
        callbackUrl,
        redirectUri: fixture.redirectUri,
        expectedState: begun.state,
        expectedNonce: begun.nonce,
        verifier: begun.verifier,
      }),
    ).rejects.toThrow();
  });

  it.each(["state", "verifier"] as const)(
    "rejects a wrong %s",
    async (field) => {
      const fixture = await startOidcFixture({
        claims: { sub: "subject-1" },
      });
      const provider = createOidcIdentityProvider(fixture.clientConfig);
      const begun = await provider.begin({ redirectUri: fixture.redirectUri });
      const callbackUrl = await fixture.authorize(
        new URL(begun.authorizationUrl),
      );

      await expect(
        provider.complete({
          callbackUrl,
          redirectUri: fixture.redirectUri,
          expectedState: field === "state" ? "wrong-state" : begun.state,
          expectedNonce: begun.nonce,
          verifier: field === "verifier" ? "wrong-verifier" : begun.verifier,
        }),
      ).rejects.toThrow();
    },
  );

  it("omits an unverified email", async () => {
    const fixture = await startOidcFixture({
      claims: {
        sub: "subject-1",
        email: "unverified@example.com",
        email_verified: false,
      },
    });
    const identity = await completeLogin(
      createOidcIdentityProvider(fixture.clientConfig),
      fixture,
    );

    expect(identity).toEqual({
      provider: "oidc",
      issuer: fixture.issuer,
      subject: "subject-1",
      roles: [],
    });
  });

  it("omits verified optional profile claims that violate the public contract", async () => {
    const fixture = await startOidcFixture({
      claims: {
        sub: "subject-1",
        email: "not-an-email",
        email_verified: true,
        name: "",
      },
    });
    const identity = await completeLogin(
      createOidcIdentityProvider(fixture.clientConfig),
      fixture,
    );

    expect(identity).toEqual({
      provider: "oidc",
      issuer: fixture.issuer,
      subject: "subject-1",
      roles: [],
    });
  });

  it("constructs exact Cognito and standard provider logout URLs", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
    });
    const postLogoutRedirectUri = "https://app.example/login";
    const cognito = createOidcIdentityProvider({
      ...fixture.clientConfig,
      logoutRedirectParameter: "logout_uri",
    });
    const cognitoUrl = new URL(cognito.logoutUrl({ postLogoutRedirectUri }));

    expect(cognitoUrl.origin + cognitoUrl.pathname).toBe(
      fixture.clientConfig.logoutEndpoint,
    );
    expect(cognitoUrl.searchParams.get("client_id")).toBe(
      fixture.clientConfig.clientId,
    );
    expect(cognitoUrl.searchParams.get("logout_uri")).toBe(
      postLogoutRedirectUri,
    );
    expect(cognitoUrl.searchParams.has("post_logout_redirect_uri")).toBe(false);

    const standard = createOidcIdentityProvider({
      ...fixture.clientConfig,
      logoutRedirectParameter: "post_logout_redirect_uri",
    });
    const standardUrl = new URL(standard.logoutUrl({ postLogoutRedirectUri }));

    expect(standardUrl.origin + standardUrl.pathname).toBe(
      fixture.clientConfig.logoutEndpoint,
    );
    expect(standardUrl.searchParams.get("client_id")).toBe(
      fixture.clientConfig.clientId,
    );
    expect(standardUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      postLogoutRedirectUri,
    );
    expect(standardUrl.searchParams.has("logout_uri")).toBe(false);
  });

  it("clamps display names to 200 Unicode code points", async () => {
    const fixture = await startOidcFixture({
      claims: {
        sub: "subject-1",
        name: `${"a".repeat(199)}😀x`,
      },
    });
    const identity = await completeLogin(
      createOidcIdentityProvider(fixture.clientConfig),
      fixture,
    );

    expect(identity.displayName).toBe(`${"a".repeat(199)}😀`);
    expect([...(identity.displayName ?? "")]).toHaveLength(200);
  });

  it("rejects malformed discovery metadata", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      discoveryBody: { issuer: "malformed" },
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig);

    await expect(
      provider.begin({ redirectUri: fixture.redirectUri }),
    ).rejects.toThrow();
  });

  it.each([
    "http://evil.example",
    "http://127.0.0.1.evil.com",
    "http://localhost.evil.com",
    "http://10.0.0.1",
    "http://[::2]",
    "ftp://127.0.0.1",
  ])("rejects the non-loopback issuer %s", (issuer) => {
    expect(() => createOidcIdentityProvider(providerConfig(issuer))).toThrow(
      "OIDC issuer must use HTTPS unless it is loopback",
    );
  });

  it.each([
    "https://issuer.example",
    "http://127.0.0.1:8080",
    "http://127.0.0.2:8080",
    "http://localhost:8080",
    "http://[::1]:8080",
  ])("accepts the HTTPS or loopback issuer %s", (issuer) => {
    expect(() =>
      createOidcIdentityProvider(providerConfig(issuer)),
    ).not.toThrow();
  });

  it("keeps the fixture loopback-only surface closed", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
    });

    const response = await fetch(`${fixture.issuer}/unexpected`);

    expect(response.status).toBe(404);
    expect(fixture.requestCounts.unexpected).toBe(1);
  });

  it("publishes JWKS with the registered JWK Set media type", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
    });

    const response = await fetch(`${fixture.issuer}/jwks`);

    expect(response.headers.get("content-type")).toBe(
      "application/jwk-set+json; charset=utf-8",
    );
  });

  it("keeps a loopback advertised issuer when only the bind address changes", async () => {
    const fixture = await startOidcFixture({
      bindAddress: "0.0.0.0",
      claims: { sub: "subject-1" },
    });

    expect(fixture.bindAddress).toBe("0.0.0.0");
    expect(new URL(fixture.issuer).hostname).toBe("127.0.0.1");
  });

  it("can advertise an explicit hostname with its dynamic bound port", async () => {
    const fixture = await startOidcFixture({
      bindAddress: "0.0.0.0",
      claims: { sub: "subject-1" },
      issuerHostname: "host.docker.internal",
    });

    const issuer = new URL(fixture.issuer);
    expect(fixture.bindAddress).toBe("0.0.0.0");
    expect(issuer.protocol).toBe("http:");
    expect(issuer.hostname).toBe("host.docker.internal");
    expect(issuer.port).not.toBe("");
  });

  it("represents an external HTTPS issuer and accepts the exact HTTPS redirect", async () => {
    const redirectUri = "https://d111111abcdef8.cloudfront.net/auth/callback";
    const fixture = await startOidcFixture({
      bindAddress: "0.0.0.0",
      claims: { sub: "subject-1" },
      issuerOrigin: "https://host.docker.internal:8443",
      redirectUri,
    });
    const authorization = new URL("/authorize", fixture.issuer);
    authorization.search = new URLSearchParams({
      client_id: "fixture-public-client",
      code_challenge: "fixture-challenge",
      code_challenge_method: "S256",
      nonce: "fixture-nonce",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state: "fixture-state",
    }).toString();

    const callback = await fixture.authorize(authorization);

    expect(fixture.issuer).toBe("https://host.docker.internal:8443");
    expect(fixture.redirectUri).toBe(redirectUri);
    expect(fixture.clientConfig.redirectUri).toBe(redirectUri);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("fixture-state");
  });

  it("rejects a callback that does not match the exact redirect URI", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig);
    const begun = await provider.begin({ redirectUri: fixture.redirectUri });
    const callbackUrl = await fixture.authorize(
      new URL(begun.authorizationUrl),
    );

    await expect(
      provider.complete({
        callbackUrl,
        redirectUri: `${fixture.redirectUri}/wrong`,
        expectedState: begun.state,
        expectedNonce: begun.nonce,
        verifier: begun.verifier,
      }),
    ).rejects.toThrow();
    expect(fixture.requestCounts.token).toBe(0);
  });

  it.each(["origin", "path"])(
    "rejects a mismatched callback %s before token exchange",
    async (part) => {
      const fixture = await startOidcFixture({
        claims: { sub: "subject-1" },
      });
      const provider = createOidcIdentityProvider(fixture.clientConfig);
      const begun = await provider.begin({ redirectUri: fixture.redirectUri });
      const callbackUrl = await fixture.authorize(
        new URL(begun.authorizationUrl),
      );
      if (part === "origin") callbackUrl.hostname = "attacker.example";
      else callbackUrl.pathname = "/unexpected-callback";

      await expect(
        provider.complete({
          callbackUrl,
          redirectUri: fixture.redirectUri,
          expectedState: begun.state,
          expectedNonce: begun.nonce,
          verifier: begun.verifier,
        }),
      ).rejects.toThrow("OIDC callback URL does not match redirect URI");
      expect(fixture.requestCounts.token).toBe(0);
    },
  );

  it("applies a five-second total discovery deadline", async () => {
    vi.useFakeTimers();
    try {
      installFakeAbortTimeout();
      const provider = createOidcIdentityProvider(
        {
          clientId: "fixture-public-client",
          clientAuthentication: { method: "none" },
          issuer: "http://127.0.0.1:65534",
          logoutEndpoint: "http://127.0.0.1:65534/logout",
          logoutRedirectParameter: "logout_uri",
          postLogoutRedirectUri: "http://127.0.0.1:5173/login",
          redirectUri: "http://127.0.0.1:5173/auth/callback",
        },
        {
          fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener(
                "abort",
                () => reject(abortReason(init.signal)),
                { once: true },
              );
            }),
        },
      );

      const result = provider.begin({
        redirectUri: "http://127.0.0.1:5173/auth/callback",
      });
      const rejection = expect(result).rejects.toThrow();
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(4_999);
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["token", "jwks"] as const)(
    "applies a five-second total %s deadline",
    async (stalledEndpoint) => {
      const fixture = await startOidcFixture({
        claims: { sub: "subject-1" },
      });
      let reachedStalledEndpoint!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedStalledEndpoint = resolve;
      });
      const provider = createOidcIdentityProvider(fixture.clientConfig, {
        fetch: (url, init) => {
          if (new URL(url).pathname === `/${stalledEndpoint}`) {
            reachedStalledEndpoint();
            return new Promise((_resolve, reject) => {
              init.signal?.addEventListener(
                "abort",
                () => reject(abortReason(init.signal)),
                { once: true },
              );
            });
          }
          return fetch(url, init as RequestInit);
        },
      });
      const begun = await provider.begin({ redirectUri: fixture.redirectUri });
      const callbackUrl = await fixture.authorize(
        new URL(begun.authorizationUrl),
      );

      vi.useFakeTimers();
      try {
        installFakeAbortTimeout();
        const result = provider.complete({
          callbackUrl,
          redirectUri: fixture.redirectUri,
          expectedState: begun.state,
          expectedNonce: begun.nonce,
          verifier: begun.verifier,
        });
        const rejection = expect(result).rejects.toThrow();
        let settled = false;
        void result.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await reached;
        await vi.advanceTimersByTimeAsync(4_999);
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["default without a header", undefined, 300_000],
    ["short max-age", "max-age=10", 10_000],
    ["one-hour cap", "max-age=7200", 3_600_000],
    ["default for invalid header", "max-age=invalid", 300_000],
  ])(
    "expires discovery using the %s lifetime",
    async (_name, cacheControl, lifetimeMs) => {
      let nowMs = 10_000;
      const fixture = await startOidcFixture({
        cacheControl:
          cacheControl === undefined ? {} : { discovery: cacheControl },
        claims: { sub: "subject-1" },
      });
      const provider = createOidcIdentityProvider(fixture.clientConfig, {
        now: () => nowMs,
      });

      await provider.begin({ redirectUri: fixture.redirectUri });
      nowMs += lifetimeMs - 1;
      await provider.begin({ redirectUri: fixture.redirectUri });
      expect(fixture.requestCounts.discovery).toBe(1);
      nowMs += 1;
      await provider.begin({ redirectUri: fixture.redirectUri });
      expect(fixture.requestCounts.discovery).toBe(2);
    },
  );

  it("does not reuse discovery with max-age=0", async () => {
    const fixture = await startOidcFixture({
      cacheControl: { discovery: "max-age=0" },
      claims: { sub: "subject-1" },
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig);

    await provider.begin({ redirectUri: fixture.redirectUri });
    await provider.begin({ redirectUri: fixture.redirectUri });

    expect(fixture.requestCounts.discovery).toBe(2);
  });

  it("recreates the client and fetches JWKS after cache-header expiry", async () => {
    let nowMs = 0;
    const fixture = await startOidcFixture({
      cacheControl: { jwks: "max-age=10" },
      claims: { sub: "subject-1" },
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig, {
      now: () => nowMs,
    });
    await completeLogin(provider, fixture);
    expect(fixture.requestCounts.jwks).toBe(1);

    await fixture.rotateSigningKey();
    nowMs = 10_000;
    await expect(completeLogin(provider, fixture)).resolves.toMatchObject({
      subject: "subject-1",
    });
    expect(fixture.requestCounts.jwks).toBe(2);
  });

  it("does not reuse JWKS with max-age=0", async () => {
    const fixture = await startOidcFixture({
      cacheControl: { jwks: "max-age=0" },
      claims: { sub: "subject-1" },
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig);
    await completeLogin(provider, fixture);
    expect(fixture.requestCounts.jwks).toBe(1);

    await fixture.rotateSigningKey();
    await expect(completeLogin(provider, fixture)).resolves.toMatchObject({
      subject: "subject-1",
    });
    expect(fixture.requestCounts.jwks).toBe(2);
  });

  it.each([
    ["default", undefined, 300_000],
    ["one-hour cap", "max-age=7200", 3_600_000],
  ])(
    "expires JWKS using the %s lifetime",
    async (_name, cacheControl, lifetimeMs) => {
      let nowMs = 5_000;
      const fixture = await startOidcFixture({
        cacheControl: cacheControl === undefined ? {} : { jwks: cacheControl },
        claims: { sub: "subject-1" },
      });
      const provider = createOidcIdentityProvider(fixture.clientConfig, {
        now: () => nowMs,
      });
      await completeLogin(provider, fixture);
      expect(fixture.requestCounts.jwks).toBe(1);

      await fixture.rotateSigningKey();
      nowMs += lifetimeMs - 1;
      await provider.begin({ redirectUri: fixture.redirectUri });
      expect(fixture.requestCounts.jwks).toBe(1);
      nowMs += 1;
      await expect(completeLogin(provider, fixture)).resolves.toMatchObject({
        subject: "subject-1",
      });
      expect(fixture.requestCounts.jwks).toBe(2);
    },
  );

  it("does not cache unsuccessful JWKS responses", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      jwksStatuses: [503, 200],
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig);

    await expect(completeLogin(provider, fixture)).rejects.toThrow();
    expect(fixture.requestCounts.jwks).toBe(1);
    await expect(completeLogin(provider, fixture)).resolves.toMatchObject({
      subject: "subject-1",
    });
    expect(fixture.requestCounts.jwks).toBe(2);
  });

  it("allows at most one unknown-kid JWKS refresh per issuer per minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      let nowMs = 0;
      const fixture = await startOidcFixture({
        cacheControl: { jwks: "max-age=300" },
        claims: { sub: "subject-1" },
      });
      const provider = createOidcIdentityProvider(fixture.clientConfig, {
        now: () => nowMs,
      });
      await completeLogin(provider, fixture);
      expect(fixture.requestCounts.jwks).toBe(1);

      await fixture.rotateSigningKey();
      vi.advanceTimersByTime(59_000);
      nowMs += 59_000;
      await expect(completeLogin(provider, fixture)).rejects.toThrow();
      expect(fixture.requestCounts.jwks).toBe(1);

      vi.advanceTimersByTime(1_000);
      nowMs += 1_000;
      await expect(completeLogin(provider, fixture)).resolves.toMatchObject({
        subject: "subject-1",
      });
      expect(fixture.requestCounts.jwks).toBe(2);

      await fixture.rotateSigningKey();
      vi.advanceTimersByTime(1_000);
      nowMs += 1_000;
      await expect(completeLogin(provider, fixture)).rejects.toThrow();
      expect(fixture.requestCounts.jwks).toBe(2);

      vi.advanceTimersByTime(59_000);
      nowMs += 59_000;
      await expect(completeLogin(provider, fixture)).resolves.toMatchObject({
        subject: "subject-1",
      });
      expect(fixture.requestCounts.jwks).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles repeated fresh-cache JWKS requests in the fetch wrapper", async () => {
    const fixture = await startOidcFixture({
      cacheControl: { discovery: "max-age=0", jwks: "max-age=300" },
      claims: { sub: "subject-1" },
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig, {
      now: () => 0,
    });

    await completeLogin(provider, fixture);
    expect(fixture.requestCounts.jwks).toBe(1);
    await completeLogin(provider, fixture);
    expect(fixture.requestCounts.jwks).toBe(2);
    await completeLogin(provider, fixture);
    expect(fixture.requestCounts.jwks).toBe(2);
  });
});

// oauth4webapi は Basic 認証の前に id と secret を form-urlencode する（RFC 6749 §2.3.1）。
// `~` と `.` は encodeURIComponent が残す文字、`+` は復号で空白に戻る文字、`:` は Basic の
// 区切り文字で、どれも符号化と復号の食い違いを表に出す。
const confidentialSecret = "fixture~secret.with+plus:colon";

describe("OIDC client authentication", () => {
  it("authenticates the token request with HTTP Basic and still sends the PKCE verifier", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(confidentialSecret),
    });
    expect(fixture.clientConfig.clientAuthentication.method).toBe(
      "client_secret_basic",
    );

    await expect(
      completeLogin(createOidcIdentityProvider(fixture.clientConfig), fixture),
    ).resolves.toMatchObject({ subject: "subject-1" });
    expect(fixture.tokenRequests).toEqual([
      { clientAuthentication: "client_secret_basic", codeVerifier: true },
    ]);
  });

  it("keeps the token request unauthenticated for a public client", async () => {
    const fixture = await startOidcFixture({ claims: { sub: "subject-1" } });
    expect(fixture.clientConfig.clientAuthentication).toEqual({
      method: "none",
    });

    await expect(
      completeLogin(createOidcIdentityProvider(fixture.clientConfig), fixture),
    ).resolves.toMatchObject({ subject: "subject-1" });
    expect(fixture.tokenRequests).toEqual([
      { clientAuthentication: "none", codeVerifier: true },
    ]);
  });

  it("fails discovery when the issuer does not support client_secret_basic", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(confidentialSecret),
      tokenEndpointAuthMethodsSupported: ["client_secret_post", "none"],
    });
    const provider = createOidcIdentityProvider(fixture.clientConfig);

    const error = await provider
      .begin({ redirectUri: fixture.redirectUri })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(OidcClientAuthenticationUnsupportedError);
    expect((error as Error).message).toBe(
      "OIDC issuer does not list client_secret_basic in token_endpoint_auth_methods_supported",
    );
    // 運用ログは summarizeError しか通らず、この型の message は落ちる。型名で原因が分かること。
    expect(summarizeError(error)).toMatchObject({
      errorName: "OidcClientAuthenticationUnsupportedError",
    });
    expect(summarizeError(error)).not.toHaveProperty("errorMessage");
    const rendered = inspect(error, { depth: Infinity, showHidden: true });
    for (const form of clientSecretWireForms({
      clientId: fixture.clientConfig.clientId,
      secret: confidentialSecret,
    })) {
      expect(rendered).not.toContain(form);
    }
    expect(fixture.requestCounts.discovery).toBe(1);
    expect(fixture.requestCounts.token).toBe(0);
  });

  it("starts a public client even when discovery does not list none", async () => {
    // Cognito と Google の discovery は、public client を受け付けていても none を載せない。
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      tokenEndpointAuthMethodsSupported: [
        "client_secret_basic",
        "client_secret_post",
      ],
    });

    await expect(
      completeLogin(createOidcIdentityProvider(fixture.clientConfig), fixture),
    ).resolves.toMatchObject({ subject: "subject-1" });
    expect(fixture.tokenRequests).toEqual([
      { clientAuthentication: "none", codeVerifier: true },
    ]);
  });

  it("accepts client_secret_basic when discovery omits token_endpoint_auth_methods_supported", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(confidentialSecret),
      tokenEndpointAuthMethodsSupported: "omit",
    });

    await expect(
      completeLogin(createOidcIdentityProvider(fixture.clientConfig), fixture),
    ).resolves.toMatchObject({ subject: "subject-1" });
    expect(fixture.tokenRequests).toEqual([
      { clientAuthentication: "client_secret_basic", codeVerifier: true },
    ]);
  });

  it("maps invalid_client to the generic login failure without leaking the secret", async () => {
    const wrongSecret = "wrong~secret.value+plus:colon";
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(confidentialSecret),
    });
    const provider = createOidcIdentityProvider({
      ...fixture.clientConfig,
      clientAuthentication: {
        method: "client_secret_basic",
        secret: new RedactedSecret(wrongSecret),
      },
    });

    const error = await completeLogin(provider, fixture).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ error: "invalid_client", status: 401 });
    expect(fixture.requestCounts.token).toBe(1);
    expect(fixture.tokenRequests).toEqual([]);
    const rendered = [
      inspect(error, { depth: Infinity, showHidden: true }),
      JSON.stringify(summarizeError(error)),
    ].join("\n");
    for (const secret of [wrongSecret, confidentialSecret]) {
      for (const form of clientSecretWireForms({
        clientId: fixture.clientConfig.clientId,
        secret,
      })) {
        expect(rendered).not.toContain(form);
      }
    }
  });
});

describe("OIDC fixture client authentication", () => {
  it("lists the Basic header credentials that oauth4webapi actually sends", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(confidentialSecret),
    });
    const authorizations: string[] = [];
    const provider = createOidcIdentityProvider(fixture.clientConfig, {
      fetch: (url, init) => {
        const authorization = new Headers(init.headers).get("authorization");
        if (authorization !== null) authorizations.push(authorization);
        return fetch(url, init as RequestInit);
      },
    });

    await completeLogin(provider, fixture);

    const forms = clientSecretWireForms({
      clientId: fixture.clientConfig.clientId,
      secret: confidentialSecret,
    });
    expect(authorizations).toEqual([`Basic ${forms.at(-1)}`]);
  });

  it("rejects a public token request when the client is confidential", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(confidentialSecret),
    });
    const provider = createOidcIdentityProvider({
      ...fixture.clientConfig,
      clientAuthentication: { method: "none" },
    });

    await expect(completeLogin(provider, fixture)).rejects.toThrow();
    expect(fixture.tokenRequests).toEqual([]);
  });

  it("rejects Basic credentials that skip form-urlencoding", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(confidentialSecret),
    });
    const credentials = Buffer.from(
      `${fixture.clientConfig.clientId}:${confidentialSecret}`,
    ).toString("base64");

    const response = await fetch(`${fixture.issuer}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_client" });
  });
});

type Provider = ReturnType<typeof createOidcIdentityProvider>;
type Fixture = Awaited<ReturnType<typeof startOidcFixture>>;

const providerConfig = (issuer: string) => ({
  clientId: "fixture-public-client",
  clientAuthentication: { method: "none" as const },
  issuer,
  logoutEndpoint: `${issuer}/logout`,
  logoutRedirectParameter: "logout_uri" as const,
  postLogoutRedirectUri: "http://127.0.0.1:5173/login",
  redirectUri: "http://127.0.0.1:5173/auth/callback",
});

const completeLogin = async (provider: Provider, fixture: Fixture) => {
  const begun = await provider.begin({ redirectUri: fixture.redirectUri });
  const callbackUrl = await fixture.authorize(new URL(begun.authorizationUrl));
  return provider.complete({
    callbackUrl,
    redirectUri: fixture.redirectUri,
    expectedState: begun.state,
    expectedNonce: begun.nonce,
    verifier: begun.verifier,
  });
};

const installFakeAbortTimeout = () => {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      milliseconds,
    );
    return controller.signal;
  });
};

const abortReason = (signal: AbortSignal | undefined): Error =>
  signal?.reason instanceof Error
    ? signal.reason
    : new Error("request aborted");
