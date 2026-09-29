import console from "node:console";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  assertPortsCanRebind,
  createAsyncCommandRunner,
  createInterruptionGuard,
  createOwnedTestDatabase,
  createOwnedTestDatabaseName,
  discoverPublishedPort,
  finishOwnedRun,
  ownedTestDatabaseNamePattern,
  tearDownComposeProject,
  verifyNoOwnedComposeResources,
  type CommandRunner,
  type RunOptions,
  type SignalTarget,
} from "./docker/compose-project.ts";

// pnpm test:db: 使い捨ての compose project で postgres だけを起動し、その中に一意な DB を作って、
// ホストの vitest から DB 統合テストを実行する。成否や中断に関係なく project を片付ける。

const ownedProjectPattern =
  /^hono-starter-kit-dbtest-[1-9][0-9]*-[a-f0-9]{16}$/u;
const failureLabel = "Database integration tests and cleanup";

// project 名と DB 名の乱数は別々に取る。片方が分かっても、もう片方を推測できないようにする。
export const createOwnedDatabaseTestNames = (pid: number) => ({
  databaseName: createOwnedTestDatabaseName(),
  projectName: `hono-starter-kit-dbtest-${pid}-${randomBytes(8).toString("hex")}`,
});

// vitest の終了コードを保つ。テストの失敗と片付けの失敗が重なったときも、先に起きた方の値を返す。
export const exitCodeOf = (failure: unknown): number => {
  const first: unknown =
    failure instanceof AggregateError ? failure.errors[0] : failure;
  const status = (first as { exitStatus?: unknown } | null)?.exitStatus;
  return typeof status === "number" && Number.isInteger(status) && status > 0
    ? status
    : 1;
};

const connectOnce = async (connectionString: string) => {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2_000,
  });
  // 初期化中のサーバーに切られたとき、未処理の error イベントでプロセスが落ちないようにする。
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1");
  } finally {
    await client.end().catch(() => undefined);
  }
};

// 準備完了は、ホストから TCP で、最終的な資格情報で接続できたことで判断する。
// コンテナ内の pg_isready（compose の healthcheck と up --wait）は使わない。postgres の
// entrypoint は初期化中に unix socket だけで待ち受ける一時サーバーを動かすので、socket に向けた
// pg_isready はその間に「準備完了」と答え、直後に一時サーバーが止まることがある。
// 一時サーバーは TCP で待ち受けないので、TCP で繋がれば最終のサーバーである。
export const waitForPostgresFromHost = async ({
  connect = connectOnce,
  connectionString,
  retryDelayMs = 250,
  signal,
  timeoutMs = 60_000,
}: {
  connect?: (connectionString: string) => Promise<void>;
  connectionString: string;
  retryDelayMs?: number;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    try {
      await connect(connectionString);
      return;
    } catch {
      // 接続エラーの内容は出さない。上限に達したときだけ固定の文で失敗する。
    }
    signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new Error(
        `PostgreSQL did not accept connections from the host within ${timeoutMs} ms.`,
      );
    }
    await delay(
      retryDelayMs,
      undefined,
      signal === undefined ? {} : { signal },
    );
  }
};

