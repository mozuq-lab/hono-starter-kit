import { spawn, type SpawnOptions } from "node:child_process";
import { get } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { DEFAULT_API_PORT, resolveApiPort } from "../api-port.js";

const API_HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 50;
const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export type ApiScenario = "success" | "empty" | "error";

export type ApiProcess = {
  stop: () => Promise<void>;
};

export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;

type StoppableChild = {
  kill: (signal: NodeJS.Signals) => boolean;
  pid?: number | undefined;
};

type StopDependencies = {
  sendSignal: SignalSender;
  stopTimeoutMs: number;
  waitForPortRelease: () => Promise<void>;
};

export type ExitGuardTarget = {
  once: (event: "exit", listener: () => void) => unknown;
  off: (event: "exit", listener: () => void) => unknown;
};

export { DEFAULT_API_PORT, resolveApiPort };

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const isApiPortFree = (port: number) =>
  new Promise<boolean>((resolve, reject) => {
    const server = createServer();

    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }

      reject(error);
    });
    server.listen(port, API_HOST, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(true);
      });
    });
  });

const assertApiPortFree = async (context: string, port: number) => {
  if (!(await isApiPortFree(port))) {
    throw new Error(
      `Cannot ${context}: ${API_HOST}:${port} is already in use. Stop the process holding it or set E2E_API_PORT to a free port.`,
    );
  }
};

const waitForApiPortRelease = async (port: number) => {
  const deadline = Date.now() + STOP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isApiPortFree(port)) return;
    await delay(POLL_INTERVAL_MS);
  }

  await assertApiPortFree("confirm API process cleanup", port);
};

const waitForExitUntil = (exited: Promise<void>, timeoutMilliseconds: number) =>
  new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMilliseconds);

    void exited.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

