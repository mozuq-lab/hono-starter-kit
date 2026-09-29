import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  assertMigrationsCurrent,
} from "./migration-runner.js";
import {
  compareMigrationState,
  getActionableMigrationStateErrorMessage,
} from "./migration-state.js";

const fixtureDirectories: string[] = [];

const flattenErrors = (error: unknown): unknown[] =>
  error instanceof AggregateError
    ? error.errors.flatMap((nestedError) => flattenErrors(nestedError))
    : [error];

const createMigrationFixture = async (
  files: Readonly<Record<string, string>>,
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "starter-migration-state-"));
  fixtureDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([filename, contents]) =>
      writeFile(join(directory, filename), contents),
    ),
  );
  return directory;
};

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("compareMigrationState", () => {
  it("rejects a changed applied migration", () => {
    expect(() =>
      compareMigrationState(
        [{ filename: "0001_first.sql", checksum: "new" }],
        [{ filename: "0001_first.sql", checksum: "old" }],
      ),
    ).toThrow("Migration checksum mismatch: 0001_first.sql");
  });

  it("returns only missing local migrations", () => {
    const local = [
      { filename: "0001_first.sql", checksum: "first" },
      { filename: "0002_second.sql", checksum: "second" },
    ];

    expect(
      compareMigrationState(local, [
        { filename: "0001_first.sql", checksum: "first" },
      ]),
    ).toEqual([{ filename: "0002_second.sql", checksum: "second" }]);
  });

  it("tolerates strictly later database-only migrations after every local migration", () => {
    expect(
      compareMigrationState(
        [{ filename: "0001_first.sql", checksum: "first" }],
        [
          { filename: "0001_first.sql", checksum: "first" },
          { filename: "0002_future.sql", checksum: "future" },
        ],
      ),
    ).toEqual([]);
  });

  it("rejects a database migration whose prefix collides with a differently named local migration", () => {
    expect(() =>
      compareMigrationState(
        [
          { filename: "0001_first.sql", checksum: "first" },
          { filename: "0002_feature.sql", checksum: "feature" },
        ],
        [
          { filename: "0001_first.sql", checksum: "first" },
          { filename: "0002_other.sql", checksum: "other" },
        ],
      ),
    ).toThrow(
      "Database migration history conflict: prefix 0002 is recorded as 0002_other.sql but local migration is 0002_feature.sql.",
    );
  });

  it("rejects a missing local migration before a database-only migration", () => {
    expect(() =>
      compareMigrationState(
        [
          { filename: "0001_first.sql", checksum: "first" },
          { filename: "0002_second.sql", checksum: "second" },
        ],
        [
          { filename: "0001_first.sql", checksum: "first" },
          { filename: "0003_future.sql", checksum: "future" },
        ],
      ),
    ).toThrow(
      "Database migration history diverges before 0003_future.sql: local migration 0002_second.sql is not applied.",
    );
  });

  it("rejects a database-only migration that is not later than the complete local history", () => {
    expect(() =>
      compareMigrationState(
        [
          { filename: "0001_first.sql", checksum: "first" },
          { filename: "0003_third.sql", checksum: "third" },
        ],
        [
          { filename: "0001_first.sql", checksum: "first" },
          { filename: "0002_future.sql", checksum: "future" },
          { filename: "0003_third.sql", checksum: "third" },
        ],
      ),
    ).toThrow(
      "Database migration history diverges: database-only migration 0002_future.sql must be later than local migration 0003_third.sql.",
    );
  });

  it("exposes only classified migration-state guidance to callers", () => {
    let mismatch: unknown;
    try {
      compareMigrationState(
        [{ filename: "0001_first.sql", checksum: "new" }],
        [{ filename: "0001_first.sql", checksum: "old" }],
      );
    } catch (error) {
      mismatch = error;
    }

    expect(getActionableMigrationStateErrorMessage(mismatch)).toBe(
      "Migration checksum mismatch: 0001_first.sql. Restore the original applied migration bytes, then add a new forward migration for further changes.",
    );
    expect(
      getActionableMigrationStateErrorMessage(
        new Error(
          "postgres://user:secret@localhost/db select private_sql driver detail",
        ),
      ),
    ).toBeUndefined();
  });
});

