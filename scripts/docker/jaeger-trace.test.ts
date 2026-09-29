import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { inspect } from "node:util";

import { waitForJaegerTrace } from "./jaeger-trace.ts";

const expectedTraceId = "0123456789abcdef0123456789abcdef";

const tag = (key: string, value: string) => ({ key, type: "string", value });

const validTrace = {
  traceID: expectedTraceId,
  spans: [
    {
      operationName: "POST /api/projects",
      processID: "p1",
      spanID: "1111111111111111",
      tags: [tag("request.id", "request-123"), tag("span.kind", "server")],
      traceID: expectedTraceId,
    },
    {
      operationName: "pg.query:INSERT projects",
      processID: "p1",
      spanID: "2222222222222222",
      tags: [tag("db.system.name", "postgresql"), tag("span.kind", "client")],
      traceID: expectedTraceId,
    },
  ],
  processes: {
    p1: { serviceName: "hono-starter-api", tags: [] },
  },
};

const jsonResponse = (status: number, body: unknown) =>
  new globalThis.Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

const withWatchdog = async <Result>(
  operation: Promise<Result>,
  timeoutMs = 100,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Test watchdog expired.")),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, watchdog]);
  } finally {
    clearTimeout(timer);
  }
};

const defaultOptions = (overrides = {}) => ({
  fetchImpl: () =>
    Promise.resolve().then(() => jsonResponse(200, { data: [validTrace] })),
  expectedTraceId,
  expectedServerSpanName: "POST /api/projects",
  forbiddenValues: [
    "session=RAW_SECRET",
    "RAW_SECRET",
    "Bearer AUTH_PROBE",
    "Docker Created",
  ],
  queryOrigin: "http://127.0.0.1:16686",
  requestId: "request-123",
  serviceName: "hono-starter-api",
  signal: new globalThis.AbortController().signal,
  timeoutMs: 50,
  ...overrides,
});

type Trace = typeof validTrace;

const cloneTrace = (mutate: (trace: Trace) => void) => {
  const trace = globalThis.structuredClone(validTrace);
  mutate(trace);
  return trace;
};

test("returns the exact correlated trace and queries the pinned Jaeger endpoint", async () => {
  let requestedUrl: URL | undefined;
  let requestedSignal: AbortSignal | null | undefined;
  const controller = new globalThis.AbortController();
  const signal = controller.signal;

  const trace = await waitForJaegerTrace(
    defaultOptions({
      fetchImpl(
        input: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) {
        requestedUrl = new URL(input as string | URL);
        requestedSignal = init?.signal;
        return Promise.resolve(jsonResponse(200, { data: [validTrace] }));
      },
      signal,
    }),
  );

  assert.equal(trace.traceID, expectedTraceId);
  assert.equal(requestedUrl?.origin, "http://127.0.0.1:16686");
  assert.equal(requestedUrl?.pathname, "/api/traces");
  assert.equal(requestedUrl?.searchParams.get("service"), "hono-starter-api");
  assert.equal(
    requestedUrl?.searchParams.get("tags"),
    JSON.stringify({ "request.id": "request-123" }),
  );
  assert.equal(requestedUrl?.searchParams.get("limit"), "20");
  assert.equal(requestedUrl?.searchParams.get("lookback"), "1h");
  assert.ok(requestedSignal instanceof globalThis.AbortSignal);
  assert.notEqual(requestedSignal, signal);
  assert.equal(requestedSignal.aborted, false);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  controller.abort();
  assert.equal(requestedSignal.aborted, false);
});

