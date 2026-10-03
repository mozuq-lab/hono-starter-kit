import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import {
  createVerifiedIdentity,
  InMemoryAuthSessionStore,
  InMemoryExternalLoginTransactionStore,
  type ExternalIdentityProvider,
  type ExternalLoginTransactionStore,
} from "@starter/backend";
import type { AppType } from "@starter/backend/app-type";
import {
  defaultMigrationsDirectory,
  loadMigrationFiles,
} from "@starter/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateIdentityProvider } from "./composition-root.js";
import { RedactedSecret } from "./redacted-secret.js";
import {
  createRuntimeComposition,
  loadFixturePersistence,
} from "./runtime-composition.js";
import { startServer } from "./server.js";
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

const appliedMigrations = (
  await loadMigrationFiles(defaultMigrationsDirectory)
).map(({ filename, checksum }) => ({ filename, checksum }));

const createFakeDatabaseRuntime = () => {
  const queries: string[] = [];
  const close = vi.fn().mockResolvedValue(undefined);
  const pool = {
    query(sql: string) {
      queries.push(sql.trim());
      return Promise.resolve({
        rows: sql.trim() === "select 1" ? [{}] : appliedMigrations,
      });
    },
  };

  return {
    runtime: { db: {} as never, pool: pool as never, close },
    queries,
    close,
  };
};

const responseCookie = (response: Response): string => {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
};

const createStubIdentityProvider = (): ExternalIdentityProvider => ({
  begin: () =>
    Promise.resolve({
      authorizationUrl: "http://127.0.0.1:4000/authorize?state=stub-state",
      state: "stub-state",
      nonce: "stub-nonce",
      verifier: "stub-verifier",
    }),
  complete: () =>
    Promise.resolve(
      createVerifiedIdentity({
        provider: "stub",
        issuer: "http://127.0.0.1:4000",
        subject: "subject-1",
        email: "user@example.com",
        displayName: "Stub User",
        roles: [],
      }),
    ),
  logoutUrl: () => "http://127.0.0.1:4000/logout",
});

const loopbackOidcConfiguration = {
  authProvider: "oidc",
  appOrigin: "http://127.0.0.1:5173",
  oidcIssuer: "http://127.0.0.1:4000",
  oidcClientId: "public-client-id",
  oidcLogoutEndpoint: "http://127.0.0.1:4000/logout",
};

