import { describe, expect, it, vi } from "vitest";
import type { DatabaseResources } from "../database.js";
import {
  getActionableMigrationStateErrorMessage,
  MigrationChecksumMismatchError,
} from "../migration-state.js";
import { migrate } from "../migrate.js";
import { seedDatabase } from "../seed-database.js";

const connection = {
  mode: "url",
  connectionString: "postgresql://database.test/starter",
} as const;

const policy = {
  maxConnections: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  statementTimeoutMillis: false,
  idleInTransactionSessionTimeoutMillis: false,
} as const;

const flattenErrors = (error: unknown): unknown[] =>
  error instanceof AggregateError
    ? error.errors.flatMap((nestedError) => flattenErrors(nestedError))
    : [error];

const createResources = (close: () => Promise<void>): DatabaseResources =>
  ({ close, db: {}, pool: {} }) as unknown as DatabaseResources;

describe("database CLI resource cleanup", () => {
  it("forwards an explicit migration directory", async () => {
    const pool = {} as never;
    const apply = vi.fn(() => Promise.resolve({ applied: [] }));

    const createResources = vi.fn(() => ({
      db: {} as never,
      pool,
      close: () => Promise.resolve(),
    }));

    await migrate({
      connection,
      policy,
      migrationsDirectory: "/app/migrations",
      apply,
      createResources,
      log: () => undefined,
    });

    expect(createResources).toHaveBeenCalledWith({ connection, policy });

    expect(apply).toHaveBeenCalledWith({
      pool,
      migrationsDirectory: "/app/migrations",
    });
  });

  it("keeps an actionable migration failure before a simultaneous close failure", async () => {
    const migrationFailure = new MigrationChecksumMismatchError(
      "0001_first.sql",
    );
    const closeFailure = new Error("close failed");
    let thrown: unknown;

    try {
      await migrate({
        connection,
        policy,
        apply: () => Promise.reject(migrationFailure),
        createResources: () =>
          createResources(() => Promise.reject(closeFailure)),
        log: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(flattenErrors(thrown)).toEqual([migrationFailure, closeFailure]);
    expect(getActionableMigrationStateErrorMessage(thrown)).toBe(
      migrationFailure.message,
    );
  });

  it("keeps a seed failure before a simultaneous close failure", async () => {
    const seedFailure = new Error("seed failed");
    const closeFailure = new Error("close failed");
    let thrown: unknown;

    try {
      await seedDatabase({
        connection,
        policy,
        owner: {
          identity: {
            provider: "dev",
            issuer: "urn:starter:dev",
            subject: "local-developer",
            roles: [],
          },
          userId: "user_local_developer",
        },
        createResources: () =>
          createResources(() => Promise.reject(closeFailure)),
        log: () => undefined,
        seedProject: () => Promise.reject(seedFailure),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(flattenErrors(thrown)).toEqual([seedFailure, closeFailure]);
  });
});