for (const [name, trace, expectedMessage] of [
  [
    "wrong propagated trace ID",
    cloneTrace((candidate) => {
      candidate.traceID = "fedcba9876543210fedcba9876543210";
      for (const span of candidate.spans) span.traceID = candidate.traceID;
    }),
    "Jaeger response did not contain the expected propagated trace ID.",
  ],
  [
    "missing service",
    cloneTrace((candidate) => {
      candidate.processes.p1.serviceName = "other-service";
    }),
    "Jaeger trace did not contain the expected service.",
  ],
  [
    "missing server span",
    cloneTrace((candidate) => {
      candidate.spans[0]!.tags = candidate.spans[0]!.tags.filter(
        ({ key }) => key !== "span.kind",
      );
    }),
    "Jaeger trace did not contain a server span.",
  ],
  [
    "a second server span for the service",
    cloneTrace((candidate) => {
      candidate.spans.push({
        operationName: "HTTP server request",
        processID: "p1",
        spanID: "3333333333333333",
        tags: [tag("request.id", "request-123"), tag("span.kind", "server")],
        traceID: expectedTraceId,
      });
    }),
    "Jaeger trace must contain exactly one server span for the service.",
  ],
  [
    "a server span named by its method only",
    cloneTrace((candidate) => {
      candidate.spans[0]!.operationName = "POST";
    }),
    "Jaeger server span was not named by its route.",
  ],
  [
    "missing Request ID tag",
    cloneTrace((candidate) => {
      candidate.spans[0]!.tags = candidate.spans[0]!.tags.filter(
        ({ key }) => key !== "request.id",
      );
    }),
    "Jaeger server span did not contain the expected Request ID.",
  ],
  [
    "missing PostgreSQL client span",
    cloneTrace((candidate) => {
      candidate.spans[1]!.tags = candidate.spans[1]!.tags.filter(
        ({ key }) => key !== "db.system.name",
      );
    }),
    "Jaeger trace did not contain a PostgreSQL client span.",
  ],
]) {
  test(`reports ${name as string} without returning incomplete evidence`, async () => {
    await assert.rejects(
      waitForJaegerTrace(
        defaultOptions({
          fetchImpl: () =>
            Promise.resolve().then(() => jsonResponse(200, { data: [trace] })),
          timeoutMs: 0,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, expectedMessage);
        return true;
      },
    );
  });
}

test("reports malformed Jaeger JSON without exposing response material", async () => {
  await assert.rejects(
    waitForJaegerTrace(
      defaultOptions({
        fetchImpl: () =>
          Promise.resolve(
            new globalThis.Response("not-json RAW_SECRET", { status: 200 }),
          ),
        timeoutMs: 0,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Jaeger returned malformed JSON.");
      assert.equal(
        inspect(error, { depth: null }).includes("RAW_SECRET"),
        false,
      );
      return true;
    },
  );
});

test("times out while polling when Jaeger has no matching trace", async () => {
  let attempts = 0;

  await assert.rejects(
    waitForJaegerTrace(
      defaultOptions({
        fetchImpl: () => {
          attempts += 1;
          return Promise.resolve(jsonResponse(200, { data: [] }));
        },
        timeoutMs: 10,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Timed out waiting for Jaeger trace.");
      return true;
    },
  );
  assert.ok(attempts >= 1);
});

test("deadline rejects a Jaeger trace request that ignores its signal", async () => {
  await assert.rejects(
    withWatchdog(
      waitForJaegerTrace(
        defaultOptions({
          fetchImpl: () =>
            Promise.resolve().then(() => new Promise(() => undefined)),
          timeoutMs: 5,
        }),
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Timed out waiting for Jaeger trace.");
      return true;
    },
  );
});

test("workflow abort rejects a Jaeger trace request that ignores its signal", async () => {
  const controller = new globalThis.AbortController();
  const workflowError = new Error("workflow interrupted");
  const abortTimer = setTimeout(() => controller.abort(workflowError), 5);

  try {
    await assert.rejects(
      withWatchdog(
        waitForJaegerTrace(
          defaultOptions({
            fetchImpl: () =>
              Promise.resolve().then(() => new Promise(() => undefined)),
            signal: controller.signal,
            timeoutMs: 1_000,
          }),
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error, workflowError);
        return true;
      },
    );
  } finally {
    clearTimeout(abortTimer);
  }
});

test("rejects forbidden trace material with an exact redacted error", async () => {
  const traceWithSecret = cloneTrace((candidate) => {
    candidate.spans[0]!.tags.push(
      tag("http.request.header.authorization", "RAW_SECRET"),
    );
  });

  await assert.rejects(
    waitForJaegerTrace(
      defaultOptions({
        fetchImpl: () =>
          Promise.resolve().then(() =>
            jsonResponse(200, { data: [traceWithSecret] }),
          ),
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Jaeger trace contained forbidden auth material.",
      );
      assert.equal(
        inspect(error, { depth: null }).includes("RAW_SECRET"),
        false,
      );
      return true;
    },
  );
});

test("ignores empty forbidden values", async () => {
  const trace = await waitForJaegerTrace(
    defaultOptions({ forbiddenValues: ["", undefined, null] }),
  );

  assert.equal(trace.traceID, expectedTraceId);
});
