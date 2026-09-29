import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { bootstrapApi } from "./bootstrap.js";
import { describeShutdownFailure } from "./shutdown.js";

describe("bootstrapApi", () => {
  it("starts telemetry before loading and starting the API", async () => {
    const events: string[] = [];
    const process = await bootstrapApi({
      environment: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      },
      startTelemetry: () => {
        events.push("telemetry:start");
        return Promise.resolve({
          shutdown: () => {
            events.push("telemetry:stop");
            return Promise.resolve();
          },
        });
      },
      loadApi: () => {
        events.push("api:load");
        return Promise.resolve({
          startApi: () => {
            events.push("api:start");
            return Promise.resolve({
              close: () => {
                events.push("api:stop");
                return Promise.resolve();
              },
            });
          },
        });
      },
    });
    expect(events).toEqual(["telemetry:start", "api:load", "api:start"]);
    await Promise.all([process.close(), process.close()]);
    expect(events).toEqual([
      "telemetry:start",
      "api:load",
      "api:start",
      "api:stop",
      "telemetry:stop",
    ]);
  });

  it("shuts telemetry down when deferred API loading fails", async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    await expect(
      bootstrapApi({
        environment: {},
        startTelemetry: () => Promise.resolve({ shutdown }),
        loadApi: () => Promise.reject(new Error("load failed")),
      }),
    ).rejects.toThrow("load failed");
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("shuts telemetry down when API startup fails", async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    await expect(
      bootstrapApi({
        environment: {},
        startTelemetry: () => Promise.resolve({ shutdown }),
        loadApi: () =>
          Promise.resolve({
            startApi: () => Promise.reject(new Error("startup failed")),
          }),
      }),
    ).rejects.toThrow("startup failed");
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("does not load the API when telemetry configuration is invalid", async () => {
    const loadApi = vi.fn();
    await expect(
      bootstrapApi({
        environment: { OTEL_TRACES_EXPORTER: "otlp" },
        loadApi,
      }),
    ).rejects.toThrow("OTEL_EXPORTER_OTLP_ENDPOINT is required");
    expect(loadApi).not.toHaveBeenCalled();
  });

  it("closes the API before telemetry and aggregates both failures", async () => {
    const events: string[] = [];
    const apiFailure = new Error("API close failed");
    const telemetryFailure = new Error("telemetry shutdown failed");
    const process = await bootstrapApi({
      environment: {},
      startTelemetry: () =>
        Promise.resolve({
          shutdown: () => {
            events.push("telemetry:stop");
            return Promise.reject(telemetryFailure);
          },
        }),
      loadApi: () =>
        Promise.resolve({
          startApi: () =>
            Promise.resolve({
              close: () => {
                events.push("api:stop");
                return Promise.reject(apiFailure);
              },
            }),
        }),
    });

    const error = await process.close().catch((failure: unknown) => failure);

    expect(events).toEqual(["api:stop", "telemetry:stop"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      apiFailure,
      telemetryFailure,
    ]);
  });

  it("names the failing shutdown stage without echoing its exporter error", async () => {
    const telemetryFailure = new Error("connect ECONNREFUSED 10.0.0.1:4318");
    const process = await bootstrapApi({
      environment: {},
      startTelemetry: () =>
        Promise.resolve({
          shutdown: () => Promise.reject(telemetryFailure),
        }),
      loadApi: () =>
        Promise.resolve({
          startApi: () => Promise.resolve({ close: () => Promise.resolve() }),
        }),
    });

    const error = await process.close().catch((failure: unknown) => failure);

    expect(describeShutdownFailure(error)).toBe(
      "Telemetry shutdown failed <- Error",
    );
    expect((error as Error).cause).toBe(telemetryFailure);
  });

  it("names a failing API shutdown stage", async () => {
    const apiFailure = new Error("connect ECONNREFUSED 10.0.0.1:5432");
    const process = await bootstrapApi({
      environment: {},
      startTelemetry: () =>
        Promise.resolve({ shutdown: () => Promise.resolve() }),
      loadApi: () =>
        Promise.resolve({
          startApi: () =>
            Promise.resolve({ close: () => Promise.reject(apiFailure) }),
        }),
    });

    const error = await process.close().catch((failure: unknown) => failure);

    expect(describeShutdownFailure(error)).toBe(
      "API server shutdown failed <- Error",
    );
    expect((error as Error).cause).toBe(apiFailure);
  });

  it("keeps runtime auth probes out of telemetry configuration and startup errors", async () => {
    const probes = Object.fromEntries(
      [
        "state",
        "nonce",
        "verifier",
        "code",
        "token",
        "password",
        "cookie",
        "database-url",
      ].map((label) => [label, `${label}-${randomUUID()}`]),
    );
    const environment = {
      NODE_ENV: "production",
      AUTH_PROVIDER: "oidc",
      DATABASE_URL: `postgresql://starter:${probes.password}@postgres/starter?probe=${probes["database-url"]}`,
      OIDC_ISSUER: `https://issuer.example/${probes.state}`,
      OIDC_CLIENT_ID: probes.token,
      OIDC_LOGOUT_ENDPOINT: `https://issuer.example/logout/${probes.code}`,
      OIDC_TEST_COOKIE_PROBE: probes.cookie,
      OIDC_TEST_NONCE_PROBE: probes.nonce,
      OIDC_TEST_VERIFIER_PROBE: probes.verifier,
    };
    const telemetryConfigs: unknown[] = [];
    const startupFailure = new Error("safe startup failure");

    const thrown = await bootstrapApi({
      environment,
      startTelemetry: (config) => {
        telemetryConfigs.push(config);
        return Promise.resolve({ shutdown: () => Promise.resolve() });
      },
      loadApi: () =>
        Promise.resolve({
          startApi: () => Promise.reject(startupFailure),
        }),
    }).catch((error: unknown) => error);

    expect(thrown).toBe(startupFailure);
    const captured = `${JSON.stringify(telemetryConfigs)}\n${String(thrown)}`;
    for (const probe of Object.values(probes)) {
      expect(captured).not.toContain(probe);
    }
  });

  it("rejects an invalid logout redirect parameter before database startup without echoing it", async () => {
    const invalidParameter = `redirect-${randomUUID()}`;
    const databasePassword = `password-${randomUUID()}`;
    const shutdown = vi.fn(() => Promise.resolve());

    const thrown = await bootstrapApi({
      environment: {
        NODE_ENV: "production",
        AUTH_PROVIDER: "oidc",
        APP_ORIGIN: "https://app.example",
        DATABASE_URL: `postgresql://starter:${databasePassword}@127.0.0.1:1/starter`,
        OIDC_ISSUER: "https://issuer.example",
        OIDC_CLIENT_ID: "public-client-id",
        OIDC_LOGOUT_ENDPOINT: "https://issuer.example/logout",
        OIDC_LOGOUT_REDIRECT_PARAMETER: invalidParameter,
      },
      startTelemetry: () => Promise.resolve({ shutdown }),
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "OIDC_LOGOUT_REDIRECT_PARAMETER must be logout_uri or post_logout_redirect_uri",
    );
    expect(String(thrown)).not.toContain(invalidParameter);
    expect(String(thrown)).not.toContain(databasePassword);
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