describe("loadFixturePersistence", () => {
  it("returns the fixture factory from the resolved module", async () => {
    const createFixturePersistence = vi.fn();

    await expect(
      loadFixturePersistence(() =>
        Promise.resolve({ createFixturePersistence }),
      ),
    ).resolves.toBe(createFixturePersistence);
  });

  it("explains that the production runtime bundle omits the fixtures", async () => {
    const missingModule = Object.assign(
      new Error(
        "Cannot find module '/app/fixtures.js' imported from /app/api.mjs",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );

    await expect(
      loadFixturePersistence(() => Promise.reject(missingModule)),
    ).rejects.toThrow(
      "NODE_ENV=test requires development-only fixtures that are excluded from the production runtime bundle",
    );
  });

  it("rethrows a fixture failure that is not a missing module", async () => {
    const failure = new Error("fixture module initialization failed");

    await expect(
      loadFixturePersistence(() => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });
});

describe("createRuntimeComposition", () => {
  it("reaches the identity provider seam from the test composition", async () => {
    const provider = createStubIdentityProvider();
    const createIdentityProvider = vi.fn(() => provider);
    const identityProviderDependencies = { now: () => 1_700_000_000_000 };
    const openDatabase = vi.fn();

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "test",
        databaseEnvironment: {},
        scenario: "empty",
        ...loopbackOidcConfiguration,
      },
      { createIdentityProvider, identityProviderDependencies, openDatabase },
    );

    expect(createIdentityProvider).toHaveBeenCalledOnce();
    expect(createIdentityProvider).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: "http://127.0.0.1:4000" }),
      identityProviderDependencies,
    );
    const login = await runtime.app.request("/auth/login");
    expect(login.headers.get("location")).toBe(
      "http://127.0.0.1:4000/authorize?state=stub-state",
    );
  });

  it("reaches the identity provider seam from the database-backed composition", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const provider = createStubIdentityProvider();
    const createIdentityProvider = vi.fn(() => provider);
    const identityProviderDependencies = { now: () => 1_700_000_000_000 };

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        ...loopbackOidcConfiguration,
      },
      {
        createIdentityProvider,
        identityProviderDependencies,
        openDatabase: () => fakeDatabaseRuntime.runtime,
        createPostgresAuthStore: () => new InMemoryAuthSessionStore(),
        createPostgresExternalLoginTransactionStore: () =>
          new InMemoryExternalLoginTransactionStore(),
      },
    );

    expect(createIdentityProvider).toHaveBeenCalledOnce();
    expect(createIdentityProvider).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: "http://127.0.0.1:4000" }),
      identityProviderDependencies,
    );
    const login = await runtime.app.request("/auth/login");
    expect(login.headers.get("location")).toBe(
      "http://127.0.0.1:4000/authorize?state=stub-state",
    );
    await runtime.close();
  });

  it("never opens postgres and uses memory auth for explicit test scenarios", async () => {
    const openDatabase = vi.fn();
    const resolveDatabase = vi.fn();
    const runtime = await createRuntimeComposition(
      { nodeEnv: "test", databaseEnvironment: {}, scenario: "empty" },
      { openDatabase, resolveDatabase },
    );

    expect(openDatabase).not.toHaveBeenCalled();
    expect(resolveDatabase).not.toHaveBeenCalled();
    const login = await runtime.app.request("/auth/login");
    const cookie = responseCookie(login);
    expect(
      (
        await runtime.app.request("/api/projects", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await runtime.app.request("/api/me", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
  });

  // E2E はこの合成で動く。memory の auth store は起動のたびに空なので、Dev ログインの user を
  // fixture の Alpha の所有者に結び付けておかないと、所有者の絞り込みで Alpha が見えなくなる。
  it("lets the Dev login of the success scenario see the fixture Alpha", async () => {
    const runtime = await createRuntimeComposition({
      nodeEnv: "test",
      databaseEnvironment: {},
      scenario: "success",
    });

    const cookie = responseCookie(await runtime.app.request("/auth/login"));
    const projects = await runtime.app.request("/api/projects", {
      headers: { Cookie: cookie },
    });

    expect(await projects.json()).toEqual({
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
    await runtime.close();
  });

  it("reaches the fixture persistence only through the injected loader", async () => {
    const openDatabase = vi.fn();
    const persistence = {
      repository: {
        list: () => Promise.resolve([]),
        findById: () => Promise.resolve(undefined),
        create: () => Promise.reject(new Error("not used")),
        update: () => Promise.reject(new Error("not used")),
        archive: () => Promise.reject(new Error("not used")),
      },
      unitOfWork: {
        execute: <T>() => Promise.reject<T>(new Error("not used")),
      },
      knownIdentities: [],
    };
    const createFixturePersistence = vi.fn(() => persistence);
    const loadFixturePersistence = vi.fn(() =>
      Promise.resolve(createFixturePersistence),
    );

    const runtime = await createRuntimeComposition(
      { nodeEnv: "test", databaseEnvironment: {}, scenario: "empty" },
      { loadFixturePersistence, openDatabase },
    );

    expect(loadFixturePersistence).toHaveBeenCalledOnce();
    expect(createFixturePersistence).toHaveBeenCalledWith("empty");
    expect(openDatabase).not.toHaveBeenCalled();
    expect((await runtime.app.request("/auth/login")).status).toBe(303);
  });

  it("never loads the fixture persistence outside the test environment", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const loadFixturePersistence = vi.fn();

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      {
        loadFixturePersistence,
        openDatabase: () => fakeDatabaseRuntime.runtime,
        createPostgresAuthStore: () => new InMemoryAuthSessionStore(),
      },
    );

    expect(loadFixturePersistence).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("trims NODE_ENV before selecting explicit test composition", async () => {
    const openDatabase = vi.fn();

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: " test ",
        databaseEnvironment: {},
        scenario: "empty",
      },
      { openDatabase },
    );

    expect(openDatabase).not.toHaveBeenCalled();
    expect((await runtime.app.request("/auth/login")).status).toBe(303);
  });

  it("trims NODE_ENV before opening the development database", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const openDatabase = vi.fn().mockReturnValue(fakeDatabaseRuntime.runtime);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: " development ",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      { openDatabase },
    );

    expect(openDatabase).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("rejects unknown environments before opening postgres", async () => {
    const openDatabase = vi.fn();

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "preview",
          databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        },
        { openDatabase },
      ),
    ).rejects.toThrow("NODE_ENV must be development, production, or test");
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("rejects incomplete OIDC configuration before opening postgres", async () => {
    const openDatabase = vi.fn();

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "development",
          authProvider: "oidc",
          databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        },
        { openDatabase },
      ),
    ).rejects.toThrow(
      "OIDC_ISSUER must be an HTTP(S) URL without credentials, query, or hash",
    );
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("rejects a padded OIDC client secret before opening postgres", async () => {
    const openDatabase = vi.fn();

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "development",
          databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
          ...loopbackOidcConfiguration,
          oidcClientSecret: new RedactedSecret("client-secret-canary\n"),
        },
        { openDatabase },
      ),
    ).rejects.toThrow(
      "OIDC_CLIENT_SECRET must not have leading or trailing whitespace",
    );
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("hands OIDC_CLIENT_SECRET to the identity provider as client_secret_basic without exposing it", async () => {
    const secret = "client-secret-canary~.+:";
    const provider = createStubIdentityProvider();
    const createIdentityProvider = vi.fn<CreateIdentityProvider>(
      () => provider,
    );

    await createRuntimeComposition(
      {
        nodeEnv: "test",
        databaseEnvironment: {},
        scenario: "empty",
        ...loopbackOidcConfiguration,
        oidcClientSecret: new RedactedSecret(secret),
      },
      { createIdentityProvider, openDatabase: vi.fn() },
    );

    const [config] = createIdentityProvider.mock.calls[0]!;
    const { clientAuthentication } = config;
    expect(clientAuthentication.method).toBe("client_secret_basic");
    expect(
      clientAuthentication.method === "client_secret_basic"
        ? clientAuthentication.secret.reveal()
        : undefined,
    ).toBe(secret);
    expect(JSON.stringify(config)).not.toContain("canary");
    expect(inspect(config, { depth: Infinity })).not.toContain("canary");
  });

  it("rejects a cookie-incompatible absolute TTL before opening postgres", async () => {
    const openDatabase = vi.fn();

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "development",
          databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
          sessionAbsoluteTtlSeconds: "34560001",
        },
        { openDatabase },
      ),
    ).rejects.toThrow(
      "SESSION_ABSOLUTE_TTL_SECONDS must not exceed 34560000 seconds (400 days), the cookie Max-Age limit",
    );
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("opens postgres for normal development", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const openDatabase = vi.fn().mockReturnValue(fakeDatabaseRuntime.runtime);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      { openDatabase },
    );

    expect(openDatabase).toHaveBeenCalledOnce();
    expect(openDatabase).toHaveBeenCalledWith({
      connection: {
        mode: "url",
        connectionString: "postgresql://db/starter",
      },
      policy: {
        maxConnections: 5,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5 * 60_000,
        statementTimeoutMillis: 15_000,
        idleInTransactionSessionTimeoutMillis: 30_000,
      },
      onClientError: expect.any(Function) as unknown,
    });
    expect(fakeDatabaseRuntime.queries[0]).toBe("select 1");
    expect(fakeDatabaseRuntime.queries[1]).toContain("from starter_migrations");

    await runtime.close();
    expect(fakeDatabaseRuntime.close).toHaveBeenCalledOnce();
  });

  it("shares one Secrets Manager client with the password provider and destroys it after closing the database", async () => {
    const events: string[] = [];
    const secretClient = {
      send: vi.fn(),
      destroy: vi.fn(() => {
        events.push("secret client destroyed");
      }),
    };
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    fakeDatabaseRuntime.close.mockImplementation(() => {
      events.push("database closed");
      return Promise.resolve();
    });
    const resolveDatabase = vi.fn(() =>
      Promise.resolve({
        mode: "url" as const,
        connectionString: "postgresql://db/starter",
      }),
    );

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      {
        createSecretClient: () => secretClient,
        resolveDatabase,
        openDatabase: () => fakeDatabaseRuntime.runtime,
      },
    );

    expect(resolveDatabase).toHaveBeenCalledWith(expect.anything(), {
      secretClient,
    });
    expect(secretClient.destroy).not.toHaveBeenCalled();
    await runtime.close();
    expect(events).toEqual(["database closed", "secret client destroyed"]);
  });

  it("logs a dropped database connection as one JSON line with its SQLSTATE only", async () => {
    const lines: string[] = [];
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    let onClientError: ((error: unknown) => void) | undefined;

    await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      {
        writeLog: (line) => {
          lines.push(line);
        },
        openDatabase: (options) => {
          onClientError = options.onClientError;
          return fakeDatabaseRuntime.runtime;
        },
      },
    );
    onClientError?.(
      Object.assign(
        new Error(
          "terminating connection due to idle-in-transaction timeout db-canary",
        ),
        { code: "25P03", severity: "FATAL" },
      ),
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sqlState: "25P03" });
    expect(lines[0]).not.toContain("canary");
  });

  it("destroys the Secrets Manager client even when closing the database fails", async () => {
    const secretClient = { send: vi.fn(), destroy: vi.fn() };
    const closeFailure = new Error("close failed");
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    fakeDatabaseRuntime.close.mockRejectedValue(closeFailure);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      {
        createSecretClient: () => secretClient,
        openDatabase: () => fakeDatabaseRuntime.runtime,
      },
    );

    await expect(runtime.close()).rejects.toBe(closeFailure);
    expect(secretClient.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    {
      stage: "database resolution",
      overrides: {
        resolveDatabase: () => Promise.reject(new Error("invalid config")),
      },
    },
    {
      stage: "connectivity check",
      overrides: {
        openDatabase: () => ({
          db: {} as never,
          pool: {
            query: () => Promise.reject(new Error("connection refused")),
          } as never,
          close: () => Promise.resolve(),
        }),
      },
    },
  ])(
    "destroys the Secrets Manager client when startup fails at $stage",
    async ({ overrides }) => {
      const secretClient = { send: vi.fn(), destroy: vi.fn() };

      await expect(
        createRuntimeComposition(
          {
            nodeEnv: "development",
            databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
          },
          { createSecretClient: () => secretClient, ...overrides },
        ),
      ).rejects.toThrow();
      expect(secretClient.destroy).toHaveBeenCalledOnce();
    },
  );

  it("forwards an explicit migration directory", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const assertMigrations = vi.fn().mockResolvedValue(undefined);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        migrationsDirectory: "/app/migrations",
      },
      {
        openDatabase: () => fakeDatabaseRuntime.runtime,
        assertMigrations,
      },
    );

    expect(assertMigrations).toHaveBeenCalledWith(
      fakeDatabaseRuntime.runtime.pool,
      "/app/migrations",
    );

    await runtime.close();
    expect(fakeDatabaseRuntime.close).toHaveBeenCalledOnce();
  });

  it("trims a padded migration directory like the migration CLI does", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const assertMigrations = vi.fn().mockResolvedValue(undefined);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        migrationsDirectory: "  /app/migrations  ",
      },
      {
        openDatabase: () => fakeDatabaseRuntime.runtime,
        assertMigrations,
      },
    );

    expect(assertMigrations).toHaveBeenCalledWith(
      fakeDatabaseRuntime.runtime.pool,
      "/app/migrations",
    );
    await runtime.close();
  });

  it("falls back to the default migration directory when the value is blank", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const assertMigrations = vi.fn().mockResolvedValue(undefined);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        migrationsDirectory: "   ",
      },
      {
        openDatabase: () => fakeDatabaseRuntime.runtime,
        assertMigrations,
      },
    );

    expect(assertMigrations).toHaveBeenCalledWith(
      fakeDatabaseRuntime.runtime.pool,
      undefined,
    );
    await runtime.close();
  });

  it("builds the Postgres repository and unit of work from the same opened database", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const repository = {
      list: () => Promise.resolve([]),
      findById: () => Promise.resolve(undefined),
      create: () => Promise.reject(new Error("not used")),
      update: () => Promise.reject(new Error("not used")),
      archive: () => Promise.reject(new Error("not used")),
    };
    const unitOfWork = {
      execute: <T>() => Promise.reject<T>(new Error("not used")),
    };
    const createPostgresRepository = vi.fn(() => repository);
    const createPostgresUnitOfWork = vi.fn(() => unitOfWork);
    const createPostgresAuthStore = vi.fn(() => new InMemoryAuthSessionStore());

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      {
        openDatabase: () => fakeDatabaseRuntime.runtime,
        createPostgresRepository,
        createPostgresUnitOfWork,
        createPostgresAuthStore,
      },
    );

    expect(createPostgresRepository).toHaveBeenCalledWith(
      fakeDatabaseRuntime.runtime.db,
    );
    expect(createPostgresUnitOfWork).toHaveBeenCalledWith(
      fakeDatabaseRuntime.runtime.db,
    );
    expect(createPostgresAuthStore).toHaveBeenCalledWith(
      fakeDatabaseRuntime.runtime.db,
    );
    await runtime.close();
  });

  it("uses the in-memory transaction store for an explicit OIDC test runtime", async () => {
    const fixture = await startOidcFixture({
      claims: {
        sub: "subject-1",
        email: "user@example.com",
        email_verified: true,
      },
    });
    const appOrigin = new URL(fixture.redirectUri).origin;
    const openDatabase = vi.fn();
    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "test",
        databaseEnvironment: {},
        scenario: "empty",
        authProvider: "oidc",
        appOrigin,
        oidcIssuer: fixture.issuer,
        oidcClientId: fixture.clientConfig.clientId,
        oidcLogoutEndpoint: fixture.clientConfig.logoutEndpoint,
        oidcLoginTransactionTtlSeconds: "600",
      },
      { openDatabase },
    );

    const login = await runtime.app.request("/auth/login");
    const transactionCookie = responseCookie(login);
    const callbackUrl = await fixture.authorize(
      new URL(login.headers.get("location")!),
    );
    const callback = await runtime.app.request(callbackUrl, {
      headers: { Cookie: transactionCookie },
    });

    expect(openDatabase).not.toHaveBeenCalled();
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/projects");
    expect(callback.headers.get("set-cookie")).toContain("session=");
  });

  it("forwards the standard OIDC logout redirect parameter to the provider route", async () => {
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
    });
    const appOrigin = new URL(fixture.redirectUri).origin;
    const openDatabase = vi.fn();
    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "test",
        databaseEnvironment: {},
        scenario: "empty",
        authProvider: "oidc",
        appOrigin,
        oidcIssuer: fixture.issuer,
        oidcClientId: fixture.clientConfig.clientId,
        oidcLogoutEndpoint: fixture.clientConfig.logoutEndpoint,
        oidcLogoutRedirectParameter: "post_logout_redirect_uri",
      },
      { openDatabase },
    );

    const response = await runtime.app.request("/auth/provider-logout");
    const location = new URL(response.headers.get("location")!);

    expect(openDatabase).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(location.origin + location.pathname).toBe(
      fixture.clientConfig.logoutEndpoint,
    );
    expect(location.searchParams.get("client_id")).toBe(
      fixture.clientConfig.clientId,
    );
    expect(location.searchParams.get("post_logout_redirect_uri")).toBe(
      new URL("/login", appOrigin).toString(),
    );
    expect(location.searchParams.has("logout_uri")).toBe(false);
  });

  it.each([
    [
      "the registered secret",
      "fixture~secret.with+plus:colon",
      "/projects",
      [],
    ],
    [
      "a wrong secret",
      "wrong~secret.value+plus:colon",
      "/login?error=authentication_failed&returnTo=%2Fprojects",
      ["auth.external-login-callback.provider"],
    ],
  ])(
    "logs in as a confidential client with %s without logging the secret",
    async (_name, configuredSecret, expectedLocation, expectedOperations) => {
      const registeredSecret = "fixture~secret.with+plus:colon";
      const fixture = await startOidcFixture({
        claims: { sub: "subject-1" },
        clientSecret: new RedactedSecret(registeredSecret),
      });
      const logLines: string[] = [];
      const runtime = await createRuntimeComposition(
        {
          nodeEnv: "test",
          databaseEnvironment: {},
          scenario: "empty",
          authProvider: "oidc",
          appOrigin: new URL(fixture.redirectUri).origin,
          oidcIssuer: fixture.issuer,
          oidcClientId: fixture.clientConfig.clientId,
          oidcClientSecret: new RedactedSecret(configuredSecret),
          oidcLogoutEndpoint: fixture.clientConfig.logoutEndpoint,
        },
        {
          openDatabase: vi.fn(),
          writeLog: (line) => {
            logLines.push(line);
          },
        },
      );

      const login = await runtime.app.request("/auth/login");
      const callbackUrl = await fixture.authorize(
        new URL(login.headers.get("location")!),
      );
      const callback = await runtime.app.request(callbackUrl, {
        headers: { Cookie: responseCookie(login) },
      });

      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe(expectedLocation);
      expect(fixture.requestCounts.token).toBe(1);
      // 設定の誤り（シークレットの違い）が、IdP の段階の失敗として運用者に見える。
      expect(
        logLines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry.message === "suppressed error")
          .map((entry) => entry.operation),
      ).toEqual(expectedOperations);
      const logged = logLines.join("\n");
      for (const secret of [registeredSecret, configuredSecret]) {
        for (const form of clientSecretWireForms({
          clientId: fixture.clientConfig.clientId,
          secret,
        })) {
          expect(logged).not.toContain(form);
        }
      }
    },
  );

  it("logs an unsupported client authentication method by error name without the message or secret", async () => {
    const secret = "fixture~secret.with+plus:colon";
    const fixture = await startOidcFixture({
      claims: { sub: "subject-1" },
      clientSecret: new RedactedSecret(secret),
      tokenEndpointAuthMethodsSupported: ["client_secret_post"],
    });
    const logLines: string[] = [];
    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "test",
        databaseEnvironment: {},
        scenario: "empty",
        authProvider: "oidc",
        appOrigin: new URL(fixture.redirectUri).origin,
        oidcIssuer: fixture.issuer,
        oidcClientId: fixture.clientConfig.clientId,
        oidcClientSecret: new RedactedSecret(secret),
        oidcLogoutEndpoint: fixture.clientConfig.logoutEndpoint,
      },
      {
        openDatabase: vi.fn(),
        writeLog: (line) => {
          logLines.push(line);
        },
      },
    );

    const login = await runtime.app.request("/auth/login");

    expect(login.status).toBe(500);
    const errorLines = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === "error");
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatchObject({
      errorName: "OidcClientAuthenticationUnsupportedError",
    });
    expect(errorLines[0]).not.toHaveProperty("errorMessage");
    const logged = logLines.join("\n");
    for (const form of clientSecretWireForms({
      clientId: fixture.clientConfig.clientId,
      secret,
    })) {
      expect(logged).not.toContain(form);
    }
  });

  it("builds the PostgreSQL transaction store for an OIDC non-test runtime", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const externalLoginTransactionStore =
      new InMemoryExternalLoginTransactionStore();
    const createPostgresExternalLoginTransactionStore = vi.fn<
      (database: never) => ExternalLoginTransactionStore
    >(() => externalLoginTransactionStore);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "production",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        authProvider: "oidc",
        appOrigin: "https://d111111abcdef8.cloudfront.net",
        oidcIssuer:
          "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_pool",
        oidcClientId: "public-client-id",
        oidcLogoutEndpoint:
          "https://starter.auth.ap-northeast-1.amazoncognito.com/logout",
        oidcLoginTransactionTtlSeconds: "600",
      },
      {
        openDatabase: () => fakeDatabaseRuntime.runtime,
        createPostgresAuthStore: () => new InMemoryAuthSessionStore(),
        createPostgresExternalLoginTransactionStore,
      },
    );

    expect(createPostgresExternalLoginTransactionStore).toHaveBeenCalledWith(
      fakeDatabaseRuntime.runtime.db,
    );
    await runtime.close();
  });

  it("returns a usable login cookie in development", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      },
      {
        openDatabase: () => fakeDatabaseRuntime.runtime,
        createPostgresAuthStore: () => new InMemoryAuthSessionStore(),
      },
    );

    const login = await runtime.app.request("/auth/login");
    expect(login.status).toBe(303);
    const cookie = responseCookie(login);
    expect(cookie).toMatch(/^session=[A-Za-z0-9_-]{43}$/);
    const me = await runtime.app.request("/api/me", {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { displayName: "Local Developer" },
    });

    await runtime.close();
  });

  it("rejects unsupported test scenarios without opening postgres", async () => {
    const openDatabase = vi.fn();
    const loadFixturePersistence = vi.fn();

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "test",
          databaseEnvironment: {},
          scenario: "unsupported",
        },
        { openDatabase },
      ),
    ).rejects.toThrow("PROJECTS_SCENARIO must be success, empty, or error");
    expect(openDatabase).not.toHaveBeenCalled();
    expect(loadFixturePersistence).not.toHaveBeenCalled();
  });

  it("closes resources and redacts driver diagnostics when connectivity fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const openDatabase = vi.fn().mockReturnValue({
      db: {} as never,
      pool: {
        query: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "password failed for postgres://user:secret@db/starter; select 1",
            ),
          ),
      } as never,
      close,
    });

    let thrown: unknown;
    try {
      await createRuntimeComposition(
        {
          nodeEnv: "development",
          databaseEnvironment: {
            DATABASE_URL: "postgresql://user:secret@db/starter",
          },
        },
        { openDatabase },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Unable to connect to PostgreSQL. Check database availability and configuration.",
    );
    expect((thrown as Error).message).not.toContain("secret");
    expect((thrown as Error).message).not.toContain("select 1");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes resources when migration validation fails", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const migrationFailure = new Error("safe migration guidance");

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "development",
          databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        },
        {
          openDatabase: () => fakeDatabaseRuntime.runtime,
          assertMigrations: () => Promise.reject(migrationFailure),
        },
      ),
    ).rejects.toBe(migrationFailure);
    expect(fakeDatabaseRuntime.close).toHaveBeenCalledOnce();
  });

  it("keeps the startup failure when closing the opened resources also fails", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const cleanupFailure = new Error("cleanup exposes driver details");
    const close = vi.fn().mockRejectedValue(cleanupFailure);
    const migrationFailure = new Error("safe migration guidance");

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "development",
          databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        },
        {
          openDatabase: () => ({ ...fakeDatabaseRuntime.runtime, close }),
          assertMigrations: () => Promise.reject(migrationFailure),
        },
      ),
    ).rejects.toBe(migrationFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the connectivity failure when closing the opened resources also fails", async () => {
    const cleanupFailure = new Error("cleanup exposes driver details");
    const close = vi.fn().mockRejectedValue(cleanupFailure);

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "development",
          databaseEnvironment: {
            DATABASE_URL: "postgresql://user:secret@db/starter",
          },
        },
        {
          openDatabase: () => ({
            db: {} as never,
            pool: {
              query: () => Promise.reject(new Error("connection refused")),
            } as never,
            close,
          }),
        },
      ),
    ).rejects.toThrow(
      "Unable to connect to PostgreSQL. Check database availability and configuration.",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes resources exactly once when auth adapter construction fails", async () => {
    const fakeDatabaseRuntime = createFakeDatabaseRuntime();
    const authFailure = new Error("auth adapter construction failed");

    await expect(
      createRuntimeComposition(
        {
          nodeEnv: "development",
          databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
        },
        {
          openDatabase: () => fakeDatabaseRuntime.runtime,
          createPostgresAuthStore: () => {
            throw authFailure;
          },
        },
      ),
    ).rejects.toBe(authFailure);
    expect(fakeDatabaseRuntime.close).toHaveBeenCalledOnce();
  });
});

