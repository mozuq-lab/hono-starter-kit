import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { startApi } from "./api-main.js";
import { RedactedSecret } from "./redacted-secret.js";
import type {
  RuntimeComposition,
  RuntimeConfiguration,
} from "./runtime-composition.js";

const createFakeDependencies = () => {
  const runtime: RuntimeComposition = {
    app: {} as never,
    close: () => Promise.resolve(),
  };
  const runningServer = { close: () => Promise.resolve() };
  const createRuntime = vi
    .fn<(environment: RuntimeConfiguration) => Promise<RuntimeComposition>>()
    .mockResolvedValue(runtime);
  const startServer = vi
    .fn<
      (options: {
        runtime: RuntimeComposition;
        hostname: string;
        port: number;
      }) => Promise<{ close(): Promise<void> }>
    >()
    .mockResolvedValue(runningServer);

  return { createRuntime, runningServer, runtime, startServer };
};

describe("startApi", () => {
  it("forwards the password secret ARN to runtime database resolution", async () => {
    const dependencies = createFakeDependencies();
    await startApi(
      {
        environment: {
          NODE_ENV: "production",
          PGPASSWORD_SECRET_ARN: "secret-arn-canary",
        },
      },
      dependencies,
    );
    expect(dependencies.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseEnvironment: { PGPASSWORD_SECRET_ARN: "secret-arn-canary" },
      }),
    );
  });

  it("maps the environment onto the runtime configuration", async () => {
    const dependencies = createFakeDependencies();
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PROJECTS_SCENARIO: "empty",
      DATABASE_URL: "postgresql://db/starter",
      MIGRATIONS_DIRECTORY: "/app/migrations",
      AUTH_PROVIDER: "oidc",
      APP_ORIGIN: "https://app.example",
      OIDC_ISSUER: "https://issuer.example",
      OIDC_CLIENT_ID: "public-client-id",
      OIDC_CLIENT_SECRET: "forwarded-oidc-client-secret",
      OIDC_LOGOUT_ENDPOINT: "https://issuer.example/logout",
      OIDC_LOGOUT_REDIRECT_PARAMETER: "post_logout_redirect_uri",
      OIDC_LOGIN_TRANSACTION_TTL_SECONDS: "600",
      SESSION_ABSOLUTE_TTL_SECONDS: "604800",
      SESSION_IDLE_TTL_SECONDS: "86400",
      SESSION_TOUCH_INTERVAL_SECONDS: "300",
      HOST: "0.0.0.0",
      PORT: "3210",
    };

    await startApi({ environment }, dependencies);

    expect(dependencies.createRuntime).toHaveBeenCalledOnce();
    expect(dependencies.createRuntime).toHaveBeenCalledWith({
      nodeEnv: "test",
      databaseEnvironment: { DATABASE_URL: "postgresql://db/starter" },
      migrationsDirectory: "/app/migrations",
      scenario: "empty",
      authProvider: "oidc",
      appOrigin: "https://app.example",
      sessionAbsoluteTtlSeconds: "604800",
      sessionIdleTtlSeconds: "86400",
      sessionTouchIntervalSeconds: "300",
      oidcIssuer: "https://issuer.example",
      oidcClientId: "public-client-id",
      oidcClientSecret: expect.any(RedactedSecret) as RedactedSecret,
      oidcLogoutEndpoint: "https://issuer.example/logout",
      oidcLogoutRedirectParameter: "post_logout_redirect_uri",
      oidcLoginTransactionTtlSeconds: "600",
    });
  });

  it("wraps OIDC_CLIENT_SECRET as soon as it is read so the runtime configuration never holds it raw", async () => {
    const secret = "client-secret-canary~.+:";
    const dependencies = createFakeDependencies();

    await startApi(
      { environment: { NODE_ENV: "test", OIDC_CLIENT_SECRET: secret } },
      dependencies,
    );

    const [configuration] = dependencies.createRuntime.mock.calls[0]!;
    expect(configuration.oidcClientSecret).toBeInstanceOf(RedactedSecret);
    expect(configuration.oidcClientSecret?.reveal()).toBe(secret);
    expect(JSON.stringify(configuration)).not.toContain("canary");
    expect(inspect(configuration, { depth: Infinity })).not.toContain("canary");
  });

  it("leaves the runtime OIDC client secret unset when the environment has none", async () => {
    const dependencies = createFakeDependencies();

    await startApi({ environment: { NODE_ENV: "test" } }, dependencies);

    const [configuration] = dependencies.createRuntime.mock.calls[0]!;
    expect(configuration.oidcClientSecret).toBeUndefined();
  });

  it("derives only the listen address from the environment", async () => {
    const dependencies = createFakeDependencies();

    const api = await startApi(
      { environment: { NODE_ENV: "test", HOST: "0.0.0.0", PORT: "3210" } },
      dependencies,
    );

    expect(dependencies.startServer).toHaveBeenCalledOnce();
    expect(dependencies.startServer).toHaveBeenCalledWith({
      runtime: dependencies.runtime,
      hostname: "0.0.0.0",
      port: 3210,
    });
    expect(api).toBe(dependencies.runningServer);
  });

  it("applies the default listen address when HOST and PORT are absent", async () => {
    const dependencies = createFakeDependencies();

    await startApi({ environment: { NODE_ENV: "test" } }, dependencies);

    expect(dependencies.startServer).toHaveBeenCalledWith({
      runtime: dependencies.runtime,
      hostname: "127.0.0.1",
      port: 3000,
    });
  });

  it("defaults to the process environment", async () => {
    const dependencies = createFakeDependencies();

    await startApi(undefined, dependencies);

    expect(dependencies.createRuntime.mock.calls[0]?.[0]?.nodeEnv).toBe(
      process.env.NODE_ENV,
    );
  });

  it("rejects an invalid listen address before composing the runtime", async () => {
    const dependencies = createFakeDependencies();

    await expect(
      startApi({ environment: { NODE_ENV: "test", PORT: "0" } }, dependencies),
    ).rejects.toThrow("PORT must be 1-65535");
    expect(dependencies.createRuntime).not.toHaveBeenCalled();
    expect(dependencies.startServer).not.toHaveBeenCalled();
  });
});
