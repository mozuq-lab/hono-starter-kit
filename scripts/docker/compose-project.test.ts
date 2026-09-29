import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";

import {
  assertPortsCanRebind,
  createAsyncCommandRunner,
  createInterruptionGuard,
  createOwnedTestDatabase,
  createOwnedTestDatabaseName,
  finishOwnedRun,
  tearDownComposeProject,
  verifyNoOwnedComposeResources,
} from "./compose-project.ts";

// 子プロセスの偽物。実装が触るのは stdout / stderr / once / kill だけなので、その 4 つを
// 備えた EventEmitter を ChildProcess として渡す。境界の変換はここ 1 箇所に閉じる。
const createFakeStream = () => {
  const stream = new EventEmitter() as EventEmitter & {
    setEncoding: () => void;
  };
  stream.setEncoding = () => undefined;
  return stream;
};

const createFakeChild = ({
  stdout = null,
  stderr = null,
  kill = () => true,
}: {
  stdout?: EventEmitter | null;
  stderr?: EventEmitter | null;
  kill?: (signal: NodeJS.Signals) => boolean;
} = {}) => {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: unknown;
    stderr: unknown;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.kill = kill;
  return emitter as unknown as ChildProcess;
};

test("released-port verification deduplicates an unchanged restart port", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const logs: string[] = [];

  await assertPortsCanRebind(
    { jaeger: port, jaegerBeforeRestart: port },
    (message: string) => {
      logs.push(message);
    },
  );

  assert.deepEqual(logs, [
    `Released ports rebound successfully: jaeger:${port}`,
  ]);
});

test("the command runner waits for asynchronous child completion and can terminate the active child", async () => {
  const stdout = createFakeStream();
  const killedWith: NodeJS.Signals[] = [];
  const child = createFakeChild({
    kill: (signal) => {
      killedWith.push(signal);
      return true;
    },
    stdout,
  });
  const spawnCalls: {
    args?: readonly string[];
    command?: string;
    options: Record<string, unknown>;
  }[] = [];
  const runner = createAsyncCommandRunner({
    cwd: "/repository",
    spawnChild(command, args, options) {
      spawnCalls.push({ args, command, options });
      return child;
    },
  });

  let settled = false;
  const resultPromise = runner
    .run("docker", ["compose", "port", "postgres", "5432"], {
      capture: true,
      environment: { COMPOSE_PROJECT_NAME: "owned-test" },
    })
    .then((result) => {
      settled = true;
      return result;
    });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  stdout.emit("data", "127.0.0.1:55432\n");
  assert.equal(runner.terminateActiveChild("SIGTERM"), true);
  assert.deepEqual(killedWith, ["SIGTERM"]);
  child.emit("close", 0, null);

  assert.equal(await resultPromise, "127.0.0.1:55432");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.options.shell, false);
  assert.deepEqual(spawnCalls[0]?.options.stdio, ["ignore", "pipe", "inherit"]);
});

test("the command runner captures stderr only when explicitly requested", async () => {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: () => void;
  };
  stdout.setEncoding = () => undefined;
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: unknown;
    stderr: unknown;
    kill: () => boolean;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: () => void;
  };
  stderr.setEncoding = () => undefined;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.kill = () => true;
  const child = emitter as unknown as ChildProcess;
  const runner = createAsyncCommandRunner({
    spawnChild(_command, _args, options) {
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      return child;
    },
  });

  const resultPromise = runner.run("fake-command", [], {
    capture: true,
    captureStderr: true,
  });
  stdout.emit("data", "out\n");
  stderr.emit("data", "err\n");
  child.emit("close", 0, null);

  const result = await resultPromise;
  assert.deepEqual(result, { stdout: "out", stderr: "err" });
  assert.equal(Object.isFrozen(result), true);
});

test("requesting stderr capture also pipes stdout and returns the captured object", async () => {
  const stdout = createFakeStream();
  const stderr = createFakeStream();
  const child = createFakeChild({ stderr, stdout });
  const runner = createAsyncCommandRunner({
    spawnChild(_command, _args, options) {
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      return child;
    },
  });

  const resultPromise = runner.run("fake-command", [], {
    captureStderr: true,
  });
  stdout.emit("data", "out\n");
  stderr.emit("data", "err\n");
  child.emit("close", 0, null);

  assert.deepEqual(await resultPromise, { stdout: "out", stderr: "err" });
});

