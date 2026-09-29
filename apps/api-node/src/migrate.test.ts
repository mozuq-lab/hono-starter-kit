import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  migrate as migrateDatabase,
  type DatabaseConnectionConfig,
  type DatabaseResources,
} from "@starter/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveDatabaseConfig,
  type DatabaseEnvironment,
  type ResolveDatabaseConfig,
} from "./database-config.js";
import { migrationFailureMessage, runMigrations } from "./migrate.js";
import { migrationSessionPolicy } from "./database-session-policy.js";
import { createRuntimeComposition } from "./runtime-composition.js";

const validCertificatePem =
  "-----BEGIN CERTIFICATE-----\nfixture-public-certificate\n-----END CERTIFICATE-----\n";

const structuredEnvironment = {
  PGHOST: "db-canary.example.internal",
  PGPORT: "5432",
  PGDATABASE: "starter_canary",
  PGUSER: "user-canary",
  PGPASSWORD: "password-canary",
  PGSSLROOTCERT: "/app/certs/global-bundle.pem",
} as const satisfies DatabaseEnvironment;

const expectedConnection = {
  mode: "structured",
  host: "db-canary.example.internal",
  port: 5432,
  database: "starter_canary",
  user: "user-canary",
  password: "password-canary",
  ssl: { ca: validCertificatePem, rejectUnauthorized: true },
} as const satisfies DatabaseConnectionConfig;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

const createMigrationFixture = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "starter-api-migrate-"));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, "0001_adapter.sql"),
    "select adapter_fixture;\n",
    "utf8",
  );
  return directory;
};

const processEnvironmentWithoutDatabaseSettings = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const key of [
    "DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSWORD_SECRET_ARN",
    "PGSSLROOTCERT",
  ]) {
    delete environment[key];
  }
  return environment;
};

