import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "./migration-runner.js";
import { getActionableMigrationStateErrorMessage } from "./migration-state.js";

const tenMinutes = 10 * 60_000;
const lockWaitExceededMessage =
  "Database migration waited too long for another migrator to finish. Check for a stuck migration task.";
const lockRetriesExhaustedMessage =
  "Database migration could not acquire a table lock after 5 attempts. Retry when the database is less busy.";
const statementTimeoutMessage =
  "Database migration exceeded its statement timeout.";
const statementTimeoutChangeMessage =
  "Migration files must not change statement_timeout. Run long operations outside the deploy task.";
const sessionSettingChangeMessage =
  "Migration files must not change lock_timeout or reset session settings. The migration runner sets them for each migration.";
const transactionControlMessage =
  "Migration files must not begin, commit, or roll back transactions. The migration runner wraps each migration in its own transaction.";

const expectRejectedBeforeConnecting = async (sql: string, message: string) => {
  const directory = await createMigrationFixture({
    "0001_first.sql": "select 1;",
    "0002_rejected.sql": sql,
  });
  const fake = createFakePool();

  let thrown: unknown;
  try {
    await applyMigrations({
      pool: fake.pool,
      migrationsDirectory: directory,
      sleep: noSleep,
    });
  } catch (error) {
    thrown = error;
  }

  expect((thrown as Error | undefined)?.message).toBe(message);
  expect(getActionableMigrationStateErrorMessage(thrown)).toBe(message);
  expect(fake.connect).not.toHaveBeenCalled();
};

const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const createMigrationFixture = async (
  files: Readonly<Record<string, string>>,
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "starter-migration-runner-"));
  fixtureDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([filename, contents]) =>
      writeFile(join(directory, filename), contents),
    ),
  );
  return directory;
};

const databaseError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

type Query = { text: string; values?: readonly unknown[] };

// 呼ばれた SQL を順に記録し、respond が返した行か失敗をそのまま返す fake client。
const createFakePool = (
  respond: (query: Query) => unknown[] | Error = () => [],
) => {
  const queries: Query[] = [];
  const release = vi.fn();
  const connect = vi.fn(() =>
    Promise.resolve({
      query(text: string, values?: readonly unknown[]) {
        const query = {
          text: text.replace(/\s+/gu, " ").trim(),
          ...(values === undefined ? {} : { values }),
        };
        queries.push(query);
        const response = respond(query);
        return response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve({ rows: response });
      },
      release,
    }),
  );
  return {
    pool: { connect } as unknown as Pool,
    connect,
    queries,
    release,
    texts: () => queries.map(({ text }) => text),
  };
};

const readAppliedText =
  "select filename, checksum from starter_migrations order by filename asc";

const checksumOf = async (directory: string, filename: string) => {
  const { loadMigrationFiles } = await import("./migration-files.js");
  const files = await loadMigrationFiles(directory);
  const file = files.find((candidate) => candidate.filename === filename);
  if (file === undefined) throw new Error(`missing fixture ${filename}`);
  return file.checksum;
};

const noSleep = () => Promise.resolve();