test("captured process failures attach hidden output without rendering arguments in the message", async () => {
  const stdout = createFakeStream();
  const stderr = createFakeStream();
  const child = createFakeChild({ stderr, stdout });
  const runner = createAsyncCommandRunner({
    spawnChild() {
      return child;
    },
  });

  const secretArgument =
    "DATABASE_URL=postgresql://user:password@postgres:5432/secret";
  const resultPromise = runner.run("fake-command", [secretArgument], {
    capture: true,
    captureStderr: true,
  });
  stdout.emit("data", "stdout-secret\n");
  stderr.emit("data", "stderr-secret\n");
  child.emit("close", 7, null);

  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "fake-command exited with status 7");
    assert.equal(error.message.includes(secretArgument), false);
    assert.equal((error.stack ?? "").includes(secretArgument), false);
    assert.equal(error.message.includes("stdout-secret"), false);
    assert.equal(error.message.includes("stderr-secret"), false);
    assert.deepEqual(Object.keys(error), []);
    assert.equal((error as Error & { exitStatus?: unknown }).exitStatus, 7);
    assert.equal(
      (error as Error & { stdout?: unknown }).stdout,
      "stdout-secret",
    );
    assert.equal(
      (error as Error & { stderr?: unknown }).stderr,
      "stderr-secret",
    );
    return true;
  });
});

test("child startup errors discard raw spawn details that contain secret arguments", async () => {
  const child = createFakeChild();
  const runner = createAsyncCommandRunner({
    spawnChild() {
      return child;
    },
  });
  const secretArgument =
    "DATABASE_URL=postgresql://user:password@postgres:5432/secret";
  const rawSpawnError = new Error(`spawn failed for ${secretArgument}`);
  Object.defineProperties(rawSpawnError, {
    path: { enumerable: true, value: "fake-command" },
    spawnargs: { enumerable: true, value: [secretArgument] },
  });

  const resultPromise = runner.run("fake-command", [secretArgument]);
  child.emit("error", rawSpawnError);

  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Unable to start fake-command");
    assert.equal(error.cause, undefined);
    assert.equal(inspect(error).includes(secretArgument), false);
    assert.equal((error.stack ?? "").includes(secretArgument), false);
    assert.equal(JSON.stringify(error).includes(secretArgument), false);
    assert.deepEqual(Object.keys(error), []);
    return true;
  });
});

test("stdin input is written only to the child's piped stdin and never reaches the failure", async () => {
  const stdout = createFakeStream();
  const written: string[] = [];
  const stdinErrorListeners: string[] = [];
  const stdin = new EventEmitter() as EventEmitter & {
    end: (chunk: string) => void;
  };
  stdin.end = (chunk) => {
    written.push(chunk);
  };
  const child = createFakeChild({ stdout });
  (child as unknown as { stdin: unknown }).stdin = stdin;
  const originalOn = stdin.on.bind(stdin);
  stdin.on = ((event: string, listener: (...args: unknown[]) => void) => {
    stdinErrorListeners.push(event);
    return originalOn(event, listener);
  }) as typeof stdin.on;
  const spawnOptions: Record<string, unknown>[] = [];
  const runner = createAsyncCommandRunner({
    spawnChild(_command, _args, options) {
      spawnOptions.push(options);
      return child;
    },
  });

  const secretInput = "ecr-password-secret";
  const resultPromise = runner.run("docker", ["login", "--password-stdin"], {
    capture: true,
    stdin: secretInput,
  });
  stdout.emit("data", "stdout-output\n");
  // 子プロセスが stdin を読まずに終わっても、EPIPE でプロセスが落ちないこと。
  stdin.emit("error", new Error("write EPIPE"));
  child.emit("close", 1, null);

  await assert.rejects(resultPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(inspect(error).includes(secretInput), false);
    assert.equal((error.stack ?? "").includes(secretInput), false);
    assert.equal(JSON.stringify(error).includes(secretInput), false);
    return true;
  });
  assert.deepEqual(written, [secretInput]);
  assert.ok(stdinErrorListeners.includes("error"));
  assert.deepEqual(spawnOptions[0]?.stdio, ["pipe", "pipe", "inherit"]);
});

type Call = { args: readonly string[]; options?: Record<string, unknown> };

// 呼び出しを記録し、応答は handler に任せる偽の command runner。
const createRecordingRunner = (
  handler: (
    command: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ) => Promise<string | { stdout: string; stderr: string }> = async () => "",
) => {
  const calls: (Call & { command: string })[] = [];
  const terminated: NodeJS.Signals[] = [];
  return {
    calls,
    terminated,
    runner: {
      run(
        command: string,
        args: readonly string[],
        options?: Record<string, unknown>,
      ) {
        calls.push({ args, command, ...(options ? { options } : {}) });
        return handler(command, args, options);
      },
      terminateActiveChild(signal: NodeJS.Signals) {
        terminated.push(signal);
        return true;
      },
    },
  };
};

