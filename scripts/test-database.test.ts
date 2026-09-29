import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers";

import {
  createOwnedDatabaseTestNames,
  exitCodeOf,
  runDatabaseIntegrationTests,
  waitForPostgresFromHost,
} from "./test-database.ts";

const projectName = "hono-starter-kit-dbtest-4321-a1b2c3d4e5f60708";
const databaseName = "starter_test_0123456789abcdef";
const publishedPort = 55432;

type Call = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
};

const waitFor = async (predicate: () => boolean) => {
  while (!predicate()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

// docker compose port には公開ポートを返し、それ以外は handler に任せる偽の runner。
const createFakeRunner = (
  handler: (call: Call) => Promise<string> | undefined = () => undefined,
  onTerminate: (signal: NodeJS.Signals) => void = () => undefined,
) => {
  const calls: Call[] = [];
  const terminated: NodeJS.Signals[] = [];
  return {
    calls,
    terminated,
    commandRunner: {
      run(
        command: string,
        args: readonly string[],
        options: Record<string, unknown> = {},
      ): Promise<string | { stdout: string; stderr: string }> {
        const call = { args, command, options };
        calls.push(call);
        const handled = handler(call);
        if (handled !== undefined) return handled;
        if (args.includes("port")) {
          return Promise.resolve(`127.0.0.1:${publishedPort}`);
        }
        return Promise.resolve("");
      },
      terminateActiveChild(signal: NodeJS.Signals) {
        terminated.push(signal);
        onTerminate(signal);
        return true;
      },
    },
  };
};

const isVitest = ({ command, args }: Call) =>
  command === "pnpm" && args.includes("vitest");
const isDown = ({ args }: Call) => args.includes("down");
const isCreatedb = ({ args }: Call) => args.includes("createdb");

const defaults = {
  databaseName,
  hostEnvironment: { PATH: "/usr/bin" },
  log: () => undefined,
  projectName,
  reportFailure: () => undefined,
  waitForPostgres: async () => undefined,
};

test("creates the owned database through compose exec on the owned project, not through the published port", async () => {
  const { calls, commandRunner } = createFakeRunner();

  await runDatabaseIntegrationTests({
    ...defaults,
    assertPortsCanRebind: async () => undefined,
    commandRunner,
    signalTarget: new EventEmitter(),
  });

  const createdb = calls.filter(isCreatedb);
  assert.deepEqual(
    createdb.map(({ command, args }) => [command, ...args]),
    [
      [
        "docker",
        "compose",
        "-p",
        projectName,
        "exec",
        "-T",
        "postgres",
        "createdb",
        "-U",
        "starter",
        databaseName,
      ],
    ],
  );
  const environment = createdb[0]?.options.environment as
    Record<string, string> | undefined;
  assert.equal(environment?.COMPOSE_PROJECT_NAME, projectName);
  // ホストから DB を作る経路（psql / createdb の -h・-p）を使っていないこと。
  assert.equal(
    calls.some(
      ({ args }) =>
        args.includes("-h") ||
        args.includes("--host") ||
        args.includes(String(publishedPort)),
    ),
    false,
  );
});

test("starts only postgres, on an OS-assigned port, in the owned project", async () => {
  const { calls, commandRunner } = createFakeRunner();

  await runDatabaseIntegrationTests({
    ...defaults,
    assertPortsCanRebind: async () => undefined,
    commandRunner,
    signalTarget: new EventEmitter(),
  });

  const up = calls.find(({ args }) => args.includes("up"));
  assert.deepEqual(up?.args, [
    "compose",
    "-p",
    projectName,
    "up",
    "-d",
    "postgres",
  ]);
  const environment = up?.options.environment as Record<string, string>;
  assert.equal(environment.POSTGRES_PORT, "0");
  assert.equal(environment.COMPOSE_PROJECT_NAME, projectName);
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(
    calls.every(
      ({ command, args }) =>
        command !== "docker" ||
        args[0] !== "compose" ||
        (args[1] === "-p" && args[2] === projectName),
    ),
    true,
    "every compose command must name the owned project",
  );
});

test("passes a DATABASE_URL whose database is the owned unique name", async () => {
  const { calls, commandRunner } = createFakeRunner();

  await runDatabaseIntegrationTests({
    ...defaults,
    assertPortsCanRebind: async () => undefined,
    commandRunner,
    hostEnvironment: {
      DATABASE_URL: "postgresql://starter:starter@127.0.0.1:5432/starter",
      PATH: "/usr/bin",
    },
    signalTarget: new EventEmitter(),
  });

  const vitest = calls.find(isVitest);
  assert.deepEqual(vitest?.args, [
    "exec",
    "vitest",
    "--config",
    "vitest.database.config.ts",
    "run",
  ]);
  const environment = vitest?.options.environment as Record<string, string>;
  assert.equal(
    environment.DATABASE_URL,
    `postgresql://starter:starter@127.0.0.1:${publishedPort}/${databaseName}`,
  );
  assert.equal(environment.STARTER_DATABASE_TEST_NAME, databaseName);
  assert.equal(environment.STARTER_DATABASE_TEST_PROJECT, projectName);
  assert.equal(environment.PATH, "/usr/bin");
  assert.ok(calls.findIndex(isCreatedb) < calls.findIndex(isVitest));
});

test("waits for a TCP connection from the host instead of trusting pg_isready inside the container", async () => {
  const events: string[] = [];
  const { calls, commandRunner } = createFakeRunner((call) => {
    if (isCreatedb(call)) events.push("createdb");
    return undefined;
  });

  await runDatabaseIntegrationTests({
    ...defaults,
    assertPortsCanRebind: async () => undefined,
    commandRunner,
    signalTarget: new EventEmitter(),
    waitForPostgres: async ({ connectionString, signal }) => {
      assert.ok(signal instanceof AbortSignal);
      events.push(`wait ${connectionString}`);
    },
  });

  assert.deepEqual(events, [
    `wait postgresql://starter:starter@127.0.0.1:${publishedPort}/starter`,
    "createdb",
  ]);
  assert.equal(
    calls.some(({ args }) => args.includes("--wait")),
    false,
    "compose --wait trusts the in-container pg_isready healthcheck",
  );
  assert.equal(
    calls.some(({ args }) => args.includes("pg_isready")),
    false,
  );
});

test("runs down -v --remove-orphans and asserts the published port is free after a passing run", async () => {
  const events: string[] = [];
  const { calls, commandRunner } = createFakeRunner((call) => {
    if (isVitest(call)) events.push("vitest");
    if (isDown(call)) events.push("down");
    if (call.args[0] === "ps") events.push("residual check");
    return undefined;
  });

  await runDatabaseIntegrationTests({
    ...defaults,
    assertPortsCanRebind: async (ports) => {
      events.push(`rebind ${JSON.stringify(ports)}`);
    },
    commandRunner,
    signalTarget: new EventEmitter(),
  });

  assert.deepEqual(events, [
    "vitest",
    "down",
    `rebind {"postgres":${publishedPort}}`,
    "residual check",
  ]);
  assert.deepEqual(calls.find(isDown)?.args, [
    "compose",
    "-p",
    projectName,
    "down",
    "-v",
    "--remove-orphans",
  ]);
});

test("cleans up after a failing run and preserves the test exit code", async () => {
  const vitestFailure = new Error("pnpm exited with status 1");
  Object.defineProperty(vitestFailure, "exitStatus", { value: 1 });
  const events: string[] = [];
  const { commandRunner } = createFakeRunner((call) => {
    if (isVitest(call)) return Promise.reject(vitestFailure);
    if (isDown(call)) events.push("down");
    return undefined;
  });

  await assert.rejects(
    runDatabaseIntegrationTests({
      ...defaults,
      assertPortsCanRebind: async () => {
        events.push("rebind");
      },
      commandRunner,
      signalTarget: new EventEmitter(),
    }),
    (error) => {
      assert.equal(error, vitestFailure);
      assert.equal(exitCodeOf(error), 1);
      return true;
    },
  );
  assert.deepEqual(events, ["down", "rebind"]);
});

test("cleans up when postgres fails to start, discovering its port best-effort", async () => {
  const startupFailure = new Error("docker exited with status 1");
  let reboundPorts: Record<string, number> | undefined;
  const { calls, commandRunner } = createFakeRunner((call) =>
    call.args.includes("up") ? Promise.reject(startupFailure) : undefined,
  );

  await assert.rejects(
    runDatabaseIntegrationTests({
      ...defaults,
      assertPortsCanRebind: async (ports) => {
        reboundPorts = { ...ports };
      },
      commandRunner,
      signalTarget: new EventEmitter(),
    }),
    (error) => error === startupFailure,
  );

  assert.deepEqual(reboundPorts, { postgres: publishedPort });
  assert.ok(calls.some(isDown));
  assert.equal(calls.some(isVitest), false);
});

test("fails a passing run when owned resources remain after cleanup", async () => {
  const { commandRunner } = createFakeRunner((call) =>
    call.args[0] === "volume"
      ? Promise.resolve(`${projectName}_postgres_data`)
      : undefined,
  );

  await assert.rejects(
    runDatabaseIntegrationTests({
      ...defaults,
      assertPortsCanRebind: async () => undefined,
      commandRunner,
      signalTarget: new EventEmitter(),
    }),
    /Owned Compose resources remain after cleanup: volume/u,
  );
});

test("cleans up on SIGINT and re-emits the signal", async () => {
  const signalTarget = new EventEmitter();
  const events: string[] = [];
  let rejectVitest: ((reason: unknown) => void) | undefined;
  const { calls, commandRunner, terminated } = createFakeRunner(
    (call) => {
      if (isVitest(call)) {
        return new Promise<string>((_resolve, reject) => {
          rejectVitest = reject;
        });
      }
      if (isDown(call)) events.push("down");
      return undefined;
    },
    (signal) => rejectVitest?.(new Error(`pnpm terminated by ${signal}`)),
  );

  const run = runDatabaseIntegrationTests({
    ...defaults,
    assertPortsCanRebind: async () => {
      events.push("rebind");
    },
    commandRunner,
    reemitSignal: (signal) => events.push(`reemit ${signal}`),
    signalTarget,
  });
  await waitFor(() => calls.some(isVitest));
  signalTarget.emit("SIGINT");
  signalTarget.emit("SIGINT");
  await run;

  assert.deepEqual(terminated, ["SIGINT"]);
  assert.deepEqual(events, ["down", "rebind", "reemit SIGINT"]);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("refuses names outside the owned patterns before running any command", async () => {
  for (const names of [
    { databaseName: "starter", projectName },
    { databaseName, projectName: "hono-starter-kit" },
  ]) {
    const { calls, commandRunner } = createFakeRunner();

    await assert.rejects(
      runDatabaseIntegrationTests({
        ...defaults,
        ...names,
        assertPortsCanRebind: async () => undefined,
        commandRunner,
        signalTarget: new EventEmitter(),
      }),
      /Refusing to run database integration tests/u,
    );
    assert.deepEqual(calls, []);
  }
});

test("generates an owned project name and an independent owned database name", () => {
  const names = createOwnedDatabaseTestNames(4321);

  assert.match(
    names.projectName,
    /^hono-starter-kit-dbtest-4321-[a-f0-9]{16}$/u,
  );
  assert.match(names.databaseName, /^starter_test_[a-f0-9]{16}$/u);
  assert.notEqual(names.projectName.slice(-16), names.databaseName.slice(-16));
});

test("maps a failure to the child exit status, falling back to 1", () => {
  const withStatus = (status: number) => {
    const error = new Error("failed");
    Object.defineProperty(error, "exitStatus", { value: status });
    return error;
  };

  assert.equal(exitCodeOf(withStatus(3)), 3);
  assert.equal(
    exitCodeOf(new AggregateError([withStatus(2), new Error("cleanup")])),
    2,
  );
  assert.equal(exitCodeOf(new Error("no status")), 1);
  assert.equal(exitCodeOf(withStatus(0)), 1);
});

test("host readiness retries the connection until PostgreSQL accepts it", async () => {
  const attempts: string[] = [];

  await waitForPostgresFromHost({
    connect: async (connectionString) => {
      attempts.push(connectionString);
      if (attempts.length < 3) throw new Error("ECONNRESET");
    },
    connectionString: "postgresql://starter:starter@127.0.0.1:55432/starter",
    retryDelayMs: 0,
  });

  assert.equal(attempts.length, 3);
});

test("host readiness gives up after its deadline", async () => {
  await assert.rejects(
    waitForPostgresFromHost({
      connect: async () => {
        throw new Error("ECONNRESET");
      },
      connectionString: "postgresql://starter:starter@127.0.0.1:55432/starter",
      retryDelayMs: 0,
      timeoutMs: 20,
    }),
    /PostgreSQL did not accept connections from the host within 20 ms/u,
  );
});

test("host readiness stops waiting when the run is interrupted", async () => {
  const controller = new globalThis.AbortController();
  controller.abort();

  await assert.rejects(
    waitForPostgresFromHost({
      connect: async () => assert.fail("must not connect after interruption"),
      connectionString: "postgresql://starter:starter@127.0.0.1:55432/starter",
      signal: controller.signal,
    }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
});