describe("advisory lock wait", () => {
  it("bounds the advisory lock wait by the pending migration count times ten minutes", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
      "0002_second.sql": "select 2;",
      "0003_third.sql": "select 3;",
    });
    const firstChecksum = await checksumOf(directory, "0001_first.sql");
    const fake = createFakePool(({ text }) =>
      text === readAppliedText
        ? [{ filename: "0001_first.sql", checksum: firstChecksum }]
        : [],
    );

    await applyMigrations({
      pool: fake.pool,
      migrationsDirectory: directory,
      sleep: noSleep,
    });

    expect(fake.texts().slice(0, 3)).toEqual([
      readAppliedText,
      `set lock_timeout = ${2 * tenMinutes}`,
      "select pg_advisory_lock($1::integer, $2::integer)",
    ]);
  });

  it("counts every local migration when the migration table does not exist yet", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
      "0002_second.sql": "select 2;",
    });
    let firstRead = true;
    const fake = createFakePool(({ text }) => {
      if (text === readAppliedText && firstRead) {
        firstRead = false;
        return databaseError("42P01", "relation does not exist");
      }
      return [];
    });

    await applyMigrations({
      pool: fake.pool,
      migrationsDirectory: directory,
      sleep: noSleep,
    });

    expect(fake.texts()[1]).toBe(`set lock_timeout = ${2 * tenMinutes}`);
  });

  it("waits at least ten minutes for the advisory lock when nothing is pending", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
    });
    const checksum = await checksumOf(directory, "0001_first.sql");
    const fake = createFakePool(({ text }) =>
      text === readAppliedText
        ? [{ filename: "0001_first.sql", checksum }]
        : [],
    );

    await expect(
      applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep: noSleep,
      }),
    ).resolves.toEqual({ applied: [] });

    expect(fake.texts()[1]).toBe(`set lock_timeout = ${tenMinutes}`);
  });

  it("resets the session lock_timeout after acquiring the advisory lock", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
    });
    const fake = createFakePool();

    await applyMigrations({
      pool: fake.pool,
      migrationsDirectory: directory,
      sleep: noSleep,
    });

    const texts = fake.texts();
    const lockIndex = texts.indexOf(
      "select pg_advisory_lock($1::integer, $2::integer)",
    );
    expect(texts[lockIndex + 1]).toBe("reset lock_timeout");
    expect(texts.indexOf("reset lock_timeout")).toBeLessThan(
      texts.indexOf("begin"),
    );
  });

  it("fails with a dedicated error, without retrying, when the advisory lock wait is exceeded", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
    });
    const fake = createFakePool(({ text }) =>
      text.startsWith("select pg_advisory_lock")
        ? databaseError(
            "55P03",
            "canceling statement due to lock timeout driver-canary",
          )
        : [],
    );
    const sleep = vi.fn(noSleep);

    let thrown: unknown;
    try {
      await applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(lockWaitExceededMessage);
    expect(getActionableMigrationStateErrorMessage(thrown)).toBe(
      lockWaitExceededMessage,
    );
    expect(
      fake.texts().filter((text) => text.startsWith("select pg_advisory_lock")),
    ).toHaveLength(1);
    expect(fake.texts()).not.toContain(
      "select pg_advisory_unlock($1::integer, $2::integer)",
    );
    expect(fake.texts()).not.toContain("begin");
    // 失敗した接続を pool に戻すので、セッション単位の lock_timeout を残さない。
    expect(fake.texts().at(-1)).toBe("reset lock_timeout");
    expect(sleep).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("still unlocks when resetting lock_timeout fails after the advisory lock was taken", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
    });
    const resetFailure = new Error("reset failed");
    const fake = createFakePool(({ text }) =>
      text === "reset lock_timeout" ? resetFailure : [],
    );

    await expect(
      applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep: noSleep,
      }),
    ).rejects.toBe(resetFailure);
    expect(fake.texts().at(-1)).toBe(
      "select pg_advisory_unlock($1::integer, $2::integer)",
    );
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("uses the injected per-migration bound for the advisory lock wait", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
    });
    const fake = createFakePool();

    await applyMigrations({
      pool: fake.pool,
      migrationsDirectory: directory,
      advisoryLockWaitPerMigrationMillis: 250,
      sleep: noSleep,
    });

    expect(fake.texts()[1]).toBe("set lock_timeout = 250");
  });
});

describe("statement_timeout guard", () => {
  it.each([
    "set local statement_timeout = '30min';\nalter table projects add column x text;",
    "SET statement_timeout TO 0;",
    "select set_config('Statement_Timeout', '0', true);",
  ])(
    "rejects a migration file that changes statement_timeout before taking the advisory lock (%#)",
    async (sql) => {
      const directory = await createMigrationFixture({
        "0001_first.sql": "select 1;",
        "0002_long.sql": sql,
      });
      const fake = createFakePool();

      let thrown: unknown;
      try {
        await applyMigrations({
          pool: fake.pool,
          migrationsDirectory: directory,
          sleep: noSleep,
        });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as Error).message).toBe(statementTimeoutChangeMessage);
      expect(getActionableMigrationStateErrorMessage(thrown)).toBe(
        statementTimeoutChangeMessage,
      );
      expect(fake.connect).not.toHaveBeenCalled();
    },
  );
});

describe("session setting guard", () => {
  it.each([
    "set local lock_timeout = '10min';\nalter table projects add column x text;",
    "SET lock_timeout TO 0;",
    "RESET ALL;",
    "reset\n  all;",
  ])(
    "rejects a migration file that changes lock_timeout or resets session settings (%#)",
    (sql) => expectRejectedBeforeConnecting(sql, sessionSettingChangeMessage),
  );
});

describe("transaction control guard", () => {
  it.each([
    "begin;\ncreate table x (id integer);\ncommit;",
    "create table x (id integer);\nCOMMIT;",
    "create table x (id integer); rollback;",
    "START TRANSACTION;\ncreate table x (id integer);",
    "create table x (id integer);\nend;",
    "create table x (id integer);\nabort;",
    "create table x (id integer);\ncommit and chain;",
    "/* setup */ begin work;\ncreate table x (id integer);",
  ])("rejects a migration file that controls its own transaction (%#)", (sql) =>
    expectRejectedBeforeConnecting(sql, transactionControlMessage),
  );

  it.each([
    "do $$\nbegin\n  perform 1;\nend\n$$;",
    "create function touch() returns trigger language plpgsql as $body$\nbegin\n  return new;\nend;\n$body$;",
    "-- commit this later\ncreate table x (id integer);",
    "/* begin; */ create table x (id integer);",
    "insert into notes (body) values ('commit; rollback;');",
    "select case when true then 1 else 2 end;",
    'create table "begin" (id integer);',
  ])(
    "accepts a keyword that is not a transaction control statement (%#)",
    async (sql) => {
      const directory = await createMigrationFixture({
        "0001_first.sql": sql,
      });
      const fake = createFakePool();

      await expect(
        applyMigrations({
          pool: fake.pool,
          migrationsDirectory: directory,
          sleep: noSleep,
        }),
      ).resolves.toEqual({ applied: ["0001_first.sql"] });
    },
  );
});

