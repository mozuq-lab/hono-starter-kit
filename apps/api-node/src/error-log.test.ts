import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabaseClientErrorReporter,
  createSuppressedErrorReporter,
} from "./error-log.js";
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

describe("createSuppressedErrorReporter", () => {
  it("writes one warn line with the operation and the error summary", () => {
    const { lines, write } = capture();
    const error = new Error("connect ECONNREFUSED 10.1.2.3:5432");

    createSuppressedErrorReporter({ write })({
      operation: "auth.session-cleanup",
      error,
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(entry)).toEqual([
      "level",
      "message",
      "operation",
      "errorName",
      "stackFrames",
    ]);
    expect(entry).toMatchObject({
      level: "warn",
      message: "suppressed error",
      operation: "auth.session-cleanup",
      errorName: "Error",
    });
    expect(lines[0]).not.toContain("10.1.2.3");
    expect(lines[0]).not.toContain("\n");
  });

  it("includes the trace ID only when a span is active", () => {
    const { lines, write } = capture();
    const report = createSuppressedErrorReporter({ write });
    const { span, events } = createRecordingSpan();

    report({ operation: "auth.session-cleanup", error: new TypeError("t") });
    withActiveSpan(span, () => {
      report({ operation: "auth.session-cleanup", error: new TypeError("t") });
    });

    const [withoutSpan, withSpan] = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(withoutSpan).not.toHaveProperty("traceId");
    expect(withSpan).toMatchObject({
      traceId: "0123456789abcdef0123456789abcdef",
      errorMessage: "t",
    });
    // 応答は成功しているので、SERVER span を例外付きに見せない。
    expect(events).toEqual([]);
  });

  it("does not throw when writing the line fails", () => {
    const report = createSuppressedErrorReporter({
      write: () => {
        throw new Error("stdout closed");
      },
    });

    expect(() => {
      report({ operation: "auth.session-cleanup", error: new Error("x") });
    }).not.toThrow();
  });
});

describe("createDatabaseClientErrorReporter", () => {
  it("writes one JSON line with the SQLSTATE but without the driver message or host", () => {
    const { lines, write } = capture();
    const error = Object.assign(
      new Error(
        "terminating connection due to administrator command db-canary.example.internal",
      ),
      { code: "57P01", severity: "FATAL" },
    );

    createDatabaseClientErrorReporter({ write })(error);

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "warn",
      message: "database connection closed",
      errorName: "DatabaseError",
      sqlState: "57P01",
    });
    expect(lines[0]).not.toContain("canary");
    expect(lines[0]).not.toContain("administrator command");
  });

  it("keeps a network reset distinguishable by type only", () => {
    const { lines, write } = capture();
    const error = Object.assign(new Error("read ECONNRESET 10.1.2.3:5432"), {
      code: "ECONNRESET",
    });

    createDatabaseClientErrorReporter({ write })(error);

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ errorName: "Error" });
    expect(entry).not.toHaveProperty("sqlState");
    expect(lines[0]).not.toContain("10.1.2.3");
  });

  it("does not throw when writing the line fails", () => {
    expect(() =>
      createDatabaseClientErrorReporter({
        write: () => {
          throw new Error("stdout closed");
        },
      })(new Error("x")),
    ).not.toThrow();
  });
});
