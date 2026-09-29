import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  describeShutdownFailure,
  installShutdownHandlers,
  parseShutdownTimeoutMs,
  type ScheduleTimeout,
} from "./shutdown.js";

const createScheduler = () => {
  const state = {
    cancelled: false,
    delayMs: undefined as number | undefined,
    fire: undefined as (() => void) | undefined,
  };
  const scheduleTimeout: ScheduleTimeout = (onTimeout, delayMs) => {
    state.delayMs = delayMs;
    state.fire = onTimeout;
    return () => {
      state.cancelled = true;
    };
  };
  return { scheduleTimeout, state };
};

describe("installShutdownHandlers", () => {
  it("drains a duplicate same-kind signal while shutdown is pending", async () => {
    const signalTarget = new EventEmitter();
    let finishShutdown: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    const controller = installShutdownHandlers({ signalTarget, close });

    expect(signalTarget.listenerCount("SIGINT")).toBe(1);
    expect(signalTarget.emit("SIGINT")).toBe(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(signalTarget.listenerCount("SIGINT")).toBe(1);
    expect(signalTarget.emit("SIGINT")).toBe(true);
    expect(close).toHaveBeenCalledOnce();

    finishShutdown?.();
    await controller.shutdown();
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("shuts down on SIGTERM", async () => {
    const signalTarget = new EventEmitter();
    const close = vi.fn(() => Promise.resolve());
    installShutdownHandlers({ signalTarget, close });

    expect(signalTarget.emit("SIGTERM")).toBe(true);

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
    });
  });

  it("reports the close failure to onFailure", async () => {
    const signalTarget = new EventEmitter();
    const failure = new Error("database pool close failed");
    const onFailure = vi.fn();
    const controller = installShutdownHandlers({
      signalTarget,
      close: () => Promise.reject(failure),
      onFailure,
    });

    signalTarget.emit("SIGINT");

    await expect(controller.shutdown()).rejects.toBe(failure);
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(failure);
    });
  });

  it("swallows a close failure when no failure handler is installed", async () => {
    const signalTarget = new EventEmitter();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const controller = installShutdownHandlers({
      signalTarget,
      close: () => Promise.reject(new Error("database pool close failed")),
    });

    signalTarget.emit("SIGINT");
    await expect(controller.shutdown()).rejects.toThrow(
      "database pool close failed",
    );
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("returns the same promise for repeated shutdown calls", async () => {
    const close = vi.fn(() => Promise.resolve());
    const controller = installShutdownHandlers({
      signalTarget: new EventEmitter(),
      close,
    });

    const first = controller.shutdown();
    const second = controller.shutdown();

    expect(second).toBe(first);
    await Promise.all([first, second, controller.shutdown()]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails the shutdown when close misses the deadline", async () => {
    const signalTarget = new EventEmitter();
    const onFailure = vi.fn();
    const { scheduleTimeout, state } = createScheduler();
    const controller = installShutdownHandlers({
      signalTarget,
      close: () => new Promise<void>(() => undefined),
      onFailure,
      timeoutMs: 1234,
      scheduleTimeout,
    });

    signalTarget.emit("SIGINT");
    await vi.waitFor(() => {
      expect(state.fire).toBeDefined();
    });
    expect(state.delayMs).toBe(1234);

    state.fire?.();

    await expect(controller.shutdown()).rejects.toThrow(
      "API shutdown timed out after 1234ms.",
    );
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  it("cancels the deadline once close settles", async () => {
    const { scheduleTimeout, state } = createScheduler();
    const controller = installShutdownHandlers({
      signalTarget: new EventEmitter(),
      close: () => Promise.resolve(),
      scheduleTimeout,
    });

    await controller.shutdown();

    expect(state.cancelled).toBe(true);
  });
});

describe("describeShutdownFailure", () => {
  it("keeps the deadline reason it wrote itself", async () => {
    const { scheduleTimeout, state } = createScheduler();
    const onFailure = vi.fn();
    const signalTarget = new EventEmitter();
    installShutdownHandlers({
      signalTarget,
      close: () => new Promise<void>(() => undefined),
      onFailure,
      timeoutMs: 1234,
      scheduleTimeout,
    });

    signalTarget.emit("SIGINT");
    await vi.waitFor(() => {
      expect(state.fire).toBeDefined();
    });
    state.fire?.();

    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledOnce();
    });
    expect(describeShutdownFailure(onFailure.mock.calls[0]?.[0])).toBe(
      "API shutdown timed out after 1234ms.",
    );
  });

  it("reduces an unfamiliar failure to its type", () => {
    expect(
      describeShutdownFailure(new Error("connect ECONNREFUSED 10.0.0.1:5432")),
    ).toBe("Error");
    expect(
      describeShutdownFailure(new TypeError("db.destroy is not a function")),
    ).toBe("TypeError");
    expect(
      describeShutdownFailure("postgresql://starter:hunter2@10.0.0.1:5432"),
    ).toBe("string");
  });

  it("shows how deep an unfamiliar failure chain is without its messages", () => {
    const driver = new Error("connect ECONNREFUSED 10.0.0.1:5432");
    const wrapped = new Error("pool teardown failed", { cause: driver });
    const aggregate = new AggregateError(
      [wrapped, new RangeError("socket hang up")],
      "everything failed",
    );

    expect(describeShutdownFailure(aggregate)).toBe(
      "AggregateError <- [Error <- Error, RangeError]",
    );
  });

  it("terminates on a self-referencing failure chain", () => {
    const looping = new Error("connect ECONNREFUSED 10.0.0.1:5432");
    looping.cause = looping;

    expect(describeShutdownFailure(looping)).toBe("Error <- Error");
  });
});

describe("parseShutdownTimeoutMs", () => {
  it("defaults to a deadline shorter than a typical grace period", () => {
    expect(parseShutdownTimeoutMs(undefined)).toBe(10_000);
    expect(parseShutdownTimeoutMs("  ")).toBe(10_000);
  });

  it("accepts an explicit millisecond deadline", () => {
    expect(parseShutdownTimeoutMs("5000")).toBe(5000);
    expect(parseShutdownTimeoutMs(" 250 ")).toBe(250);
  });

  it("rejects values that are not positive millisecond integers", () => {
    for (const value of ["0", "-1", "1.5", "abc", "600001"]) {
      expect(() => parseShutdownTimeoutMs(value)).toThrow(
        "SHUTDOWN_TIMEOUT_MS must be 1-600000",
      );
    }
  });
});
