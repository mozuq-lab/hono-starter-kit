import { context, ROOT_CONTEXT, type Span } from "@opentelemetry/api";
import { RPCType, setRPCMetadata, type RPCMetadata } from "@opentelemetry/core";
import type { RequestOutcome } from "@starter/backend";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestObserver } from "./request-observer.js";
import {
  createRecordingSpan,
  installTestContextManager,
  withActiveSpan,
} from "./testing/otel-context.js";

let restoreContextManager: () => void;
beforeEach(() => {
  restoreContextManager = installTestContextManager();
});
afterEach(() => {
  restoreContextManager();
});

const capture = () => {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
};

const failedOutcome = (
  overrides: Partial<RequestOutcome> = {},
): RequestOutcome => ({
  requestId: "request_observer",
  method: "PATCH",
  route: "/api/projects/:projectId",
  status: 500,
  durationMs: 12,
  unexpectedError: new TypeError("Cannot read properties of undefined"),
  ...overrides,
});

// HttpInstrumentation が SERVER span を作るときに置く context と同じ形を作る。
const withHttpServerContext = <T>(span: Span, operation: () => T) => {
  const rpcMetadata: RPCMetadata = { type: RPCType.HTTP, span };
  const result = withActiveSpan(
    span,
    operation,
    setRPCMetadata(ROOT_CONTEXT, rpcMetadata),
  );
  return { result, rpcMetadata };
};

describe("createRequestObserver", () => {
  it("writes one JSON line with request ID, trace ID, route pattern, and status but no path, query, or headers", () => {
    const { lines, write } = capture();
    const { span } = createRecordingSpan();

    withHttpServerContext(span, () => {
      createRequestObserver({ write })(failedOutcome());
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toEqual({
      level: "error",
      message: "unexpected error",
      requestId: "request_observer",
      traceId: "0123456789abcdef0123456789abcdef",
      method: "PATCH",
      route: "/api/projects/:projectId",
      status: 500,
      errorName: "TypeError",
      errorMessage: "Cannot read properties of undefined",
      stackFrames: expect.any(Array) as unknown,
    });
  });

  it("writes nothing for an outcome without an unexpected error", () => {
    const { lines, write } = capture();

    createRequestObserver({ write })({
      requestId: "request_ok",
      method: "GET",
      route: "/api/projects",
      status: 404,
      durationMs: 1,
    });

    expect(lines).toEqual([]);
  });

  it("records a thrown undefined as unexpected and omits the trace ID without a span", () => {
    const { lines, write } = capture();

    createRequestObserver({ write })(
      failedOutcome({ unexpectedError: undefined }),
    );

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).not.toHaveProperty("traceId");
    expect(entry).toMatchObject({ errorName: "undefined", stackFrames: [] });
  });

  it("adds an exception event to the active span instead of attributes", () => {
    const { span, events, attributes } = createRecordingSpan();
    const error = new Error("SECRET_CONNECTION_TARGET");

    withHttpServerContext(span, () => {
      createRequestObserver({ write: () => {} })(
        failedOutcome({ unexpectedError: error }),
      );
    });

    expect(attributes).toEqual({});
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("exception");
    expect(Object.keys(events[0]?.attributes ?? {})).toEqual([
      "exception.type",
      "exception.stacktrace",
    ]);
    expect(events[0]?.attributes?.["exception.type"]).toBe("Error");
    expect(JSON.stringify(events)).not.toContain("SECRET_CONNECTION_TARGET");
  });

  it("sets the route on the active HTTP RPC metadata so the server span is named by route", () => {
    const { span } = createRecordingSpan();

    const { rpcMetadata } = withHttpServerContext(span, () => {
      createRequestObserver({ write: () => {} })({
        requestId: "request_ok",
        method: "PATCH",
        route: "/api/projects/:projectId",
        status: 200,
        durationMs: 1,
      });
    });

    expect(rpcMetadata.route).toBe("/api/projects/:projectId");
  });

  it("does not set the route when the outcome route is empty", () => {
    const { span } = createRecordingSpan();

    const { rpcMetadata } = withHttpServerContext(span, () => {
      createRequestObserver({ write: () => {} })({
        requestId: "request_unknown",
        method: "GET",
        route: "",
        status: 404,
        durationMs: 1,
      });
    });

    expect(rpcMetadata).not.toHaveProperty("route");
  });

  it("does nothing to trace state when no context is active", () => {
    expect(() => {
      context.with(ROOT_CONTEXT, () => {
        createRequestObserver({ write: () => {} })(
          failedOutcome({ route: "/api/projects" }),
        );
      });
    }).not.toThrow();
  });
});
