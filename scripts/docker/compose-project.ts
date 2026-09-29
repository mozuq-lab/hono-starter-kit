import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// check:docker と test:db が共有する、使い捨て compose project の実行と後片付け。
// どちらのスクリプトも自前の片付けを持たず、ここを通す。

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

// 実装が子プロセスに求めるのは stdin / stdout / stderr / once / kill だけ。
type SpawnChild = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ChildProcess;

// capture の指定で戻り値の形が変わる。captureStderr のときだけオブジェクト、
// それ以外は標準出力の文字列（capture 無しなら空文字）。
export type RunOptions = {
  capture?: boolean | undefined;
  captureStderr?: boolean | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  // 引数・環境変数・ログに出せない値（ECR の password など）を子プロセスへ渡す唯一の経路。
  // 値は Error の message・cause・付加プロパティのどれにも載せない。
  stdin?: string | undefined;
};

export type CommandOutput = string | { stdout: string; stderr: string };

export type CommandRunner = {
  run(
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ): Promise<CommandOutput>;
  terminateActiveChild(signal: NodeJS.Signals): boolean;
};

export type RunCompose = (
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandOutput>;

export type SignalTarget = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export const createAsyncCommandRunner = ({
  cwd = repositoryRoot,
  spawnChild = spawn,
}: { cwd?: string; spawnChild?: SpawnChild } = {}) => {
  let activeChild: ChildProcess | undefined;

  return {
    async run(
      command: string,
      args: readonly string[],
      {
        capture = false,
        captureStderr = false,
        environment = process.env,
        signal,
        stdin,
      }: RunOptions = {},
    ): Promise<CommandOutput> {
      if (activeChild !== undefined) {
        throw new Error(
          "Cannot start a command while another child is active.",
        );
      }

      let child: ChildProcess;
      const captureOutput = capture || captureStderr;
      const stdinMode = stdin === undefined ? "ignore" : "pipe";
      try {
        child = spawnChild(command, args, {
          cwd,
          env: environment,
          shell: false,
          ...(signal === undefined ? {} : { signal }),
          stdio: captureOutput
            ? [stdinMode, "pipe", captureStderr ? "pipe" : "inherit"]
            : stdin === undefined
              ? "inherit"
              : ["pipe", "inherit", "inherit"],
        });
      } catch {
        throw new Error(`Unable to start ${command}`);
      }
      activeChild = child;

      if (stdin !== undefined && child.stdin !== null) {
        // 子プロセスが stdin を読まずに終わると EPIPE になる。成否は終了コードで判断するので、
        // ここで握りつぶさないと未処理の error でプロセスごと落ちる。
        child.stdin.on("error", () => undefined);
        child.stdin.end(stdin);
      }

      let stdout = "";
      if (captureOutput && child.stdout !== null) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
      }
      let stderr = "";
      if (captureStderr && child.stderr !== null) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (complete: () => void) => {
          if (settled) return;
          settled = true;
          if (activeChild === child) activeChild = undefined;
          complete();
        };

        child.once("error", () => {
          settle(() => reject(new Error(`Unable to start ${command}`)));
        });
        child.once("close", (status, signal) => {
          settle(() => {
            if (status !== 0) {
              const error = new Error(
                signal === null
                  ? `${command} exited with status ${status ?? "unknown"}`
                  : `${command} terminated by ${signal}`,
              );
              Object.defineProperties(error, {
                exitStatus: { value: status },
                ...(captureOutput
                  ? {
                      stdout: { value: stdout.trim() },
                      ...(captureStderr
                        ? { stderr: { value: stderr.trim() } }
                        : {}),
                    }
                  : {}),
              });
              reject(error);
              return;
            }
            if (captureStderr) {
              resolve(
                Object.freeze({
                  stderr: stderr.trim(),
                  stdout: stdout.trim(),
                }),
              );
              return;
            }
            resolve(captureOutput ? stdout.trim() : "");
          });
        });
      });
    },

    terminateActiveChild(signal: NodeJS.Signals) {
      if (activeChild === undefined) return false;
      try {
        return activeChild.kill(signal);
      } catch {
        return false;
      }
    },
  };
};