// 直接の子は pnpm のスクリプト実行層で、API 本体はさらにその孫にあたる。
// 負の PID を使ってプロセスグループごとシグナルを送らないと孫が残りポートを握り続ける。
export const signalProcessGroup = (
  pid: number,
  signal: NodeJS.Signals,
  sendSignal: SignalSender = (targetPid, targetSignal) => {
    process.kill(targetPid, targetSignal);
  },
): boolean => {
  try {
    sendSignal(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

// detached にした子は親のプロセスグループから外れるため、親が落ちても道連れにならない。
// 親の終了時にグループごと確実に始末してポートの居座りを防ぐ。
export const registerGroupExitGuard = (
  pid: number,
  sendSignal: SignalSender,
  target: ExitGuardTarget,
) => {
  const guard = () => {
    signalProcessGroup(pid, "SIGKILL", sendSignal);
  };

  target.once("exit", guard);

  return () => {
    target.off("exit", guard);
  };
};

export const createStop = (
  child: StoppableChild,
  exited: Promise<void>,
  hasExited: () => boolean,
  { sendSignal, stopTimeoutMs, waitForPortRelease }: StopDependencies,
) => {
  let stopping: Promise<void> | undefined;

  const terminate = (signal: NodeJS.Signals) => {
    const { pid } = child;
    if (pid === undefined || !signalProcessGroup(pid, signal, sendSignal)) {
      child.kill(signal);
    }
  };

  return () => {
    stopping ??= (async () => {
      if (!hasExited()) {
        terminate("SIGTERM");

        if (!(await waitForExitUntil(exited, stopTimeoutMs))) {
          terminate("SIGKILL");
          await exited;
        }
      }

      await waitForPortRelease();
    })();

    return stopping;
  };
};

export const createApiSpawnOptions = ({
  environment,
  port,
  scenario,
}: {
  environment: NodeJS.ProcessEnv;
  port: number;
  scenario: ApiScenario;
}): SpawnOptions => ({
  cwd: WORKSPACE_ROOT,
  detached: true,
  env: {
    ...environment,
    NODE_ENV: "test",
    APP_ORIGIN: "http://127.0.0.1:5173",
    AUTH_PROVIDER: "dev",
    PORT: String(port),
    PROJECTS_SCENARIO: scenario,
  },
  shell: false,
  stdio: ["ignore", "ignore", "pipe"],
});

export type HealthProbe = (
  url: string,
  timeoutMilliseconds: number,
) => Promise<number>;

// 接続プールを使わず毎回新しい接続で確かめる。停止中の前の API は listener を閉じたあとも
// 終了するまで既存の接続に応答するので、使い回すと起動前の次の API を ready と誤認する。
export const probeHealth: HealthProbe = (url, timeoutMilliseconds) =>
  new Promise<number>((resolve, reject) => {
    const request = get(
      url,
      { agent: false, timeout: timeoutMilliseconds },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy(new Error("Health probe timed out."));
    });
    request.once("error", reject);
  });

export const waitForApiReady = async ({
  childExited,
  getExitDescription,
  getSpawnError,
  getStderr,
  url,
  timeoutMs = STARTUP_TIMEOUT_MS,
  probe = probeHealth,
}: {
  childExited: () => boolean;
  getExitDescription: () => string;
  getSpawnError: () => Error | undefined;
  getStderr: () => string;
  url: string;
  timeoutMs?: number;
  probe?: HealthProbe;
}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pollStartedAt = Date.now();
    const spawnError = getSpawnError();
    if (spawnError) {
      throw new Error(`API process failed to spawn: ${spawnError.message}`);
    }
    if (childExited()) {
      throw new Error(
        `API process exited before readiness (${getExitDescription()}).\nstderr:\n${getStderr() || "(empty)"}`,
      );
    }

    const remainingMilliseconds = deadline - Date.now();
    try {
      const status = await probe(
        url,
        Math.max(1, Math.min(POLL_INTERVAL_MS, remainingMilliseconds)),
      );

      if (status === 200) return;
    } catch {
      // 子プロセスの起動中は接続に失敗して当然なので、握りつぶして次の試行へ進む。
    }

    const pauseMilliseconds = Math.min(
      Math.max(0, POLL_INTERVAL_MS - (Date.now() - pollStartedAt)),
      Math.max(0, deadline - Date.now()),
    );
    if (pauseMilliseconds > 0) await delay(pauseMilliseconds);
  }

  throw new Error(
    `API process did not become ready within ${String(timeoutMs)} ms.\nstderr:\n${getStderr() || "(empty)"}`,
  );
};

export async function startApi(scenario: ApiScenario): Promise<ApiProcess> {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error(
      "Cannot start API: process.env.npm_execpath is not set. Run E2E through pnpm.",
    );
  }

  const port = resolveApiPort(process.env);
  await assertApiPortFree("start API process", port);

  const child = spawn(
    process.execPath,
    [npmExecPath, "--filter", "@starter/api-node", "dev"],
    createApiSpawnOptions({ environment: process.env, port, scenario }),
  );

  let stderr = "";
  let spawnError: Error | undefined;
  let childExited = false;
  let exitDescription = "exit code and signal unavailable";
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      childExited = true;
      resolve();
    });
    child.once("exit", (code, signal) => {
      childExited = true;
      exitDescription = `code ${String(code)}, signal ${String(signal)}`;
      resolve();
    });
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const sendSignal: SignalSender = (targetPid, targetSignal) => {
    process.kill(targetPid, targetSignal);
  };
  const releaseExitGuard =
    child.pid === undefined
      ? () => undefined
      : registerGroupExitGuard(child.pid, sendSignal, process);

  const stopChild = createStop(child, exited, () => childExited, {
    sendSignal,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    waitForPortRelease: () => waitForApiPortRelease(port),
  });
  // 停止に失敗したときはグループが生き残っている可能性があるため、
  // 見張りを外さずプロセス終了時の後始末に委ねる。
  const stop = async () => {
    await stopChild();
    releaseExitGuard();
  };

  try {
    await waitForApiReady({
      childExited: () => childExited,
      getExitDescription: () => exitDescription,
      getSpawnError: () => spawnError,
      getStderr: () => stderr.trim(),
      url: `http://${API_HOST}:${port}/healthz`,
    });
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error],
        "API startup failed and cleanup could not be confirmed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }

  return { stop };
}
