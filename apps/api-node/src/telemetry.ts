import { createRequire } from "node:module";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { createHttpInstrumentationConfig } from "./http-instrumentation-config.js";
import type { TelemetryConfig } from "./telemetry-config.js";

type TelemetrySdk = {
  start(): void | Promise<void>;
  shutdown(): Promise<void>;
};

type TelemetryDependencies = {
  createSdk(config: Extract<TelemetryConfig, { enabled: true }>): TelemetrySdk;
  loadInstrumentedModules(): void;
};

export type TelemetryLifecycle = {
  shutdown(): Promise<void>;
};

const defaultDependencies: TelemetryDependencies = {
  createSdk: (config) =>
    new NodeSDK({
      serviceName: config.serviceName,
      traceExporter: new OTLPTraceExporter({ url: config.tracesUrl }),
      logRecordProcessors: [],
      metricReaders: [],
      textMapPropagator: new W3CTraceContextPropagator(),
      // どちらの計装も既定のままだと機密を載せる。HTTP は受信クエリを url.query に
      // そのまま入れる（OIDC コールバックの認可コードが該当）ので設定で伏せ、
      // pg は enhancedDatabaseReporting を切ってバインド値を落とす。
      instrumentations: [
        new HttpInstrumentation(createHttpInstrumentationConfig()),
        new PgInstrumentation({ enhancedDatabaseReporting: false }),
      ],
    }),
  // HttpInstrumentation は require-in-the-middle で CommonJS の require("http") に掛かり、
  // http.Server.prototype.emit を包む。この prototype は ESM の import "http" と共有なので、
  // CommonJS で 1 回読めば @hono/node-server（ESM）の server にも効く。ESM で動く
  // ランタイム（tsx の開発サーバと、esbuild で ESM に束ねた本番の bundle）では http を
  // require する者がいるとは限らず、これがないと SERVER span が 1 つも出ないことがある。外すと check:docker の Jaeger 確認（SERVER span がちょうど 1 つ）で落ちる。
  loadInstrumentedModules: () => {
    const require = createRequire(import.meta.url);
    require("http");
    require("https");
  },
};

export const startTelemetry = async (
  config: TelemetryConfig,
  overrides: Partial<TelemetryDependencies> = {},
): Promise<TelemetryLifecycle> => {
  if (!config.enabled) return { shutdown: () => Promise.resolve() };

  const dependencies = { ...defaultDependencies, ...overrides };
  const sdk = dependencies.createSdk(config);
  try {
    await sdk.start();
    dependencies.loadInstrumentedModules();
  } catch (error) {
    await sdk.shutdown().catch(() => undefined);
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  return {
    shutdown() {
      shutdownPromise ??= sdk.shutdown();
      return shutdownPromise;
    },
  };
};
