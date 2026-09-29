import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { DatabaseSessionPolicy } from "./database.js";
import {
  closeDatabaseIntegrationResources,
  createGuardedDatabaseIntegrationResources,
  dropTestSchema,
  type GuardedDatabaseResources,
  integrationTestSessionPolicy,
  recreateTestSchema,
} from "./database-test-support.js";
import { MigrationLockWaitExceededError } from "./migration-errors.js";
import { applyMigrations } from "./migration-runner.js";

const advisoryLockKeys = [107402177, 20260805];
const migratorPolicy: DatabaseSessionPolicy = {
  ...integrationTestSessionPolicy,
  maxConnections: 1,
};

// ここで作る fixture の migration 履歴が、他のファイルの使う public に混ざらないよう、専用の
// スキーマで動かす。search_path は接続の startup option で固定するので、どの client も public を触れない。
const testSchema = "starter_timeouts_test";

const opened: GuardedDatabaseResources[] = [];
const open = (policy: DatabaseSessionPolicy = integrationTestSessionPolicy) => {
  const resources = createGuardedDatabaseIntegrationResources({
    environment: process.env,
    policy,
    schema: testSchema,
  });
  opened.push(resources);
  return resources;
};

let migrationsRoot: string | undefined;
let migrationsDirectory: string;
const addMigration = (filename: string, sql: string) =>
  writeFile(join(migrationsDirectory, filename), sql);

beforeAll(async () => {
  migrationsRoot = await mkdtemp(join(tmpdir(), "starter-database-timeouts-"));
  migrationsDirectory = migrationsRoot;
  const admin = open();
  await recreateTestSchema(admin.pool, admin.ownedDatabaseName, testSchema);
});

afterEach(async () => {
  // 失敗したテストが advisory lock やトランザクションを握ったまま次へ進まないよう、
  // テストごとに開いた pool をすべて閉じる（最初の admin は afterAll で閉じる）。
  await Promise.all(opened.splice(1).map((resources) => resources.close()));
});

afterAll(async () => {
  await closeDatabaseIntegrationResources({
    close: async () => {
      const admin = opened[0];
      try {
        if (admin !== undefined) {
          await dropTestSchema(admin.pool, admin.ownedDatabaseName, testSchema);
        }
      } finally {
        await Promise.all(
          opened.splice(0).map((resources) => resources.close()),
        );
      }
    },
    temporaryMigrationsRoot: migrationsRoot,
  });
});

it("cancels an API statement that exceeds statement_timeout", async () => {
  const api = open({
    ...integrationTestSessionPolicy,
    statementTimeoutMillis: 200,
  });

  await expect(api.pool.query("select pg_sleep(2)")).rejects.toMatchObject({
    code: "57014",
  });

  // README に書く延ばし方: トランザクション内の SET LOCAL だけが延びる。
  const client = await api.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '5s'");
    await expect(client.query("select pg_sleep(0.5)")).resolves.toBeDefined();
    await client.query("commit");
  } finally {
    client.release();
  }
  await expect(api.pool.query("select pg_sleep(0.5)")).rejects.toMatchObject({
    code: "57014",
  });
});