describe("startServer", () => {
  it("binds the requested host and port and stops HTTP before the database", async () => {
    const events: string[] = [];
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    const runtime = {
      app: {
        fetch,
      } as never,
      close: vi.fn(() => {
        events.push("database");
        return Promise.resolve();
      }),
    };
    let servedOptions:
      | {
          fetch: AppType["fetch"];
          hostname?: string;
          port?: number;
        }
      | undefined;
    const httpServer = Object.assign(new EventEmitter(), {
      close(callback: (error?: Error) => void) {
        events.push("http");
        callback();
      },
    });
    const serveHttp = vi.fn(
      (
        options: {
          fetch: AppType["fetch"];
          hostname?: string;
          port?: number;
        },
        listening: () => void,
      ) => {
        servedOptions = options;
        listening();
        return httpServer as never;
      },
    );

    const server = await startServer(
      { runtime, hostname: "0.0.0.0", port: 3210 },
      { serveHttp },
    );

    expect(servedOptions).toBeDefined();
    if (servedOptions === undefined) {
      throw new Error("serveHttp did not receive server options");
    }
    expect(typeof servedOptions.fetch).toBe("function");
    expect(servedOptions.hostname).toBe("0.0.0.0");
    expect(servedOptions.port).toBe(3210);

    await server.close();
    expect(events).toEqual(["http", "database"]);
  });

  // SERVER span は HttpInstrumentation が作る 1 つだけにする。ここで包み直すと
  // SERVER span が 2 つになり、check:docker の「ちょうど 1 つ」の確認が計装の脱落を
  // 検出できなくなる。
  it("passes the app fetch to the HTTP server without wrapping it in a second server span", async () => {
    const fetch = vi.fn();
    const runtime = {
      app: { fetch } as never,
      close: vi.fn().mockResolvedValue(undefined),
    };
    let servedFetch: unknown;
    const httpServer = Object.assign(new EventEmitter(), {
      close(callback: (error?: Error) => void) {
        callback();
      },
    });

    const server = await startServer(
      { runtime, hostname: "127.0.0.1", port: 3000 },
      {
        serveHttp: (options, listening) => {
          servedFetch = options.fetch;
          listening();
          return httpServer as never;
        },
      },
    );

    expect(servedFetch).toBe(fetch);
    await server.close();
  });

  it("closes the database when HTTP startup throws", async () => {
    const startupFailure = new Error("address already in use");
    const runtime = {
      app: { fetch: vi.fn() } as never,
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      startServer(
        { runtime, hostname: "127.0.0.1", port: 3000 },
        {
          serveHttp: () => {
            throw startupFailure;
          },
        },
      ),
    ).rejects.toBe(startupFailure);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("closes the database when the HTTP server emits a listen error", async () => {
    const startupFailure = new Error("address already in use");
    const runtime = {
      app: { fetch: vi.fn() } as never,
      close: vi.fn().mockResolvedValue(undefined),
    };
    const httpServer = Object.assign(new EventEmitter(), {
      close(callback: (error?: Error) => void) {
        callback();
      },
    });

    await expect(
      startServer(
        { runtime, hostname: "127.0.0.1", port: 3000 },
        {
          serveHttp: () => {
            queueMicrotask(() => {
              httpServer.emit("error", startupFailure);
            });
            return httpServer as never;
          },
        },
      ),
    ).rejects.toBe(startupFailure);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  describe("close", () => {
    const startRunningServer = async ({
      httpFailure,
      databaseFailure,
    }: {
      httpFailure?: Error;
      databaseFailure?: Error;
    }) => {
      const events: string[] = [];
      const runtime = {
        app: { fetch: vi.fn() } as never,
        close: vi.fn(() => {
          events.push("database");
          return databaseFailure === undefined
            ? Promise.resolve()
            : Promise.reject(databaseFailure);
        }),
      };
      const httpServer = Object.assign(new EventEmitter(), {
        close(callback: (error?: Error) => void) {
          events.push("http");
          callback(httpFailure);
        },
      });
      const server = await startServer(
        { runtime, hostname: "127.0.0.1", port: 3000 },
        {
          serveHttp: (_options, listening) => {
            listening();
            return httpServer as never;
          },
        },
      );

      return { events, runtime, server };
    };

    const closeFailure = async (server: { close(): Promise<void> }) =>
      await server.close().then(
        () => undefined,
        (error: unknown) => error,
      );

    it("reports an HTTP shutdown failure after closing the database", async () => {
      const httpFailure = new Error("http close failed");
      const { events, runtime, server } = await startRunningServer({
        httpFailure,
      });

      const error = await closeFailure(server);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("HTTP shutdown failed");
      expect((error as Error).cause).toBe(httpFailure);
      expect(error).not.toBeInstanceOf(AggregateError);
      expect(runtime.close).toHaveBeenCalledOnce();
      expect(events).toEqual(["http", "database"]);
    });

    it("reports a database shutdown failure after a clean HTTP close", async () => {
      const databaseFailure = new Error("pool drain failed");
      const { events, server } = await startRunningServer({ databaseFailure });

      const error = await closeFailure(server);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Database shutdown failed");
      expect((error as Error).cause).toBe(databaseFailure);
      expect(error).not.toBeInstanceOf(AggregateError);
      expect(events).toEqual(["http", "database"]);
    });

    it("aggregates HTTP and database shutdown failures without losing either", async () => {
      const httpFailure = new Error("http close failed");
      const databaseFailure = new Error("pool drain failed");
      const { server } = await startRunningServer({
        httpFailure,
        databaseFailure,
      });

      const error = await closeFailure(server);

      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe("HTTP and database shutdown failed");
      expect(aggregate.errors).toEqual([httpFailure, databaseFailure]);
      expect(aggregate.cause).toBe(databaseFailure);
    });

    it("replays the first shutdown result for repeated close calls", async () => {
      const httpFailure = new Error("http close failed");
      const databaseFailure = new Error("pool drain failed");
      const { runtime, server } = await startRunningServer({
        httpFailure,
        databaseFailure,
      });

      const [first, second] = await Promise.all([
        closeFailure(server),
        closeFailure(server),
      ]);

      expect(first).toBeInstanceOf(AggregateError);
      expect(second).toBe(first);
      expect(runtime.close).toHaveBeenCalledOnce();
    });
  });
});
