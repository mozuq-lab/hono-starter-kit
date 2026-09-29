import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveAuthConfig } from "./auth-config.js";

const productionOidc = (
  overrides: Record<string, string | undefined> = {},
) => ({
  NODE_ENV: "production",
  AUTH_PROVIDER: "oidc",
  APP_ORIGIN: "https://d111111abcdef8.cloudfront.net",
  OIDC_ISSUER:
    "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_pool",
  OIDC_CLIENT_ID: "public-client-id",
  OIDC_LOGOUT_ENDPOINT:
    "https://starter.auth.ap-northeast-1.amazoncognito.com/logout",
  ...overrides,
});

const developmentOidc = (
  overrides: Record<string, string | undefined> = {},
) => ({
  NODE_ENV: "development",
  AUTH_PROVIDER: "oidc",
  APP_ORIGIN: "http://127.0.0.1:5173",
  OIDC_ISSUER: "http://127.0.0.1:8080",
  OIDC_CLIENT_ID: "public-client-id",
  OIDC_LOGOUT_ENDPOINT: "http://127.0.0.1:8080/logout",
  ...overrides,
});

const resolveProductionOidc = (
  overrides: Record<string, string | undefined> = {},
) => {
  const config = resolveAuthConfig(productionOidc(overrides));
  if (config.provider !== "oidc") {
    throw new Error("Expected OIDC configuration");
  }
  return config;
};