it.each([
  {
    cause: "idle_in_transaction_session_timeout",
    policy: {
      ...integrationTestSessionPolicy,
      idleInTransactionSessionTimeoutMillis: 200,
    },
    terminate: () => Promise.resolve(),
  },
  {
    cause: "pg_terminate_backend",
    policy: integrationTestSessionPolicy,
    terminate: async (pid: number) => {
      await opened[0]?.pool.query("select pg_terminate_backend($1)", [pid]);
    },
  },
])(
  "does not crash the process when the server terminates a checked-out connection ($cause)",
  async ({ policy, terminate }) => {
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const api = open(policy);
    const client = await api.pool.connect();
    const {
      rows: [backend],
    } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    await client.query("begin");

    await terminate(backend!.pid);
    // リスナーがなければ、ここでサーバーの切断が uncaughtException になりテストが落ちる。
    await vi.waitFor(
      () => {
        expect(logError).toHaveBeenCalledWith("PostgreSQL connection closed.");
      },
      { timeout: 5_000 },
    );
    await expect(client.query("select 1")).rejects.toThrow();
    // Kysely と同じく引数なしで返す。切れた client は pool が捨てる。
    client.release();

    await expect(api.pool.query("select 1 as ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
  },
);

it("retries and then applies a migration that briefly waits behind another transaction", async () => {
  await addMigration(
    "0001_create_timeout_fixture.sql",
    "create table timeout_fixture (id integer primary key);\n",
  );
  const migrator = open(migratorPolicy);
  await expect(
    applyMigrations({ pool: migrator.pool, migrationsDirectory }),
  ).resolves.toEqual({ applied: ["0001_create_timeout_fixture.sql"] });

  await addMigration(
    "0002_alter_timeout_fixture.sql",
    "alter table timeout_fixture add column note text;\n",
  );
  // 旧タスクの読み取りが ACCESS EXCLUSIVE の取得を塞いでいる状況を作る。
  const blocker = await open().pool.connect();
  await blocker.query("begin");
  await blocker.query("select * from timeout_fixture");
  const sleeps: number[] = [];

  try {
    await expect(
      applyMigrations({
        pool: migrator.pool,
        migrationsDirectory,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          await blocker.query("commit");
        },
      }),
    ).resolves.toEqual({ applied: ["0002_alter_timeout_fixture.sql"] });
  } finally {
    blocker.release();
  }
  expect(sleeps).toEqual([1_000]);
  const { rows } = await migrator.pool.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'timeout_fixture' order by column_name",
  );
  expect(rows.map(({ column_name }) => column_name)).toEqual(["id", "note"]);
}, 30_000);

it("lets a second migrator wait for the first and then apply nothing", async () => {
  await addMigration(
    "0003_slow_timeout_fixture.sql",
    "select pg_sleep(1);\ncreate table timeout_fixture_slow (id integer);\n",
  );
  const observer = open();
  const first = applyMigrations({
    pool: open(migratorPolicy).pool,
    migrationsDirectory,
  });
  await vi.waitFor(
    async () => {
      const { rows } = await observer.pool.query<{ held: number }>(
        "select count(*)::integer as held from pg_locks where locktype = 'advisory' and granted",
      );
      expect(rows[0]?.held).toBe(1);
    },
    { timeout: 5_000 },
  );
  const second = applyMigrations({
    pool: open(migratorPolicy).pool,
    migrationsDirectory,
  });

  await expect(first).resolves.toEqual({
    applied: ["0003_slow_timeout_fixture.sql"],
  });
  await expect(second).resolves.toEqual({ applied: [] });
}, 30_000);

it("stops a second migrator with the dedicated error when the first holds the advisory lock beyond the bound", async () => {
  await addMigration(
    "0004_blocked_timeout_fixture.sql",
    "create table timeout_fixture_blocked (id integer);\n",
  );
  const holder = await open().pool.connect();
  await holder.query(
    "select pg_advisory_lock($1::integer, $2::integer)",
    advisoryLockKeys,
  );
  const migrator = open(migratorPolicy);

  try {
    await expect(
      applyMigrations({
        pool: migrator.pool,
        migrationsDirectory,
        advisoryLockWaitPerMigrationMillis: 300,
      }),
    ).rejects.toBeInstanceOf(MigrationLockWaitExceededError);
  } finally {
    await holder.query(
      "select pg_advisory_unlock($1::integer, $2::integer)",
      advisoryLockKeys,
    );
    holder.release();
  }

  const { rows } = await migrator.pool.query<{ exists: boolean }>(
    "select to_regclass('timeout_fixture_blocked') is not null as exists",
  );
  expect(rows[0]?.exists).toBe(false);
  // 失敗した接続を pool に戻しても、セッション単位の lock_timeout は残らない。
  const { rows: settings } = await migrator.pool.query<{
    lock_timeout: string;
  }>("show lock_timeout");
  expect(settings[0]?.lock_timeout).toBe("0");
});