export const discoverPublishedPort = async ({
  containerPort,
  log,
  runCompose,
  service,
}: {
  containerPort: number;
  log: (message: string) => void;
  runCompose: RunCompose;
  service: string;
}) => {
  const output = await runCompose(["port", service, String(containerPort)], {
    capture: true,
  });
  const match = /:(\d+)$/u.exec(typeof output === "string" ? output : "");
  const port = Number(match?.[1]);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Unable to parse published port for ${service}: ${typeof output === "string" ? output : "(captured object)"}`,
    );
  }

  log(`${service} published on 127.0.0.1:${port}`);
  return port;
};

type BindResult =
  | { error: Error; label: string; port: number }
  | { label: string; port: number; server: ReturnType<typeof createServer> };

const tryBind = (label: string, port: number) =>
  new Promise<BindResult>((resolve) => {
    const server = createServer();
    server.once("error", (error) => resolve({ error, label, port }));
    server.listen(port, "127.0.0.1", () => resolve({ label, port, server }));
  });

const closeServer = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });

export const assertPortsCanRebind = async (
  ports: Record<string, number>,
  log: (message: string) => void,
) => {
  const seenPorts = new Set<number>();
  const entries = Object.entries(ports).filter(([, port]) => {
    if (seenPorts.has(port)) return false;
    seenPorts.add(port);
    return true;
  });
  if (entries.length === 0) {
    log("No published service ports required rebind verification.");
    return;
  }

  const results = await Promise.all(
    entries.map(([label, port]) => tryBind(label, port)),
  );
  const servers = results.flatMap((result) =>
    "server" in result ? [result.server] : [],
  );

  try {
    const failures = results.filter((result) => "error" in result);
    if (failures.length > 0) {
      throw new Error(
        `Released port rebind failed: ${failures
          .map(({ label, port }) => `${label}:${port}`)
          .join(", ")}`,
        { cause: failures.map(({ error }) => error) },
      );
    }
  } finally {
    await Promise.all(servers.map(closeServer));
  }

  log(
    `Released ports rebound successfully: ${entries
      .map(([label, port]) => `${label}:${port}`)
      .join(", ")}`,
  );
};

export class OwnedComposeRunInterrupted extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`Owned Compose run interrupted by ${signal}`);
    this.name = "OwnedComposeRunInterrupted";
    this.signal = signal;
  }
}

// 最初のシグナルだけを扱う。2 つ目以降（Ctrl-C の連打や SIGINT の後の SIGTERM）で
// 後片付けの子プロセスまで止めると、コンテナやポートが残る。
// 後片付けが始まった後のシグナルは記録だけして、片付けを最後まで走らせてから出し直す。
export const createInterruptionGuard = ({
  commandRunner,
  signalTarget,
}: {
  commandRunner: Pick<CommandRunner, "terminateActiveChild">;
  signalTarget: SignalTarget;
}) => {
  let receivedSignal: NodeJS.Signals | undefined;
  let cleanupStarted = false;
  let resolveInterruption: (signal: NodeJS.Signals) => void = () => undefined;
  const interruption = new Promise<NodeJS.Signals>((resolve) => {
    resolveInterruption = resolve;
  });
  const controller = new globalThis.AbortController();

  const receive = (signal: NodeJS.Signals) => {
    if (receivedSignal !== undefined) return;
    receivedSignal = signal;
    if (!cleanupStarted) {
      commandRunner.terminateActiveChild(signal);
      controller.abort();
      resolveInterruption(signal);
    }
  };
  const onSigint = () => receive("SIGINT");
  const onSigterm = () => receive("SIGTERM");
  signalTarget.on("SIGINT", onSigint);
  signalTarget.on("SIGTERM", onSigterm);

  return {
    /** 中断で abort される。workflow の子プロセスと待機に渡す。 */
    signal: controller.signal,
    /** 後片付けの前に届いた最初のシグナルで resolve する。 */
    interruption,
    receivedSignal: () => receivedSignal,
    throwIfInterrupted() {
      if (receivedSignal !== undefined) {
        throw new OwnedComposeRunInterrupted(receivedSignal);
      }
    },
    startCleanup() {
      cleanupStarted = true;
    },
    dispose() {
      signalTarget.off("SIGINT", onSigint);
      signalTarget.off("SIGTERM", onSigterm);
    },
  };
};

const includesFailure = (
  failures: readonly unknown[],
  candidate: unknown,
): boolean =>
  failures.some(
    (failure) =>
      failure === candidate ||
      (failure instanceof AggregateError &&
        includesFailure(failure.errors, candidate)),
  );

export const appendDistinctFailures = (
  failures: unknown[],
  candidate: unknown,
) => {
  if (candidate instanceof AggregateError) {
    for (const nestedFailure of candidate.errors) {
      appendDistinctFailures(failures, nestedFailure);
    }
    return;
  }
  if (!includesFailure(failures, candidate)) failures.push(candidate);
};

export const combineFailures = (
  failures: readonly unknown[],
  label: string,
) => {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(
    failures,
    `${label} produced ${failures.length} failures`,
    { cause: failures[0] },
  );
};

// 失敗しても次へ進み、失敗は failures に積む。down が失敗してもポートの確認は行う。
export const tearDownComposeProject = async ({
  assertPortsCanRebind: assertPorts,
  failures,
  log,
  ports,
  projectName,
  removeLocalImages = false,
  runCompose,
}: {
  assertPortsCanRebind: (ports: Record<string, number>) => Promise<void>;
  failures: unknown[];
  log: (message: string) => void;
  ports: Record<string, number>;
  projectName: string;
  /** compose が build したイメージも消す。pull したイメージは共有のキャッシュなので残す。 */
  removeLocalImages?: boolean;
  runCompose: RunCompose;
}) => {
  try {
    await runCompose([
      "down",
      "-v",
      "--remove-orphans",
      ...(removeLocalImages ? ["--rmi", "local"] : []),
    ]);
    log(`Removed isolated Compose project ${projectName}`);
  } catch (error) {
    appendDistinctFailures(failures, error);
  }

  try {
    await assertPorts(ports);
  } catch (error) {
    appendDistinctFailures(failures, error);
  }
};

// 中断されたときは、失敗を報告してからシグナルを出し直す。親のシェルに
// 「シグナルで終わった」と伝えるためで、終了コード 1 に置き換えない。
export const finishOwnedRun = ({
  failures,
  label,
  receivedSignal,
  reemitSignal,
  reportFailure,
}: {
  failures: readonly unknown[];
  label: string;
  receivedSignal: NodeJS.Signals | undefined;
  reemitSignal: (signal: NodeJS.Signals) => void;
  reportFailure: (failure: unknown) => void;
}) => {
  const combinedFailure = combineFailures(failures, label);
  if (receivedSignal !== undefined) {
    if (combinedFailure !== undefined) reportFailure(combinedFailure);
    reemitSignal(receivedSignal);
    return;
  }
  // 集約済みの失敗をそのまま伝える。包み直すと呼び出し側の判定が崩れる。
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (combinedFailure !== undefined) throw combinedFailure;
};

/**
 * DB 統合テストの guard（packages/database/src/database-test-support.ts）が受け付ける DB 名。
 * 開発用の `starter` はこの形に当てはまらない。
 */
export const ownedTestDatabaseNamePattern = /^starter_test_[a-f0-9]{16}$/u;

/** ownedTestDatabaseNamePattern に合う DB 名を作る。check:docker と test:db が共有する。 */
export const createOwnedTestDatabaseName = () =>
  `starter_test_${randomBytes(8).toString("hex")}`;

const createdbAttempts = 10;
const createdbRetryDelayMs = 1000;

const stderrOf = (error: unknown) => {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" ? stderr : "";
};

// ポートを通さず、所有する project の postgres コンテナの中で createdb を実行する。
// ポートの解決を誤って開発用の postgres に繋いでも、そこにはこの名前の DB が無いので、
// テストは接続の時点で止まる。
//
// 再試行するのは、compose の healthcheck（コンテナ内の pg_isready）が、entrypoint が初期化中に
// socket だけで動かす一時サーバーで通ってしまい、直後の createdb がその停止に当たることがあるため。
// 再試行で「already exists」が返ったら、前の試行がサーバー側では成功していたとみなす。
// 初回の「already exists」は、一意なはずの名前が既に使われているので止める。
export const createOwnedTestDatabase = async ({
  attempts = createdbAttempts,
  databaseName,
  log,
  retryDelayMs = createdbRetryDelayMs,
  runCompose,
  signal,
  sleep = (milliseconds: number) =>
    delay(milliseconds, undefined, signal === undefined ? {} : { signal }),
}: {
  attempts?: number;
  databaseName: string;
  log: (message: string) => void;
  retryDelayMs?: number;
  runCompose: RunCompose;
  signal?: AbortSignal | undefined;
  sleep?: (milliseconds: number) => Promise<unknown>;
}) => {
  if (!ownedTestDatabaseNamePattern.test(databaseName)) {
    throw new Error(
      "Refusing to create a database that is not an owned test database (starter_test_<16 hex>).",
    );
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      await runCompose(
        ["exec", "-T", "postgres", "createdb", "-U", "starter", databaseName],
        { captureStderr: true, ...(signal === undefined ? {} : { signal }) },
      );
      log(`Created owned test database ${databaseName}`);
      return;
    } catch (error) {
      if (signal?.aborted) throw error;
      const stderr = stderrOf(error);
      if (/already exists/u.test(stderr)) {
        if (attempt === 1) {
          throw new Error(
            `Test database ${databaseName} already exists before this run created it.`,
            { cause: error },
          );
        }
        log(
          `Owned test database ${databaseName} already exists after a retried createdb; the earlier attempt created it.`,
        );
        return;
      }
      if (attempt >= attempts) {
        throw new Error(
          `Unable to create owned test database ${databaseName} after ${attempts} attempts: ${stderr}`,
          { cause: error },
        );
      }
      log(
        `createdb attempt ${attempt} of ${attempts} failed; retrying in ${retryDelayMs} ms`,
      );
      await sleep(retryDelayMs);
    }
  }
};

// down の後に、project のラベルが付いたリソースが本当に消えたかを docker に問い合わせる。
export const verifyNoOwnedComposeResources = async ({
  commandRunner,
  projectName,
}: {
  commandRunner: Pick<CommandRunner, "run">;
  projectName: string;
}) => {
  const filter = `label=com.docker.compose.project=${projectName}`;
  const listings = [
    { kind: "container", args: ["ps", "-aq", "--filter", filter] },
    { kind: "network", args: ["network", "ls", "-q", "--filter", filter] },
    { kind: "volume", args: ["volume", "ls", "-q", "--filter", filter] },
  ];
  const remaining: string[] = [];
  for (const { kind, args } of listings) {
    const output = await commandRunner.run("docker", args, { capture: true });
    if (typeof output === "string" && output.trim() !== "") {
      remaining.push(kind);
    }
  }
  if (remaining.length > 0) {
    throw new Error(
      `Owned Compose resources remain after cleanup: ${remaining.join(", ")} (project ${projectName})`,
    );
  }
};