describe("migration transactions", () => {
  it("sets local lock_timeout and statement_timeout inside each migration transaction before the migration SQL", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
      "0002_second.sql": "select 2;",
    });
    const fake = createFakePool();

    await expect(
      applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep: noSleep,
      }),
    ).resolves.toEqual({ applied: ["0001_first.sql", "0002_second.sql"] });

    const texts = fake.texts();
    const firstBegin = texts.indexOf("begin");
    expect(texts.slice(firstBegin)).toEqual([
      "begin",
      "set local lock_timeout = '5s'",
      "set local statement_timeout = '5min'",
      "select 1;",
      "insert into starter_migrations (filename, checksum) values ($1, $2)",
      "commit",
      "begin",
      "set local lock_timeout = '5s'",
      "set local statement_timeout = '5min'",
      "select 2;",
      "insert into starter_migrations (filename, checksum) values ($1, $2)",
      "commit",
      "select pg_advisory_unlock($1::integer, $2::integer)",
    ]);
  });

  it("retries a migration transaction after a 55P03 lock timeout with backoff", async () => {
    const directory = await createMigrationFixture({
      "0001_alter.sql": "alter table projects add column note text;",
    });
    let failures = 0;
    const fake = createFakePool(({ text }) => {
      if (text.startsWith("alter table") && failures < 2) {
        failures += 1;
        return databaseError(
          "55P03",
          "canceling statement due to lock timeout",
        );
      }
      return [];
    });
    const sleep = vi.fn(noSleep);

    await expect(
      applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep,
      }),
    ).resolves.toEqual({ applied: ["0001_alter.sql"] });

    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    const texts = fake.texts();
    expect(texts.filter((text) => text === "begin")).toHaveLength(3);
    expect(texts.filter((text) => text === "rollback")).toHaveLength(2);
    expect(texts.filter((text) => text === "commit")).toHaveLength(1);
    expect(
      texts.filter((text) => text.startsWith("insert into starter_migrations")),
    ).toHaveLength(1);
  });

  it("gives up after five lock timeouts and rolls back", async () => {
    const directory = await createMigrationFixture({
      "0001_alter.sql": "alter table projects add column note text;",
    });
    const fake = createFakePool(({ text }) =>
      text.startsWith("alter table")
        ? databaseError(
            "55P03",
            "canceling statement due to lock timeout driver-canary",
          )
        : [],
    );
    const sleep = vi.fn(noSleep);

    let thrown: unknown;
    try {
      await applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep,
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe(lockRetriesExhaustedMessage);
    expect(getActionableMigrationStateErrorMessage(thrown)).toBe(
      lockRetriesExhaustedMessage,
    );
    expect(sleep.mock.calls).toEqual([[1_000], [2_000], [4_000], [8_000]]);
    const texts = fake.texts();
    expect(texts.filter((text) => text === "begin")).toHaveLength(5);
    expect(texts.filter((text) => text === "rollback")).toHaveLength(5);
    expect(texts).not.toContain("commit");
    expect(texts.slice(-2)).toEqual([
      "rollback",
      "select pg_advisory_unlock($1::integer, $2::integer)",
    ]);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("does not retry a migration that fails with any other SQLSTATE", async () => {
    const directory = await createMigrationFixture({
      "0001_alter.sql": "alter table projects add column note text;",
    });
    const failure = databaseError("23505", "duplicate key");
    const fake = createFakePool(({ text }) =>
      text.startsWith("alter table") ? failure : [],
    );
    const sleep = vi.fn(noSleep);

    await expect(
      applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep,
      }),
    ).rejects.toBe(failure);

    expect(sleep).not.toHaveBeenCalled();
    expect(fake.texts().filter((text) => text === "begin")).toHaveLength(1);
    expect(fake.texts().filter((text) => text === "rollback")).toHaveLength(1);
  });

  it("reports a statement timeout with a dedicated error instead of the driver message", async () => {
    const directory = await createMigrationFixture({
      "0001_slow.sql": "select pg_sleep(600);",
    });
    const fake = createFakePool(({ text }) =>
      text === "select pg_sleep(600);"
        ? databaseError(
            "57014",
            "canceling statement due to statement timeout driver-canary",
          )
        : [],
    );
    const sleep = vi.fn(noSleep);

    let thrown: unknown;
    try {
      await applyMigrations({
        pool: fake.pool,
        migrationsDirectory: directory,
        sleep,
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe(statementTimeoutMessage);
    expect(getActionableMigrationStateErrorMessage(thrown)).toBe(
      statementTimeoutMessage,
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(fake.texts()).toContain("rollback");
  });
});