const commandFailure = (stderr: string) => {
  const error = new Error("docker exited with status 1");
  Object.defineProperties(error, {
    exitStatus: { value: 1 },
    stderr: { value: stderr },
    stdout: { value: "" },
  });
  return error;
};

test("the first signal terminates the active child, aborts the workflow, and ignores later signals", async () => {
  const signalTarget = new EventEmitter();
  const { runner, terminated } = createRecordingRunner();
  const guard = createInterruptionGuard({
    commandRunner: runner,
    signalTarget,
  });

  signalTarget.emit("SIGINT");
  signalTarget.emit("SIGTERM");

  assert.deepEqual(terminated, ["SIGINT"]);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.receivedSignal(), "SIGINT");
  assert.equal(await guard.interruption, "SIGINT");
  assert.throws(() => guard.throwIfInterrupted(), /interrupted by SIGINT/u);
  guard.dispose();
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("a signal during cleanup is recorded without terminating the cleanup child", () => {
  const signalTarget = new EventEmitter();
  const { runner, terminated } = createRecordingRunner();
  const guard = createInterruptionGuard({
    commandRunner: runner,
    signalTarget,
  });

  guard.startCleanup();
  signalTarget.emit("SIGTERM");

  assert.deepEqual(terminated, []);
  assert.equal(guard.signal.aborted, false);
  assert.equal(guard.receivedSignal(), "SIGTERM");
  guard.dispose();
});

test("teardown removes containers, networks and volumes, then rebinds the recorded ports", async () => {
  const events: string[] = [];
  const failures: unknown[] = [];
  const downArgs: (readonly string[])[] = [];

  await tearDownComposeProject({
    assertPortsCanRebind: async (ports) => {
      events.push(`rebind ${JSON.stringify(ports)}`);
    },
    failures,
    log: () => undefined,
    ports: { postgres: 55432 },
    projectName: "hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
    runCompose: async (args) => {
      downArgs.push(args);
      events.push("down");
      return "";
    },
  });

  assert.deepEqual(downArgs, [["down", "-v", "--remove-orphans"]]);
  assert.deepEqual(events, ["down", 'rebind {"postgres":55432}']);
  assert.deepEqual(failures, []);
});

test("teardown can also remove locally built images", async () => {
  const downArgs: (readonly string[])[] = [];

  await tearDownComposeProject({
    assertPortsCanRebind: async () => undefined,
    failures: [],
    log: () => undefined,
    ports: {},
    projectName: "hono-starter-kit-test-1-a1b2c3d4e5f60708",
    removeLocalImages: true,
    runCompose: async (args) => {
      downArgs.push(args);
      return "";
    },
  });

  assert.deepEqual(downArgs, [
    ["down", "-v", "--remove-orphans", "--rmi", "local"],
  ]);
});

test("teardown still rebinds ports after down fails and keeps both failures once", async () => {
  const downFailure = new Error("down failed");
  const rebindFailure = new Error("rebind failed");
  const failures: unknown[] = [downFailure];

  await tearDownComposeProject({
    assertPortsCanRebind: async () => {
      throw rebindFailure;
    },
    failures,
    log: () => undefined,
    ports: { postgres: 55432 },
    projectName: "hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
    runCompose: async () => {
      throw downFailure;
    },
  });

  assert.deepEqual(failures, [downFailure, rebindFailure]);
});

test("an interrupted run reports its failures before re-emitting the signal", () => {
  const events: unknown[] = [];
  const failure = new Error("cleanup failed");

  finishOwnedRun({
    failures: [failure],
    label: "Owned run",
    receivedSignal: "SIGINT",
    reemitSignal: (signal) => events.push(["reemit", signal]),
    reportFailure: (reported) => events.push(["report", reported]),
  });

  assert.deepEqual(events, [
    ["report", failure],
    ["reemit", "SIGINT"],
  ]);
});

test("a finished run throws a single failure unchanged and combines several", () => {
  const first = new Error("first");
  const second = new Error("second");
  const options = {
    label: "Owned run",
    receivedSignal: undefined,
    reemitSignal: () => assert.fail("must not re-emit"),
    reportFailure: () => assert.fail("must not report"),
  };

  assert.doesNotThrow(() => finishOwnedRun({ ...options, failures: [] }));
  assert.throws(
    () => finishOwnedRun({ ...options, failures: [first] }),
    (error) => error === first,
  );
  assert.throws(
    () => finishOwnedRun({ ...options, failures: [first, second] }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === first &&
      error.errors[1] === second &&
      error.message === "Owned run produced 2 failures",
  );
});

const ownedDatabaseName = "starter_test_0123456789abcdef";

test("creates the owned test database with createdb inside the owned postgres service", async () => {
  const calls: Call[] = [];

  await createOwnedTestDatabase({
    databaseName: ownedDatabaseName,
    log: () => undefined,
    runCompose: async (args, options) => {
      calls.push({ args, ...(options ? { options } : {}) });
      return { stderr: "", stdout: "" };
    },
    sleep: async () => assert.fail("must not wait after success"),
  });

  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      [
        "exec",
        "-T",
        "postgres",
        "createdb",
        "-U",
        "starter",
        ownedDatabaseName,
      ],
    ],
  );
  assert.equal(calls[0]?.options?.captureStderr, true);
});

