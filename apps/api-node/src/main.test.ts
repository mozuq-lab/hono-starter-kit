import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runApi } from "./main.js";
import { startServer } from "./server.js";

class FakeRuntime extends EventEmitter {
  exitCode: number | string | undefined = undefined;
  exit = vi.fn((code: number) => {
    this.exitCode = code;
  });
}

const runWith = async ({
  close = () => Promise.resolve(),
  environment = {},
  bootstrap,
}: {
  close?: () => Promise<void>;
  environment?: NodeJS.ProcessEnv;
  bootstrap?: () => Promise<{ close: () => Promise<void> }>;
} = {}) => {
  const runtime = new FakeRuntime();
  const logError = vi.fn();
  await runApi({
    environment,
    bootstrap: bootstrap ?? (() => Promise.resolve({ close })),
    runtime,
    logError,
  });
  return { logError, runtime };
};

// console.error 相当の展開（cause / errors も辿る）で漏えいを検査する。
const loggedText = (logError: ReturnType<typeof vi.fn>) =>
  logError.mock.calls
    .map((call: unknown[]) =>
      call.map((argument) => inspect(argument, { depth: null })).join(" "),
    )
    .join("\n");

const startFailingServer = ({
  httpFailure,
  databaseFailure,
}: {
  httpFailure?: Error;
  databaseFailure?: Error;
}) => {
  const httpServer = Object.assign(new EventEmitter(), {
    close(callback: (error?: Error) => void) {
      callback(httpFailure);
    },
  });
  return startServer(
    {
      runtime: {
        app: { fetch: vi.fn() } as never,
        close: () =>
          databaseFailure === undefined
            ? Promise.resolve()
            : Promise.reject(databaseFailure),
      },
      hostname: "127.0.0.1",
      port: 3000,
    },
    {
      serveHttp: (_options, listening) => {
        listening();
        return httpServer as never;
      },
    },
  );
};

describe("runApi", () => {
  it("reports why the shutdown failed and exits non-zero", async () => {
    const failure = new Error("database pool close failed");
    const { logError, runtime } = await runWith({
      close: () => Promise.reject(failure),
    });

    runtime.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith("API shutdown failed: Error");
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
    expect(loggedText(logError)).not.toContain("database pool close failed");
  });

  it("keeps driver diagnostics out of a combined shutdown failure log", async () => {
    const databaseFailure = new Error(
      "connect ECONNREFUSED 10.0.0.1:5432 postgresql://starter:hunter2@10.0.0.1:5432/starter",
    );
    const httpFailure = new Error(
      "EADDRINUSE: address already in use 0.0.0.0:3000",
    );
    const server = await startFailingServer({ httpFailure, databaseFailure });
    const { logError, runtime } = await runWith({
      close: () => server.close(),
    });

    runtime.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
    expect(logError).toHaveBeenCalledWith(
      "API shutdown failed: HTTP and database shutdown failed <- [Error, Error]",
    );
    const logged = loggedText(logError);
    for (const secret of [
      "ECONNREFUSED",
      "10.0.0.1:5432",
      "hunter2",
      "EADDRINUSE",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("names the failing resource without echoing its driver message", async () => {
    const databaseFailure = new Error("connect ECONNREFUSED 10.0.0.1:5432");
    const server = await startFailingServer({ databaseFailure });
    const { logError, runtime } = await runWith({
      close: () => server.close(),
    });

    runtime.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
    expect(logError).toHaveBeenCalledWith(
      "API shutdown failed: Database shutdown failed <- Error",
    );
    expect(loggedText(logError)).not.toContain("ECONNREFUSED");
  });

  it("falls back to console.error when no logger is supplied", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fatal = new Error("boom");
    const runtime = new FakeRuntime();
    await runApi({
      environment: {},
      bootstrap: () =>
        Promise.resolve({
          close: () =>
            Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:5432")),
        }),
      runtime,
    });

    runtime.emit("uncaughtException", fatal);

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("Uncaught exception. Error");
      expect(consoleError).toHaveBeenCalledWith("API shutdown failed: Error");
    });
    expect(loggedText(consoleError)).not.toContain("ECONNREFUSED");
  });

  it("summarises an uncaught exception instead of expanding the raw error", async () => {
    const { logError, runtime } = await runWith();
    const fatal = new Error("connect ECONNREFUSED 10.0.0.1:5432", {
      cause: new Error("postgresql://starter:hunter2@10.0.0.1:5432/starter"),
    });

    runtime.emit("uncaughtException", fatal);

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        "Uncaught exception. Error <- Error",
      );
    });
    const logged = loggedText(logError);
    expect(logged).not.toContain("ECONNREFUSED");
    expect(logged).not.toContain("hunter2");
  });

  it("shuts down and exits non-zero on an uncaught exception", async () => {
    const close = vi.fn(() => Promise.resolve());
    const failure = new Error("boom");
    const { logError, runtime } = await runWith({ close });

    runtime.emit("uncaughtException", failure);

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith("Uncaught exception. Error");
      expect(close).toHaveBeenCalledOnce();
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });

  it("shuts down and exits non-zero on an unhandled rejection", async () => {
    const close = vi.fn(() => Promise.resolve());
    const failure = new Error("rejected");
    const { logError, runtime } = await runWith({ close });

    runtime.emit("unhandledRejection", failure, Promise.resolve());

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith("Unhandled rejection. Error");
      expect(close).toHaveBeenCalledOnce();
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });

  it("reports a startup failure without forcing an exit", async () => {
    const { logError, runtime } = await runWith({
      bootstrap: () => Promise.reject(new Error("startup failed")),
    });

    expect(logError).toHaveBeenCalledWith("API startup failed: startup failed");
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.exitCode).toBe(1);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });

  it("reports a startup failure that threw something other than an Error", async () => {
    const bootstrap = vi
      .fn<() => Promise<{ close: () => Promise<void> }>>()
      .mockRejectedValue("postgresql://starter:hunter2@db/starter");
    const { logError, runtime } = await runWith({ bootstrap });

    expect(logError).toHaveBeenCalledWith(
      "API startup failed: Unknown startup error",
    );
    expect(loggedText(logError)).not.toContain("hunter2");
    expect(runtime.exitCode).toBe(1);
  });

  it("fails closed on an invalid shutdown deadline", async () => {
    const bootstrap = vi.fn();
    const { logError, runtime } = await runWith({
      environment: { SHUTDOWN_TIMEOUT_MS: "later" },
      bootstrap,
    });

    expect(bootstrap).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "API startup failed: SHUTDOWN_TIMEOUT_MS must be 1-600000 milliseconds",
    );
    expect(runtime.exitCode).toBe(1);
  });

  it("applies the configured shutdown deadline to a hanging close", async () => {
    const { logError, runtime } = await runWith({
      environment: { SHUTDOWN_TIMEOUT_MS: "1" },
      close: () => new Promise<void>(() => undefined),
    });

    runtime.emit("SIGINT");

    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        "API shutdown failed: API shutdown timed out after 1ms.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });
});