export const runDatabaseIntegrationTests = async ({
  assertPortsCanRebind: assertPorts = (ports: Record<string, number>) =>
    assertPortsCanRebind(ports, log),
  commandRunner = createAsyncCommandRunner(),
  databaseName,
  hostEnvironment = process.env,
  log = (message: string) => {
    console.log(message);
  },
  projectName,
  reemitSignal = (signal: NodeJS.Signals) => process.kill(process.pid, signal),
  reportFailure = (failure: unknown) => {
    console.error(failure);
  },
  signalTarget = process,
  waitForPostgres = waitForPostgresFromHost,
}: {
  assertPortsCanRebind?: (ports: Record<string, number>) => Promise<void>;
  commandRunner?: CommandRunner;
  databaseName: string;
  hostEnvironment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  projectName: string;
  reemitSignal?: (signal: NodeJS.Signals) => void;
  reportFailure?: (failure: unknown) => void;
  signalTarget?: SignalTarget;
  waitForPostgres?: (options: {
    connectionString: string;
    signal: AbortSignal;
  }) => Promise<void>;
}) => {
  // 片付けは project 名だけを頼りに消すので、所有する形の名前でなければ何も始めない。
  if (
    !ownedProjectPattern.test(projectName) ||
    !ownedTestDatabaseNamePattern.test(databaseName)
  ) {
    throw new Error(
      "Refusing to run database integration tests without an owned dbtest project and starter_test_<16 hex> database name.",
    );
  }

  const ports: Record<string, number> = {};
  const failures: unknown[] = [];
  let postgresStarted = false;
  const composeEnvironment: NodeJS.ProcessEnv = {
    ...hostEnvironment,
    COMPOSE_PROJECT_NAME: projectName,
    // OS に空きポートを選ばせる。開発用 postgres の 5432 とはぶつからない。
    POSTGRES_PORT: "0",
  };
  const interruption = createInterruptionGuard({ commandRunner, signalTarget });

  // -p で project を明示し、環境変数の上書きに左右されないようにする。
  const runComposeRaw = (args: readonly string[], options?: RunOptions) =>
    commandRunner.run("docker", ["compose", "-p", projectName, ...args], {
      ...options,
      environment: composeEnvironment,
    });
  const runWorkflow = async (
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ) => {
    interruption.throwIfInterrupted();
    const output = await commandRunner.run(command, args, {
      ...options,
      signal: interruption.signal,
    });
    interruption.throwIfInterrupted();
    return output;
  };
  const runComposeWorkflow = (args: readonly string[], options?: RunOptions) =>
    runWorkflow("docker", ["compose", "-p", projectName, ...args], {
      ...options,
      environment: composeEnvironment,
    });

  log(`Using isolated Compose project ${projectName}`);

  try {
    try {
      postgresStarted = true;
      await runComposeWorkflow(["up", "-d", "postgres"]);
      ports.postgres = await discoverPublishedPort({
        containerPort: 5432,
        log,
        runCompose: runComposeWorkflow,
        service: "postgres",
      });

      await waitForPostgres({
        connectionString: `postgresql://starter:starter@127.0.0.1:${ports.postgres}/starter`,
        signal: interruption.signal,
      });
      interruption.throwIfInterrupted();

      await createOwnedTestDatabase({
        databaseName,
        log,
        runCompose: runComposeWorkflow,
        signal: interruption.signal,
      });

      await runWorkflow(
        "pnpm",
        ["exec", "vitest", "--config", "vitest.database.config.ts", "run"],
        {
          environment: {
            ...hostEnvironment,
            DATABASE_URL: `postgresql://starter:starter@127.0.0.1:${ports.postgres}/${databaseName}`,
            STARTER_DATABASE_TEST_NAME: databaseName,
            STARTER_DATABASE_TEST_PROJECT: projectName,
          },
        },
      );
    } catch (error) {
      if (interruption.receivedSignal() === undefined) failures.push(error);
    } finally {
      interruption.startCleanup();

      if (postgresStarted && ports.postgres === undefined) {
        try {
          ports.postgres = await discoverPublishedPort({
            containerPort: 5432,
            log,
            runCompose: runComposeRaw,
            service: "postgres",
          });
        } catch (error) {
          log(
            `Unable to discover postgres port before cleanup: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // postgres のイメージは pull した共有のキャッシュなので消さない（--rmi は付けない）。
      await tearDownComposeProject({
        assertPortsCanRebind: assertPorts,
        failures,
        log,
        ports,
        projectName,
        runCompose: runComposeRaw,
      });

      try {
        await verifyNoOwnedComposeResources({ commandRunner, projectName });
        log(`No containers, networks or volumes remain for ${projectName}`);
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    interruption.dispose();
  }

  finishOwnedRun({
    failures,
    label: failureLabel,
    receivedSignal: interruption.receivedSignal(),
    reemitSignal,
    reportFailure,
  });
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runDatabaseIntegrationTests(
      createOwnedDatabaseTestNames(process.pid),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = exitCodeOf(error);
  }
}