test("retries createdb while the postgres entrypoint is still initializing and treats already exists on a retry as success", async () => {
  const responses = [
    commandFailure(
      'createdb: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: server closed the connection unexpectedly',
    ),
    commandFailure(
      `createdb: error: database creation failed: ERROR:  database "${ownedDatabaseName}" already exists`,
    ),
  ];
  const waits: number[] = [];
  let attempts = 0;

  await createOwnedTestDatabase({
    databaseName: ownedDatabaseName,
    log: () => undefined,
    runCompose: async () => {
      attempts += 1;
      const response = responses.shift();
      if (response !== undefined) throw response;
      return { stderr: "", stdout: "" };
    },
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1000]);
});

test("refuses already exists on the first createdb attempt because the name must be new", async () => {
  await assert.rejects(
    createOwnedTestDatabase({
      databaseName: ownedDatabaseName,
      log: () => undefined,
      runCompose: async () => {
        throw commandFailure(
          `createdb: error: database creation failed: ERROR:  database "${ownedDatabaseName}" already exists`,
        );
      },
      sleep: async () => assert.fail("must not retry an existing database"),
    }),
    /already exists before this run created it/u,
  );
});

test("stops createdb after ten failed attempts and reports the last stderr", async () => {
  let attempts = 0;

  await assert.rejects(
    createOwnedTestDatabase({
      databaseName: ownedDatabaseName,
      log: () => undefined,
      runCompose: async () => {
        attempts += 1;
        throw commandFailure(`createdb: error: attempt ${attempts}`);
      },
      sleep: async () => undefined,
    }),
    (error) =>
      error instanceof Error &&
      error.message.includes("after 10 attempts") &&
      error.message.includes("createdb: error: attempt 10"),
  );
  assert.equal(attempts, 10);
});

test("does not retry createdb after the workflow is interrupted", async () => {
  const controller = new globalThis.AbortController();
  const interrupted = new Error("interrupted by SIGINT");
  let attempts = 0;

  await assert.rejects(
    createOwnedTestDatabase({
      databaseName: ownedDatabaseName,
      log: () => undefined,
      runCompose: async () => {
        attempts += 1;
        controller.abort();
        throw interrupted;
      },
      signal: controller.signal,
      sleep: async () => assert.fail("must not wait after interruption"),
    }),
    (error) => error === interrupted,
  );
  assert.equal(attempts, 1);
});

test("generates owned test database names that createOwnedTestDatabase accepts", () => {
  const names = new Set(
    Array.from({ length: 8 }, () => createOwnedTestDatabaseName()),
  );
  for (const name of names) {
    assert.match(name, /^starter_test_[a-f0-9]{16}$/u);
  }
  assert.equal(names.size, 8);
});

for (const databaseName of [
  "starter",
  "starter_test_0123456789ABCDEF",
  "starter_test_0123",
  "starter_test_0123456789abcdef; drop database starter",
]) {
  test(`refuses to create ${JSON.stringify(databaseName)} because it is not an owned test database name`, async () => {
    await assert.rejects(
      createOwnedTestDatabase({
        databaseName,
        log: () => undefined,
        runCompose: async () => assert.fail("must not run compose"),
      }),
      /Refusing to create a database that is not an owned test database/u,
    );
  });
}

test("finds no residual resources when every labelled listing is empty", async () => {
  const { calls, runner } = createRecordingRunner();

  await verifyNoOwnedComposeResources({
    commandRunner: runner,
    projectName: "hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
  });

  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      [
        "docker",
        "ps",
        "-aq",
        "--filter",
        "label=com.docker.compose.project=hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
      ],
      [
        "docker",
        "network",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
      ],
      [
        "docker",
        "volume",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
      ],
    ],
  );
});

test("fails when a container, network or volume of the owned project remains", async () => {
  const { runner } = createRecordingRunner(async (_command, args) =>
    args[0] === "volume" ? "hono-starter-kit-dbtest-1-a1b2_postgres_data" : "",
  );

  await assert.rejects(
    verifyNoOwnedComposeResources({
      commandRunner: runner,
      projectName: "hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
    }),
    /Owned Compose resources remain after cleanup: volume/u,
  );
});
