import { describe, expect, it } from "vitest";
import { resolveTelemetryConfig } from "./telemetry-config.js";

describe("resolveTelemetryConfig", () => {
  it.each([
    [{ NODE_ENV: " test ", OTEL_TRACES_EXPORTER: "bad" }, { enabled: false }],
    [{ NODE_ENV: "test", OTEL_TRACES_EXPORTER: "bad" }, { enabled: false }],
    [{ NODE_ENV: "development" }, { enabled: false }],
    [
      {
        NODE_ENV: "production",
        OTEL_TRACES_EXPORTER: "none",
        OTEL_EXPORTER_OTLP_ENDPOINT: "not a URL",
      },
      { enabled: false },
    ],
    [
      {
        NODE_ENV: "development",
        OTEL_EXPORTER_OTLP_ENDPOINT: " https://collector.example/base ",
        OTEL_SERVICE_NAME: " api-one ",
      },
      {
        enabled: true,
        serviceName: "api-one",
        tracesUrl: "https://collector.example/base/v1/traces",
      },
    ],
    [
      {
        NODE_ENV: "production",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      },
      {
        enabled: true,
        serviceName: "hono-starter-api",
        tracesUrl: "http://collector:4318/v1/traces",
      },
    ],
  ])("resolves %#", (environment, expected) => {
    expect(resolveTelemetryConfig(environment)).toEqual(expected);
  });

  it.each(["staging", "Production", "", " "])(
    "rejects the unknown environment %s before reading exporter settings",
    (nodeEnv) => {
      expect(() =>
        resolveTelemetryConfig({
          NODE_ENV: nodeEnv,
          OTEL_TRACES_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
        }),
      ).toThrow("NODE_ENV must be development, production, or test");
    },
  );

  it.each([
    [
      { OTEL_TRACES_EXPORTER: "console" },
      "OTEL_TRACES_EXPORTER must be otlp or none.",
    ],
    [
      { OTEL_TRACES_EXPORTER: "otlp" },
      "OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_TRACES_EXPORTER=otlp.",
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: "collector:4318" },
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute HTTP(S) URL.",
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector/traces" },
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute HTTP(S) URL.",
    ],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      },
      "OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf.",
    ],
  ])("rejects %#", (environment, message) => {
    expect(() => resolveTelemetryConfig(environment)).toThrow(message);
  });
});