describe("resolveAuthConfig", () => {
  it.each(["development", "test"])(
    "defaults %s to the Dev provider",
    (nodeEnv) => {
      expect(resolveAuthConfig({ NODE_ENV: nodeEnv })).toMatchObject({
        provider: "dev",
        appOrigin: "http://127.0.0.1:5173",
        policy: {
          absoluteTtlMs: 604_800_000,
          idleTtlMs: 86_400_000,
          touchIntervalMs: 300_000,
        },
      });
    },
  );

  it("uses the plain-HTTP development cookie contract", () => {
    expect(resolveAuthConfig({ NODE_ENV: "development" }).cookie).toEqual({
      name: "session",
      secure: false,
      maxAgeSeconds: 604_800,
    });
  });

  it("rejects a non-loopback plain-HTTP origin for the dev provider", () => {
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: "development",
        AUTH_PROVIDER: "dev",
        APP_ORIGIN: "http://staging.example.com",
      }),
    ).toThrow("APP_ORIGIN HTTP URLs require loopback hosts outside production");
  });

  it("trims provider and lifetime values and normalizes the application origin", () => {
    expect(
      resolveAuthConfig({
        NODE_ENV: " development ",
        AUTH_PROVIDER: " dev ",
        APP_ORIGIN: " HTTPS://EXAMPLE.COM:443 ",
        SESSION_ABSOLUTE_TTL_SECONDS: " 7200 ",
        SESSION_IDLE_TTL_SECONDS: " 3600 ",
        SESSION_TOUCH_INTERVAL_SECONDS: " 60 ",
      }),
    ).toEqual({
      provider: "dev",
      appOrigin: "https://example.com",
      policy: {
        absoluteTtlMs: 7_200_000,
        idleTtlMs: 3_600_000,
        touchIntervalMs: 60_000,
      },
      cookie: {
        name: "__Host-session",
        secure: true,
        maxAgeSeconds: 7200,
      },
    });
  });

  it("derives the Dev provider cookie contract from the application origin scheme", () => {
    expect(
      resolveAuthConfig({
        NODE_ENV: "development",
        APP_ORIGIN: "https://app.example",
      }).cookie,
    ).toEqual({
      name: "__Host-session",
      secure: true,
      maxAgeSeconds: 604_800,
    });
  });

  it("derives secure OIDC cookies from HTTPS URLs outside production", () => {
    expect(
      resolveAuthConfig(
        developmentOidc({
          APP_ORIGIN: "https://app.example",
          OIDC_ISSUER: "https://issuer.example",
          OIDC_LOGOUT_ENDPOINT: "https://issuer.example/logout",
        }),
      ),
    ).toMatchObject({
      cookie: { name: "__Host-session", secure: true },
      transactionCookie: { name: "__Secure-oidc-transaction", secure: true },
    });
  });

  it("keeps plain-HTTP OIDC cookies for loopback development", () => {
    expect(resolveAuthConfig(developmentOidc())).toMatchObject({
      cookie: { name: "session", secure: false },
      transactionCookie: { name: "oidc-transaction", secure: false },
    });
  });

  it.each([
    ["application origin", { APP_ORIGIN: "http://127.0.0.1:5173" }],
    ["issuer", { OIDC_ISSUER: "http://127.0.0.1:8080" }],
    [
      "logout endpoint",
      { OIDC_LOGOUT_ENDPOINT: "http://127.0.0.1:8080/logout" },
    ],
  ])(
    "keeps cookies insecure when only the %s stays on loopback HTTP",
    (_label, overrides) => {
      expect(
        resolveAuthConfig(
          developmentOidc({
            APP_ORIGIN: "https://localhost",
            OIDC_ISSUER: "https://localhost:8080",
            OIDC_LOGOUT_ENDPOINT: "https://localhost:8080/logout",
            ...overrides,
          }),
        ),
      ).toMatchObject({
        cookie: { name: "session", secure: false },
        transactionCookie: { name: "oidc-transaction", secure: false },
      });
    },
  );

  it.each(["http://localhost:5173", "http://[::1]:5173", "http://127.0.0.2"])(
    "accepts loopback HTTP application origin %s outside production",
    (appOrigin) => {
      expect(
        resolveAuthConfig(developmentOidc({ APP_ORIGIN: appOrigin })),
      ).toMatchObject({ appOrigin, cookie: { secure: false } });
    },
  );

  it.each([
    ["application origin", { APP_ORIGIN: "http://app.example" }],
    ["issuer", { OIDC_ISSUER: "http://issuer.example" }],
    [
      "logout endpoint",
      { OIDC_LOGOUT_ENDPOINT: "http://issuer.example/logout" },
    ],
    ["loopback-prefixed issuer", { OIDC_ISSUER: "http://127.0.0.1.evil.com" }],
    ["loopback-suffixed issuer", { OIDC_ISSUER: "http://evil.com/127.0.0.1" }],
    ["loopback-prefixed origin", { APP_ORIGIN: "http://localhost.evil.com" }],
  ])("rejects non-loopback HTTP %s outside production", (_label, overrides) => {
    expect(() => resolveAuthConfig(developmentOidc(overrides))).toThrow(
      "OIDC HTTP URLs require loopback hosts outside production",
    );
  });

  it("accepts the 400-day cookie Max-Age boundary", () => {
    expect(
      resolveAuthConfig({
        NODE_ENV: "development",
        SESSION_ABSOLUTE_TTL_SECONDS: "34560000",
      }),
    ).toMatchObject({
      policy: { absoluteTtlMs: 34_560_000_000 },
      cookie: { maxAgeSeconds: 34_560_000 },
    });
  });

  it("rejects an absolute lifetime above the cookie Max-Age limit", () => {
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: "development",
        SESSION_ABSOLUTE_TTL_SECONDS: "34560001",
      }),
    ).toThrow(
      "SESSION_ABSOLUTE_TTL_SECONDS must not exceed 34560000 seconds (400 days), the cookie Max-Age limit",
    );
  });

  it.each(["staging", "prod", "Development", "", " "])(
    "rejects unknown NODE_ENV %s",
    (nodeEnv) => {
      expect(() => resolveAuthConfig({ NODE_ENV: nodeEnv })).toThrow(
        "NODE_ENV must be development, production, or test",
      );
    },
  );

  it.each(["saml", "none", "OIDC"])(
    "rejects unsupported provider %s outside production",
    (provider) => {
      expect(() =>
        resolveAuthConfig({
          NODE_ENV: "development",
          AUTH_PROVIDER: provider,
        }),
      ).toThrow("AUTH_PROVIDER must be dev or oidc");
    },
  );

  it.each([undefined, "dev", "none"])(
    "rejects provider %s in production",
    (provider) => {
      expect(() =>
        resolveAuthConfig({
          NODE_ENV: "production",
          AUTH_PROVIDER: provider,
        }),
      ).toThrow(
        "AUTH_PROVIDER must select an implemented non-Dev provider in production",
      );
    },
  );

  it("returns secure OIDC production configuration", () => {
    expect(resolveAuthConfig(productionOidc())).toMatchObject({
      provider: "oidc",
      cookie: { name: "__Host-session", secure: true },
      transactionCookie: {
        name: "__Secure-oidc-transaction",
        secure: true,
        path: "/auth/callback",
      },
      transactionTtlMs: 600_000,
      oidc: {
        clientId: "public-client-id",
        redirectUri: "https://d111111abcdef8.cloudfront.net/auth/callback",
        postLogoutRedirectUri: "https://d111111abcdef8.cloudfront.net/login",
      },
    });
  });

  it("uses a public client when OIDC_CLIENT_SECRET is unset", () => {
    expect(resolveProductionOidc().oidc.clientAuthentication).toEqual({
      method: "none",
    });
  });

  it("uses client_secret_basic when OIDC_CLIENT_SECRET is set", () => {
    const secret = "client-secret-canary~.+:";
    const config = resolveProductionOidc({ OIDC_CLIENT_SECRET: secret });
    const { clientAuthentication } = config.oidc;

    expect(clientAuthentication.method).toBe("client_secret_basic");
    expect(
      clientAuthentication.method === "client_secret_basic"
        ? clientAuthentication.secret.reveal()
        : undefined,
    ).toBe(secret);
    expect(JSON.stringify(config)).not.toContain("canary");
    expect(inspect(config, { depth: Infinity })).not.toContain("canary");
  });

  it.each([
    ["empty", "", "OIDC_CLIENT_SECRET must not be empty"],
    ["blank", "   ", "OIDC_CLIENT_SECRET must not be empty"],
    [
      "trailing newline",
      "secret-canary\n",
      "OIDC_CLIENT_SECRET must not have leading or trailing whitespace",
    ],
    [
      "trailing CRLF",
      "secret-canary\r\n",
      "OIDC_CLIENT_SECRET must not have leading or trailing whitespace",
    ],
    [
      "leading space",
      " secret-canary",
      "OIDC_CLIENT_SECRET must not have leading or trailing whitespace",
    ],
    [
      "leading byte order mark",
      "\uFEFFsecret-canary",
      "OIDC_CLIENT_SECRET must not have leading or trailing whitespace",
    ],
  ])(
    "rejects a blank or padded OIDC_CLIENT_SECRET without echoing it (%s)",
    (_name, value, message) => {
      let thrown: unknown;
      try {
        resolveAuthConfig(productionOidc({ OIDC_CLIENT_SECRET: value }));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(message);
      expect(inspect(thrown)).not.toContain("canary");
    },
  );

  it("defaults OIDC logout to the Cognito-compatible redirect parameter", () => {
    expect(resolveProductionOidc().oidc.logoutRedirectParameter).toBe(
      "logout_uri",
    );
  });

  it("trims and accepts the standard OIDC logout redirect parameter", () => {
    expect(
      resolveProductionOidc({
        OIDC_LOGOUT_REDIRECT_PARAMETER: " post_logout_redirect_uri ",
      }).oidc.logoutRedirectParameter,
    ).toBe("post_logout_redirect_uri");
  });

  it("rejects an unsupported OIDC logout redirect parameter", () => {
    expect(() =>
      resolveAuthConfig(
        productionOidc({ OIDC_LOGOUT_REDIRECT_PARAMETER: "redirect_uri" }),
      ),
    ).toThrow(
      "OIDC_LOGOUT_REDIRECT_PARAMETER must be logout_uri or post_logout_redirect_uri",
    );
  });

  it("retains exact root OIDC endpoint identifiers after validation", () => {
    expect(
      resolveAuthConfig(
        productionOidc({
          OIDC_ISSUER: " https://issuer.example ",
          OIDC_LOGOUT_ENDPOINT: " https://logout.example ",
        }),
      ),
    ).toMatchObject({
      oidc: {
        issuer: "https://issuer.example",
        logoutEndpoint: "https://logout.example",
      },
    });
  });

  it.each([
    [
      "production dev provider",
      { NODE_ENV: "production", AUTH_PROVIDER: "dev" },
      "AUTH_PROVIDER must select an implemented non-Dev provider in production",
    ],
    [
      "HTTP production origin",
      productionOidc({ APP_ORIGIN: "http://example.com" }),
      "OIDC requires HTTPS in production",
    ],
    [
      "HTTP production logout endpoint",
      productionOidc({ OIDC_LOGOUT_ENDPOINT: "http://example.com/logout" }),
      "OIDC requires HTTPS in production",
    ],
    [
      "HTTP production loopback issuer",
      productionOidc({ OIDC_ISSUER: "http://127.0.0.1:8080" }),
      "OIDC requires HTTPS in production",
    ],
    [
      "missing issuer",
      productionOidc({ OIDC_ISSUER: "" }),
      "OIDC_ISSUER must be an HTTP(S) URL without credentials, query, or hash",
    ],
    [
      "issuer query",
      productionOidc({ OIDC_ISSUER: "https://issuer.example?q=1" }),
      "OIDC_ISSUER must be an HTTP(S) URL without credentials, query, or hash",
    ],
    [
      "missing client id",
      productionOidc({ OIDC_CLIENT_ID: " " }),
      "OIDC_CLIENT_ID is required",
    ],
    [
      "TTL below minimum",
      productionOidc({ OIDC_LOGIN_TRANSACTION_TTL_SECONDS: "59" }),
      "OIDC_LOGIN_TRANSACTION_TTL_SECONDS must be between 60 and 600 seconds",
    ],
    [
      "TTL above maximum",
      productionOidc({ OIDC_LOGIN_TRANSACTION_TTL_SECONDS: "601" }),
      "OIDC_LOGIN_TRANSACTION_TTL_SECONDS must be between 60 and 600 seconds",
    ],
  ])("rejects %s", (_label, environment, expected) => {
    expect(() => resolveAuthConfig(environment)).toThrow(expected);
  });

  it.each([
    "ftp://example.com",
    "https://user@example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?query=1",
    "https://example.com/#fragment",
    "not-an-origin",
  ])("rejects unsafe APP_ORIGIN %s", (appOrigin) => {
    expect(() =>
      resolveAuthConfig({ NODE_ENV: "development", APP_ORIGIN: appOrigin }),
    ).toThrow(
      "APP_ORIGIN must be an HTTP(S) origin without credentials, path, query, or hash",
    );
  });

  it.each([
    ["SESSION_ABSOLUTE_TTL_SECONDS", "0"],
    ["SESSION_IDLE_TTL_SECONDS", "1.5"],
    ["SESSION_TOUCH_INTERVAL_SECONDS", "+30"],
    ["SESSION_ABSOLUTE_TTL_SECONDS", "9007199254741"],
  ] as const)("rejects invalid %s value %s", (name, value) => {
    expect(() =>
      resolveAuthConfig({ NODE_ENV: "development", [name]: value }),
    ).toThrow(`${name} must be a positive safe integer number of seconds`);
  });

  it("rejects an idle lifetime greater than the absolute lifetime", () => {
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: "development",
        SESSION_ABSOLUTE_TTL_SECONDS: "60",
        SESSION_IDLE_TTL_SECONDS: "61",
      }),
    ).toThrow(
      "SESSION_IDLE_TTL_SECONDS must not exceed SESSION_ABSOLUTE_TTL_SECONDS",
    );
  });

  it.each(["300", "301"])(
    "rejects touch interval %s at or above the idle lifetime",
    (touchInterval) => {
      expect(() =>
        resolveAuthConfig({
          NODE_ENV: "development",
          SESSION_IDLE_TTL_SECONDS: "300",
          SESSION_TOUCH_INTERVAL_SECONDS: touchInterval,
        }),
      ).toThrow(
        "SESSION_TOUCH_INTERVAL_SECONDS must be less than SESSION_IDLE_TTL_SECONDS",
      );
    },
  );
});
