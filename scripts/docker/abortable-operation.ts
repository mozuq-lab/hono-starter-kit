import { clearTimeout, setTimeout } from "node:timers";

// 中断の出所。workflow は呼び出し側の signal、deadline はここで張ったタイマー。
type AbortCause = "workflow" | "deadline";

export const createDeadlineSignal = ({
  signal,
  timeoutMs,
}: {
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}) => {
  const controller = new globalThis.AbortController();
  let abortCause: AbortCause | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = (cause: AbortCause, reason: unknown) => {
    if (controller.signal.aborted) return;
    abortCause = cause;
    controller.abort(reason);
  };
  const onWorkflowAbort = () => abort("workflow", signal?.reason);

  if (signal?.aborted) {
    onWorkflowAbort();
  } else {
    signal?.addEventListener("abort", onWorkflowAbort, { once: true });
    timer = setTimeout(
      () => abort("deadline", new Error("Operation deadline exceeded.")),
      Math.max(1, timeoutMs),
    );
  }

  return {
    cause: () => abortCause,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onWorkflowAbort);
    },
    signal: controller.signal,
  };
};

export const raceOperationAgainstSignal = async <Result>(
  operation: () => Result | Promise<Result>,
  signal: AbortSignal,
): Promise<Result> => {
  signal.throwIfAborted();
  // Promise の実行関数の中で必ず代入されるが、TypeScript はそれを追えない。
  // finally での解除に使うので、未代入の可能性を型でも示しておく。
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // signal.reason は呼び出し側が渡すもの。Error とは限らないが、包み直すと
      // 中断理由の判別ができなくなるのでそのまま伝える。
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const operationPromise = Promise.resolve().then(operation);

  try {
    return await Promise.race([operationPromise, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};
