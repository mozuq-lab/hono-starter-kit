import { resolveNodeEnvironment } from "./node-environment.js";

export type TelemetryConfig =
  | { enabled: false }
  | { enabled: true; serviceName: string; tracesUrl: string };

const valueOf = (value: string | undefined) => value?.trim() ?? "";

export const resolveTelemetryConfig = (
  environment: NodeJS.ProcessEnv,
): TelemetryConfig => {
  if (resolveNodeEnvironment(environment.NODE_ENV) === "test") {
    return { enabled: false };
  }

  const exporter = valueOf(environment.OTEL_TRACES_EXPORTER);
  if (exporter === "none") return { enabled: false };
  if (exporter !== "" && exporter !== "otlp") {
    throw new Error("OTEL_TRACES_EXPORTER must be otlp or none.");
  }

  const endpoint = valueOf(environment.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (endpoint === "") {
    if (exporter === "otlp") {
      throw new Error(
        "OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_TRACES_EXPORTER=otlp.",
      );
    }
    return { enabled: false };
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute HTTP(S) URL.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute HTTP(S) URL.",
    );
  }

  url.pathname = `${url.pathname.replace(/\/$/u, "")}/v1/traces`;

  const protocol = valueOf(environment.OTEL_EXPORTER_OTLP_PROTOCOL);
  if (protocol !== "" && protocol !== "http/protobuf") {
    throw new Error("OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf.");
  }

  return {
    enabled: true,
    serviceName: valueOf(environment.OTEL_SERVICE_NAME) || "hono-starter-api",
    tracesUrl: url.toString(),
  };
};