describe("migration execution", () => {
  it("locks once and applies each pending migration transactionally", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select 1;",
    });
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    let releases = 0;
    const client = {
      query(text: string, values?: readonly unknown[]) {
        calls.push({ text, ...(values === undefined ? {} : { values }) });
        return Promise.resolve({ rows: [] });
      },
      release() {
        releases += 1;
      },
    };
    let connections = 0;
    const pool = {
      connect() {
        connections += 1;
        return Promise.resolve(client);
      },
    } as unknown as Pool;

    const result = await applyMigrations({
      pool,
      migrationsDirectory: directory,
    });

    expect(result).toEqual({ applied: ["0001_first.sql"] });
    expect(connections).toBe(1);
    expect(releases).toBe(1);
    expect(calls).toHaveLength(13);
    expect(calls[0]?.text).toContain("from starter_migrations");
    expect(calls[1]).toEqual({ text: "set lock_timeout = 600000" });
    expect(calls[2]).toEqual({
      text: "select pg_advisory_lock($1::integer, $2::integer)",
      values: [107402177, 20260805],
    });
    expect(calls[3]).toEqual({ text: "reset lock_timeout" });
    expect(calls[4]?.text).toContain(
      "create table if not exists starter_migrations",
    );
    expect(calls[5]?.text).toContain("from starter_migrations");
    expect(calls[6]).toEqual({ text: "begin" });
    expect(calls[7]).toEqual({ text: "set local lock_timeout = '5s'" });
    expect(calls[8]).toEqual({ text: "set local statement_timeout = '5min'" });
    expect(calls[9]).toEqual({ text: "select 1;" });
    expect(calls[10]?.text).toContain("insert into starter_migrations");
    expect(calls[10]?.values).toEqual([
      "0001_first.sql",
      "354b7196c9ba5fb4b21cf615bb6ec4cd5c07503c34229feef033fc081a8c03f4",
    ]);
    expect(calls[11]).toEqual({ text: "commit" });
    expect(calls[12]).toEqual({
      text: "select pg_advisory_unlock($1::integer, $2::integer)",
      values: [107402177, 20260805],
    });
  });

  it("rolls back a failed migration before unlocking and releasing", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select broken;",
    });
    const calls: string[] = [];
    let releases = 0;
    const migrationFailure = new Error("migration failed");
    const client = {
      query(text: string) {
        calls.push(text);
        if (text === "select broken;") {
          return Promise.reject(migrationFailure);
        }
        return Promise.resolve({ rows: [] });
      },
      release() {
        releases += 1;
      },
    };
    const pool = {
      connect() {
        return Promise.resolve(client);
      },
    } as unknown as Pool;

    await expect(
      applyMigrations({ pool, migrationsDirectory: directory }),
    ).rejects.toBe(migrationFailure);
    expect(calls.slice(-3)).toEqual([
      "select broken;",
      "rollback",
      "select pg_advisory_unlock($1::integer, $2::integer)",
    ]);
    expect(releases).toBe(1);
  });

  it("keeps migration, rollback, unlock, and release failures in causal order", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select broken;",
    });
    const migrationFailure = new Error("migration failed");
    const rollbackFailure = new Error("rollback failed");
    const unlockFailure = new Error("unlock failed");
    const releaseFailure = new Error("release failed");
    const calls: string[] = [];
    const client = {
      query(text: string) {
        calls.push(text);
        if (text === "select broken;") {
          return Promise.reject(migrationFailure);
        }
        if (text === "rollback") {
          return Promise.reject(rollbackFailure);
        }
        if (text.startsWith("select pg_advisory_unlock")) {
          return Promise.reject(unlockFailure);
        }
        return Promise.resolve({ rows: [] });
      },
      release() {
        throw releaseFailure;
      },
    };
    const pool = {
      connect() {
        return Promise.resolve(client);
      },
    } as unknown as Pool;

    let thrown: unknown;
    try {
      await applyMigrations({ pool, migrationsDirectory: directory });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(flattenErrors(thrown)).toEqual([
      migrationFailure,
      rollbackFailure,
      unlockFailure,
      releaseFailure,
    ]);
    expect(calls.slice(-3)).toEqual([
      "select broken;",
      "rollback",
      "select pg_advisory_unlock($1::integer, $2::integer)",
    ]);
  });

  it("asserts pending state without executing migration SQL", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select must_not_execute;",
    });
    const calls: string[] = [];
    const pool = {
      query(text: string) {
        calls.push(text);
        return Promise.resolve({ rows: [] });
      },
    } as unknown as Pool;

    await expect(assertMigrationsCurrent(pool, directory)).rejects.toThrow(
      'Database migrations are pending: 0001_first.sql. Run "pnpm db:migrate".',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("from starter_migrations");
  });

  it("reports changed migrations with safe actionable recovery guidance", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select private_migration_sql;",
    });
    const pool = {
      query() {
        return Promise.resolve({
          rows: [
            {
              filename: "0001_first.sql",
              checksum: "private-applied-checksum",
            },
          ],
        });
      },
    } as unknown as Pool;

    let thrown: unknown;
    try {
      await assertMigrationsCurrent(pool, directory);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Migration checksum mismatch: 0001_first.sql. Restore the original applied migration bytes, then add a new forward migration for further changes.",
    );
    expect((thrown as Error).message).not.toContain("private_migration_sql");
    expect((thrown as Error).message).not.toContain("private-applied-checksum");
  });

  it("sanitizes driver diagnostics when migration state cannot be read", async () => {
    const directory = await createMigrationFixture({
      "0001_first.sql": "select must_not_leak;",
    });
    const pool = {
      query() {
        const error = new Error(
          "relation starter_migrations missing at postgres://user:secret@localhost/db; select must_not_leak;",
        );
        Object.assign(error, { code: "42P01" });
        return Promise.reject(error);
      },
    } as unknown as Pool;

    await expect(assertMigrationsCurrent(pool, directory)).rejects.toThrow(
      'Database migrations are not initialized. Run "pnpm db:migrate".',
    );
  });
});
