import { setTimeout as delay } from "node:timers/promises";

import {
  createDeadlineSignal,
  raceOperationAgainstSignal,
} from "./abortable-operation.ts";

const pollIntervalMs = 250;
const defaultTimeoutMs = 30_000;

// Jaeger の応答は外部入力。ここで扱う範囲だけを形として書き、値の判断は下の関数に残す。
type JaegerTag = { key?: unknown; value?: unknown };
type JaegerSpan = {
  operationName?: unknown;
  processID?: unknown;
  tags?: unknown;
};
type JaegerTrace = {
  traceID?: unknown;
  processes?: Record<string, { serviceName?: unknown } | undefined>;
  spans?: unknown;
};

const errorWithMessage = (message: string) => new Error(message);

const tagsContain = (tags: unknown, key: string, value: unknown) =>
  Array.isArray(tags) &&
  (tags as JaegerTag[]).some((tag) => tag?.key === key && tag?.value === value);

const validateTrace = ({
  expectedServerSpanName,
  expectedTraceId,
  requestId,
  serviceName,
  traces,
}: {
  expectedServerSpanName: string;
  expectedTraceId: unknown;
  requestId: unknown;
  serviceName: unknown;
  traces: JaegerTrace[];
}) => {
  const trace = traces.find(
    (candidate) => candidate?.traceID === expectedTraceId,
  );
  if (trace === undefined) {
    throw errorWithMessage(
      "Jaeger response did not contain the expected propagated trace ID.",
    );
  }

  const serviceProcessIds = new Set(
    Object.entries(trace.processes ?? {})
      .filter(([, process]) => process?.serviceName === serviceName)
      .map(([processId]) => processId),
  );
  if (serviceProcessIds.size === 0) {
    throw errorWithMessage(
      "Jaeger trace did not contain the expected service.",
    );
  }

  const serviceSpans: JaegerSpan[] = Array.isArray(trace.spans)
    ? (trace.spans as JaegerSpan[]).filter((span) =>
        serviceProcessIds.has(span?.processID as string),
      )
    : [];
  const serverSpans = serviceSpans.filter((span) =>
    tagsContain(span.tags, "span.kind", "server"),
  );
  if (serverSpans.length === 0) {
    throw errorWithMessage("Jaeger trace did not contain a server span.");
  }
  // SERVER span は HttpInstrumentation の 1 つだけのはず。手書きの span を足し直すと 2 つになり、
  // 計装が外れると 0 になる。どちらもここで止め、計装の脱落を見逃さない。
  if (serverSpans.length !== 1) {
    throw errorWithMessage(
      "Jaeger trace must contain exactly one server span for the service.",
    );
  }
  const [serverSpan] = serverSpans as [JaegerSpan];
  if (!tagsContain(serverSpan.tags, "request.id", requestId)) {
    throw errorWithMessage(
      "Jaeger server span did not contain the expected Request ID.",
    );
  }
  // 名前が "<method> <route>" になっていれば、observer が渡した route を計装が
  // http.route として受け取れている。メソッドだけなら route の受け渡しが切れている。
  if (serverSpan.operationName !== expectedServerSpanName) {
    throw errorWithMessage("Jaeger server span was not named by its route.");
  }

  if (
    !serviceSpans.some(
      (span) =>
        tagsContain(span.tags, "span.kind", "client") &&
        tagsContain(span.tags, "db.system.name", "postgresql"),
    )
  ) {
    throw errorWithMessage(
      "Jaeger trace did not contain a PostgreSQL client span.",
    );
  }

  return trace;
};

const buildTraceQueryUrl = ({
  queryOrigin,
  requestId,
  serviceName,
}: {
  queryOrigin: string | URL;
  requestId: unknown;
  serviceName: string;
}) => {
  const url = new URL("/api/traces", queryOrigin);
  url.searchParams.set("service", serviceName);
  url.searchParams.set("tags", JSON.stringify({ "request.id": requestId }));
  url.searchParams.set("limit", "20");
  url.searchParams.set("lookback", "1h");
  return url;
};

export const waitForJaegerTrace = async ({
  expectedServerSpanName,
  expectedTraceId,
  fetchImpl = globalThis.fetch,
  forbiddenValues = [],
  queryOrigin,
  requestId,
  serviceName,
  signal,
  timeoutMs = defaultTimeoutMs,
}: {
  /** SERVER span に期待する名前。"<method> <route パターン>"（例: "POST /api/projects"）。 */
  expectedServerSpanName: string;
  expectedTraceId: unknown;
  fetchImpl?: typeof globalThis.fetch;
  forbiddenValues?: readonly unknown[];
  queryOrigin: string | URL;
  requestId: unknown;
  serviceName: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  const deadlineSignal = createDeadlineSignal({ signal, timeoutMs });
  let lastValidationError: unknown;

  const throwTimeout = (): never => {
    // 直前の検証失敗をそのまま伝える。包み直すと呼び出し側の判定が変わる。
    throw (
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      lastValidationError ??
      errorWithMessage("Timed out waiting for Jaeger trace.")
    );
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      if (deadlineSignal.cause() === "deadline") throwTimeout();
      const url = buildTraceQueryUrl({ queryOrigin, requestId, serviceName });

      try {
        const payload = await raceOperationAgainstSignal(async () => {
          const response = await fetchImpl(url, {
            signal: deadlineSignal.signal,
          });
          if (!response.ok) return undefined;
          try {
            return (await response.json()) as { data?: unknown } | undefined;
          } catch {
            throw errorWithMessage("Jaeger returned malformed JSON.");
          }
        }, deadlineSignal.signal);

        if (Array.isArray(payload?.data) && payload.data.length > 0) {
          try {
            const trace = validateTrace({
              expectedServerSpanName,
              expectedTraceId,
              requestId,
              serviceName,
              // JSON から起こした値。この先の突き合わせが形を確かめる。
              traces: payload.data as JaegerTrace[],
            });
            const serializedTrace = JSON.stringify(trace);
            if (
              forbiddenValues.some(
                (value) =>
                  typeof value === "string" &&
                  value.length > 0 &&
                  serializedTrace.includes(value),
              )
            ) {
              throw errorWithMessage(
                "Jaeger trace contained forbidden auth material.",
              );
            }
            return trace;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message ===
                "Jaeger trace contained forbidden auth material."
            ) {
              throw error;
            }
            lastValidationError = error;
          }
        }
      } catch (error) {
        if (deadlineSignal.cause() === "workflow") {
          throw deadlineSignal.signal.reason;
        }
        if (deadlineSignal.cause() === "deadline") throwTimeout();
        if (
          error instanceof Error &&
          (error.message === "Jaeger returned malformed JSON." ||
            error.message === "Jaeger trace contained forbidden auth material.")
        ) {
          throw error;
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throwTimeout();
      await delay(Math.min(pollIntervalMs, remainingMs), undefined, { signal });
    }
  } finally {
    deadlineSignal.dispose();
  }
};
