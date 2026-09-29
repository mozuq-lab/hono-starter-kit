export type ShutdownSignal = "SIGINT" | "SIGTERM";

type SignalListener = () => void;

export type SignalTarget = {
  once(signal: ShutdownSignal, listener: SignalListener): unknown;
  on(signal: ShutdownSignal, listener: SignalListener): unknown;
  off(signal: ShutdownSignal, listener: SignalListener): unknown;
};

export type ScheduleTimeout = (
  onTimeout: () => void,
  delayMs: number,
) => () => void;

export type ShutdownController = {
  shutdown: () => Promise<void>;
};

const shutdownSignals: readonly ShutdownSignal[] = ["SIGINT", "SIGTERM"];

const defaultShutdownTimeoutMs = 10_000;
const maximumShutdownTimeoutMs = 600_000;

// クローズ経路で自分たちが組み立てた要約であることの印。
// 印のない下位エラー（ドライバやソケットの生エラー）はメッセージを出さず種別だけを出す。
const shutdownSummary = Symbol("shutdownSummary");

export const markShutdownSummary = <E extends Error>(error: E): E =>
  Object.defineProperty(error, shutdownSummary, { value: true });

const isShutdownSummary = (error: Error) =>
  (error as { [shutdownSummary]?: boolean })[shutdownSummary] === true;

const maximumSummaryDepth = 8;

const failureLabel = (failure: unknown) => {
  if (!(failure instanceof Error)) return typeof failure;
  return isShutdownSummary(failure) ? failure.message : failure.name;
};

const nestedFailures = (failure: Error): readonly unknown[] => {
  if (failure instanceof AggregateError) return failure.errors as unknown[];
  return failure.cause === undefined ? [] : [failure.cause];
};

const summarizeFailure = (
  failure: unknown,
  depth: number,
  seen: Set<unknown>,
): string => {
  const label = failureLabel(failure);
  if (!(failure instanceof Error)) return label;
  if (depth >= maximumSummaryDepth || seen.has(failure)) return label;
  seen.add(failure);

  const nested = nestedFailures(failure).map((cause) =>
    summarizeFailure(cause, depth + 1, seen),
  );

  if (nested.length === 0) return label;
  if (nested.length === 1) return `${label} <- ${String(nested[0])}`;
  return `${label} <- [${nested.join(", ")}]`;
};

// 失敗した段と入れ子の深さは残しつつ、印のない下位エラーのメッセージは外へ出さない。
export const describeShutdownFailure = (failure: unknown): string =>
  summarizeFailure(failure, 0, new Set<unknown>());

const timeoutError = () =>
  new Error(
    `SHUTDOWN_TIMEOUT_MS must be 1-${String(maximumShutdownTimeoutMs)} milliseconds`,
  );

export const parseShutdownTimeoutMs = (rawTimeout: string | undefined) => {
  const value = (rawTimeout ?? "").trim();

  if (value === "") return defaultShutdownTimeoutMs;
  if (!/^[0-9]+$/u.test(value)) throw timeoutError();

  const timeoutMs = Number(value);

  if (timeoutMs < 1 || timeoutMs > maximumShutdownTimeoutMs) {
    throw timeoutError();
  }

  return timeoutMs;
};

// 締切タイマーはプロセスを生かし続けないよう unref する。
const defaultScheduleTimeout: ScheduleTimeout = (onTimeout, delayMs) => {
  const timer = setTimeout(onTimeout, delayMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

export const installShutdownHandlers = ({
  close,
  signalTarget = process,
  onFailure = () => undefined,
  timeoutMs = defaultShutdownTimeoutMs,
  scheduleTimeout = defaultScheduleTimeout,
}: {
  close: () => Promise<void>;
  signalTarget?: SignalTarget;
  onFailure?: (error: unknown) => void;
  timeoutMs?: number;
  scheduleTimeout?: ScheduleTimeout;
}): ShutdownController => {
  let shutdownPromise: Promise<void> | undefined;
  const drainSignal = () => undefined;

  const removeHandlers = () => {
    for (const signal of shutdownSignals) {
      signalTarget.off(signal, beginShutdown);
      signalTarget.off(signal, drainSignal);
    }
  };

  const closeBeforeDeadline = () =>
    new Promise<void>((resolve, reject) => {
      const cancelTimeout = scheduleTimeout(() => {
        reject(
          markShutdownSummary(
            new Error(`API shutdown timed out after ${String(timeoutMs)}ms.`),
          ),
        );
      }, timeoutMs);

      Promise.resolve()
        .then(close)
        .then(resolve, reject)
        .finally(cancelTimeout);
    });

  const shutdown = () => {
    if (shutdownPromise !== undefined) return shutdownPromise;

    for (const signal of shutdownSignals) {
      signalTarget.on(signal, drainSignal);
    }

    shutdownPromise = closeBeforeDeadline().finally(removeHandlers);
    return shutdownPromise;
  };

  function beginShutdown() {
    void shutdown().catch(onFailure);
  }

  for (const signal of shutdownSignals) {
    signalTarget.once(signal, beginShutdown);
  }

  return { shutdown };
};