describe("runMigrations", () => {
  it("forwards the rotating password source to the migration connection", async () => {
    const environment: Record<string, string> = { ...structuredEnvironment };
    delete environment.PGPASSWORD;
    const password = () => Promise.resolve("rotated-password");
    const migrate = vi.fn(() => Promise.resolve());
    await runMigrations(
      {
        NODE_ENV: "production",
        ...environment,
        PGPASSWORD_SECRET_ARN: "secret-arn-canary",
      },
      {
        migrate,
        resolveDatabase: (input, dependencies) =>
          resolveDatabaseConfig(input, {
            ...dependencies,
            createDatabasePassword: () => password,
            parseCertificates: vi.fn(),
            readFile: vi.fn().mockResolvedValue(validCertificatePem),
          }),
      },
    );
    expect(migrate).toHaveBeenCalledWith({
      connection: { ...expectedConnection, password },
      policy: migrationSessionPolicy,
    });
  });

  it("normalizes the same structured connection as API startup while only migration applies changes under the advisory lock", async () => {
    const migrationsDirectory = await createMigrationFixture();
    const readFile = vi.fn().mockResolvedValue(validCertificatePem);
    const resolveDatabase: ResolveDatabaseConfig = (input) =>
      resolveDatabaseConfig(input, {
        parseCertificates: vi.fn(),
        readFile,
      });
    const apiConnections: DatabaseConnectionConfig[] = [];
    const apiQueries: string[] = [];
    const migrationConnections: DatabaseConnectionConfig[] = [];
    const migrationQueries: {
      text: string;
      values?: readonly unknown[];
    }[] = [];
    const assertMigrations = vi.fn().mockResolvedValue(undefined);
    const migrationClient = {
      query(text: string, values?: readonly unknown[]) {
        migrationQueries.push({
          text: text.replace(/\s+/gu, " ").trim(),
          ...(values === undefined ? {} : { values }),
        });
        return Promise.resolve({ rows: [] });
      },
      release: vi.fn(),
    };
    const migrationPool = {
      connect: vi.fn().mockResolvedValue(migrationClient),
    } as unknown as DatabaseResources["pool"];
    const closeMigrationResources = vi.fn().mockResolvedValue(undefined);
    const migrate = vi.fn((options: Parameters<typeof migrateDatabase>[0]) =>
      migrateDatabase({
        ...options,
        createResources: ({ connection }) => {
          migrationConnections.push(connection);
          return {
            db: {} as never,
            pool: migrationPool,
            close: closeMigrationResources,
          };
        },
        log: vi.fn(),
      }),
    );
    const close = vi.fn().mockResolvedValue(undefined);

    const runtime = await createRuntimeComposition(
      {
        nodeEnv: "development",
        databaseEnvironment: structuredEnvironment,
      },
      {
        resolveDatabase,
        openDatabase: ({ connection }) => {
          apiConnections.push(connection);
          return {
            db: {} as never,
            pool: {
              query: vi.fn((sql: string) => {
                apiQueries.push(sql.trim());
                return Promise.resolve({ rows: [{}] });
              }),
            } as never,
            close,
          };
        },
        assertMigrations,
      },
    );

    expect(apiConnections).toEqual([expectedConnection]);
    expect(apiQueries).toEqual(["select 1"]);
    expect(assertMigrations).toHaveBeenCalledOnce();

    await runMigrations(
      {
        NODE_ENV: "production",
        ...structuredEnvironment,
        MIGRATIONS_DIRECTORY: ` ${migrationsDirectory} `,
      },
      { migrate, resolveDatabase },
    );

    expect(migrationConnections).toEqual(apiConnections);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith({
      connection: expectedConnection,
      policy: migrationSessionPolicy,
      migrationsDirectory,
    });
    expect(migrationQueries.map(({ text }) => text)).toEqual([
      "select filename, checksum from starter_migrations order by filename asc",
      "set lock_timeout = 600000",
      "select pg_advisory_lock($1::integer, $2::integer)",
      "reset lock_timeout",
      expect.stringContaining("create table if not exists starter_migrations"),
      "select filename, checksum from starter_migrations order by filename asc",
      "begin",
      "set local lock_timeout = '5s'",
      "set local statement_timeout = '5min'",
      "select adapter_fixture;",
      expect.stringContaining("insert into starter_migrations"),
      "commit",
      "select pg_advisory_unlock($1::integer, $2::integer)",
    ]);
    expect(migrationQueries[2]?.values).toEqual([107402177, 20260805]);
    expect(migrationClient.release).toHaveBeenCalledOnce();
    expect(closeMigrationResources).toHaveBeenCalledOnce();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("omits an empty migration directory after URL resolution", async () => {
    const migrate = vi.fn(() => Promise.resolve());

    await runMigrations(
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://example/starter",
        MIGRATIONS_DIRECTORY: "   ",
      },
      { migrate, resolveDatabase: resolveDatabaseConfig },
    );

    expect(migrate).toHaveBeenCalledWith({
      connection: {
        mode: "url",
        connectionString: "postgresql://example/starter",
      },
      policy: migrationSessionPolicy,
    });
  });
});

const databaseError = (code: string): Error =>
  Object.assign(
    new Error(
      "driver-message-canary postgres://user:password-canary@db-canary/starter",
    ),
    { code },
  );

// 実際の runner に、指定した SQL で PostgreSQL の失敗を返す fake の接続を渡して走らせる。
const runMigrationsFailingWith = async ({
  failOn,
  error,
}: {
  failOn: (sql: string) => boolean;
  error: Error;
}): Promise<unknown> => {
  const migrationsDirectory = await createMigrationFixture();
  const client = {
    query(text: string) {
      return failOn(text.trim())
        ? Promise.reject(error)
        : Promise.resolve({ rows: [] });
    },
    release: vi.fn(),
  };
  const pool = {
    connect: () => Promise.resolve(client),
  } as unknown as DatabaseResources["pool"];

  try {
    await runMigrations(
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://example/starter",
        MIGRATIONS_DIRECTORY: migrationsDirectory,
      },
      {
        createSecretClient: () => ({ send: vi.fn(), destroy: vi.fn() }),
        resolveDatabase: resolveDatabaseConfig,
        migrate: (options) =>
          migrateDatabase({
            ...options,
            apply: (applyOptions) =>
              applyMigrations({
                ...applyOptions,
                sleep: () => Promise.resolve(),
              }),
            createResources: () => ({
              db: {} as never,
              pool,
              close: () => Promise.resolve(),
            }),
            log: vi.fn(),
          }),
      },
    );
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected the migration to fail");
};

describe("migrationFailureMessage", () => {
  it("prints an actionable message when lock retries are exhausted without the driver message", async () => {
    const thrown = await runMigrationsFailingWith({
      failOn: (sql) => sql === "select adapter_fixture;",
      error: databaseError("55P03"),
    });

    const message = migrationFailureMessage(thrown);
    expect(message).toBe(
      "Database migration could not acquire a table lock after 5 attempts. Retry when the database is less busy.",
    );
    expect(message).not.toContain("canary");
  });

  it("prints an actionable message for a statement timeout without the driver message", async () => {
    const thrown = await runMigrationsFailingWith({
      failOn: (sql) => sql === "select adapter_fixture;",
      error: databaseError("57014"),
    });

    const message = migrationFailureMessage(thrown);
    expect(message).toBe("Database migration exceeded its statement timeout.");
    expect(message).not.toContain("canary");
  });

  it("prints an actionable message when another migrator holds the lock too long without the driver message", async () => {
    const thrown = await runMigrationsFailingWith({
      failOn: (sql) => sql.startsWith("select pg_advisory_lock"),
      error: databaseError("55P03"),
    });

    const message = migrationFailureMessage(thrown);
    expect(message).toBe(
      "Database migration waited too long for another migrator to finish. Check for a stuck migration task.",
    );
    expect(message).not.toContain("canary");
  });

  it("keeps any other driver failure behind the generic message", async () => {
    const thrown = await runMigrationsFailingWith({
      failOn: (sql) => sql === "select adapter_fixture;",
      error: databaseError("42601"),
    });

    expect(migrationFailureMessage(thrown)).toBe("Database migration failed.");
  });
});

describe("Secrets Manager client lifecycle", () => {
  it.each([
    { outcome: "success", apply: () => Promise.resolve({ applied: [] }) },
    {
      outcome: "failure",
      apply: () => Promise.reject(new Error("migration failed")),
    },
  ])(
    "destroys the Secrets Manager client after closing the database, on $outcome",
    async ({ outcome, apply }) => {
      const events: string[] = [];
      const secretClient = {
        send: vi.fn(),
        destroy: vi.fn(() => {
          events.push("secret client destroyed");
        }),
      };
      const resolveDatabase = vi.fn(
        (input: Parameters<ResolveDatabaseConfig>[0]) =>
          resolveDatabaseConfig(input),
      );

      const run = runMigrations(
        {
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://example/starter",
        },
        {
          createSecretClient: () => secretClient,
          resolveDatabase,
          migrate: (options) =>
            migrateDatabase({
              ...options,
              apply,
              createResources: () => ({
                db: {} as never,
                pool: {} as never,
                close: () => {
                  events.push("database closed");
                  return Promise.resolve();
                },
              }),
              log: vi.fn(),
            }),
        },
      );

      if (outcome === "success") await run;
      else await expect(run).rejects.toThrow("migration failed");
      expect(resolveDatabase).toHaveBeenCalledWith(expect.anything(), {
        secretClient,
      });
      expect(events).toEqual(["database closed", "secret client destroyed"]);
    },
  );

  it("destroys the Secrets Manager client when the configuration is rejected", async () => {
    const secretClient = { send: vi.fn(), destroy: vi.fn() };
    const migrate = vi.fn();

    await expect(
      runMigrations(
        { NODE_ENV: "production" },
        {
          createSecretClient: () => secretClient,
          resolveDatabase: resolveDatabaseConfig,
          migrate,
        },
      ),
    ).rejects.toThrow("DATABASE_URL is required in production");
    expect(migrate).not.toHaveBeenCalled();
    expect(secretClient.destroy).toHaveBeenCalledOnce();
  });
});

describe("migration CLI", () => {
  it("reports fixed configuration guidance without exposing runtime canaries", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./migrate.ts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: {
          ...processEnvironmentWithoutDatabaseSettings(),
          NODE_ENV: "production",
          PGHOST: "db-canary.example.internal",
          COOKIE_CANARY: "cookie-canary",
          TOKEN_CANARY: "token-canary",
          NONCE_CANARY: "nonce-canary",
          STATE_CANARY: "state-canary",
          VERIFIER_CANARY: "verifier-canary",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "Structured PostgreSQL configuration requires PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD or PGPASSWORD_SECRET_ARN, and PGSSLROOTCERT",
    );
    for (const canary of [
      "db-canary.example.internal",
      "cookie-canary",
      "token-canary",
      "nonce-canary",
      "state-canary",
      "verifier-canary",
    ]) {
      expect(result.stderr).not.toContain(canary);
      expect(result.stdout).not.toContain(canary);
    }
  });
});
