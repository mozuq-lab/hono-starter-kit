import { bootstrapApi } from "./bootstrap.js";
import {
  describeShutdownFailure,
  installShutdownHandlers,
  parseShutdownTimeoutMs,
  type ShutdownSignal,
} from "./shutdown.js";
import type { ApiProcess } from "./api-main.js";

type FatalErrorEvent = "uncaughtException" | "unhandledRejection";

export type RuntimeTarget = {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  on(signal: ShutdownSignal, listener: () => void): unknown;
  on(event: FatalErrorEvent, listener: (error: unknown) => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): void;
  exitCode?: number | string | null | undefined;
};

export type RunApiOptions = {
  environment?: NodeJS.ProcessEnv;
  bootstrap?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<ApiProcess>;
  runtime?: RuntimeTarget;
  logError?: (message: string, error?: unknown) => void;
};

const startupErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown startup error";

const reportError = (message: string, error?: unknown) => {
  if (error === undefined) console.error(message);
  else console.error(message, error);
};

export const runApi = async ({
  environment = process.env,
  bootstrap = bootstrapApi,
  runtime = process,
  logError = reportError,
}: RunApiOptions = {}): Promise<void> => {
  let apiProcess: ApiProcess;
  let timeoutMs: number;
  try {
    timeoutMs = parseShutdownTimeoutMs(environment.SHUTDOWN_TIMEOUT_MS);
    apiProcess = await bootstrap({ environment });
  } catch (error) {
    logError(`API startup failed: ${startupErrorMessage(error)}`);
    runtime.exitCode = 1;
    return;
  }

  // 締切超過やクローズ失敗のあとはイベントループが解放されない可能性があるため、
  // 理由を出力したうえで明示的に非ゼロ終了する。
  // 出力は要約のみ。生のクローズ失敗を渡すと console.error が cause / errors を
  // 再帰展開し、接続先やドライバ診断が外部へ出てしまう。
  const failShutdown = (error: unknown) => {
    logError(`API shutdown failed: ${describeShutdownFailure(error)}`);
    runtime.exit(1);
  };

  const controller = installShutdownHandlers({
    close: () => apiProcess.close(),
    signalTarget: runtime,
    onFailure: failShutdown,
    timeoutMs,
  });

  // 致命エラーもクローズ失敗と同じ扱いにする。生のエラーを渡すと console.error が
  // cause / errors を再帰展開し、ドライバ診断や接続先が外部へ出てしまう。
  const handleFatalError = (message: string) => (error: unknown) => {
    logError(`${message} ${describeShutdownFailure(error)}`);
    void controller.shutdown().then(() => {
      runtime.exit(1);
    }, failShutdown);
  };

  runtime.on("uncaughtException", handleFatalError("Uncaught exception."));
  runtime.on("unhandledRejection", handleFatalError("Unhandled rejection."));
};
