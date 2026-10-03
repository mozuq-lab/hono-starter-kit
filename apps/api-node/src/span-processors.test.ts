import { SpanStatusCode } from "@opentelemetry/api";
import { tracing } from "@opentelemetry/sdk-node";
import { describe, expect, it } from "vitest";
import { createSpanProcessors } from "./span-processors.js";

const record = async (
  scope: string,
  status: { code: SpanStatusCode; message?: string },
) => {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new tracing.BasicTracerProvider({
    spanProcessors: createSpanProcessors(exporter),
  });
  const span = provider.getTracer(scope).startSpan("pg.query:SELECT");
  span.setStatus(status);
  span.end();
  await provider.forceFlush();
  const [finished] = exporter.getFinishedSpans();
  await provider.shutdown();
  return finished!;
};

describe("createSpanProcessors", () => {
  it("drops the driver message from the status of PostgreSQL client spans", async () => {
    const span = await record("@opentelemetry/instrumentation-pg", {
      code: SpanStatusCode.ERROR,
      message: 'invalid input syntax for type uuid: "user input"',
    });

    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
  });

  it("keeps the status message of spans from other instrumentations", async () => {
    const span = await record("@opentelemetry/instrumentation-http", {
      code: SpanStatusCode.ERROR,
      message: "kept",
    });

    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "kept",
    });
  });

  it("still exports every span through the given exporter", async () => {
    const span = await record("@opentelemetry/instrumentation-pg", {
      code: SpanStatusCode.OK,
    });

    expect(span.name).toBe("pg.query:SELECT");
    expect(span.status).toEqual({ code: SpanStatusCode.OK });
  });
});
