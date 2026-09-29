import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { SpanKind } from "@opentelemetry/api";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { tracing } from "@opentelemetry/sdk-node";
import { afterAll, describe, expect, it } from "vitest";
import {
  createHttpInstrumentationConfig,
  redactQueryString,
} from "./http-instrumentation-config.js";

const authorizationCode = "SECRET_AUTH_CODE";
const authorizationState = "SECRET_STATE";

const loadHttp = createRequire(import.meta.url);

const startIncomingSpanAttributes = (url: string | undefined) =>
  createHttpInstrumentationConfig().startIncomingSpanHook?.({
    url,
  } as IncomingMessage);

// `http` のパッチはプロセスで一度しか適用されないため、計測器はファイル全体で共有する。
const instrumentation = new HttpInstrumentation(
  createHttpInstrumentationConfig(),
);
const http = loadHttp("http") as typeof import("node:http");

afterAll(() => {
  instrumentation.disable();
});

const captureSpans = async (path: string) => {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new tracing.BasicTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  instrumentation.setTracerProvider(provider);

  const server = http.createServer((_request, response) => {
    response.statusCode = 204;
    response.end();
  });

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port, path },
        (response) => {
          response.resume();
          response.on("end", resolve);
        },
      );
      request.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return { port, spans: exporter.getFinishedSpans() };
  } finally {
    await provider.shutdown();
  }
};

describe("createHttpInstrumentationConfig", () => {
  it("keeps OIDC callback credentials out of exported span attributes", async () => {
    const { port, spans } = await captureSpans(
      `/auth/callback?code=${authorizationCode}&state=${authorizationState}`,
    );

    const serverSpan = spans.find((span) => span.kind === SpanKind.SERVER);
    const clientSpan = spans.find((span) => span.kind === SpanKind.CLIENT);
    expect(serverSpan?.attributes["url.path"]).toBe("/auth/callback");
    expect(serverSpan?.attributes["url.query"]).toBe(
      "code=REDACTED&state=REDACTED",
    );
    expect(clientSpan?.attributes["url.full"]).toBe(
      `http://127.0.0.1:${String(port)}/auth/callback?code=REDACTED&state=REDACTED`,
    );
    const exported = JSON.stringify(spans.map((span) => span.attributes));
    expect(exported).not.toContain(authorizationCode);
    expect(exported).not.toContain(authorizationState);
  });

  it("leaves a query-less request without a query attribute", async () => {
    const { spans } = await captureSpans("/healthz");

    const serverSpan = spans.find((span) => span.kind === SpanKind.SERVER);
    expect(serverSpan?.attributes["url.path"]).toBe("/healthz");
    expect(serverSpan?.attributes).not.toHaveProperty("url.query");
  });

  it("redacts every query value while keeping parameter names", () => {
    expect(redactQueryString("code=abc&state=xyz&returnTo=%2Fprojects")).toBe(
      "code=REDACTED&state=REDACTED&returnTo=REDACTED",
    );
    expect(redactQueryString("code=one&code=two")).toBe(
      "code=REDACTED&code=REDACTED",
    );
    expect(redactQueryString("flag")).toBe("flag");
  });

  it("only reports a query attribute when the request carries one", () => {
    expect(startIncomingSpanAttributes("/auth/callback?code=abc")).toEqual({
      "url.query": "code=REDACTED",
    });
    expect(startIncomingSpanAttributes("/auth/callback")).toEqual({});
    expect(startIncomingSpanAttributes("/auth/callback?")).toEqual({});
    expect(startIncomingSpanAttributes(undefined)).toEqual({});
    expect(startIncomingSpanAttributes("/p?token=abc#code=xyz")).toEqual({
      "url.query": "token=REDACTED",
    });
  });
});
