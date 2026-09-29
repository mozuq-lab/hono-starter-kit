import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { createDatabaseResources, DatabaseResources } from "./database.js";
import {
  assertConnectedToOwnedDatabase,
  closeDatabaseIntegrationResources,
  dropTestSchema,
  recreateTestSchema,
  createGuardedDatabaseIntegrationResources,
  resetSchema,
  resetToLatestSchema,
  toSearchPathStartupOption,
} from "./database-test-support.js";

const ownedDatabaseName = "starter_test_0123456789abcdef";
const composeDatabaseUrl = `postgresql://starter:starter@postgres:5432/${ownedDatabaseName}`;
const hostDatabaseUrl = `postgresql://starter:starter@127.0.0.1:55432/${ownedDatabaseName}`;
const checkDockerProject = "hono-starter-kit-test-1234-a1b2c3d4e5f60708";
const testDatabaseProject = "hono-starter-kit-dbtest-1234-a1b2c3d4e5f60708";
const ownedEnvironment = {
  DATABASE_URL: composeDatabaseUrl,
  STARTER_DATABASE_TEST_NAME: ownedDatabaseName,
  STARTER_DATABASE_TEST_PROJECT: checkDockerProject,
};
const refusalMessage =
  "Refusing destructive database integration test: DATABASE_URL must name the owned test database STARTER_DATABASE_TEST_NAME (starter_test_<16 hex>) of an owned test project.";

const fakeResources = {
  close() {},
  db: {},
  pool: {},
} as unknown as DatabaseResources;

const openCountingResources = () => {
  const opened: string[] = [];
  return {
    opened,
    createResources: (({ connection }) => {
      if (connection.mode === "url") opened.push(connection.connectionString);
      return fakeResources;
    }) satisfies typeof createDatabaseResources,
  };
};

// current_database() の応答と、流れた SQL を記録する偽の pool。
const createFakePool = (currentDatabase: string) => {
  const statements: string[] = [];
  const pool = {
    query: (sql: string) => {
      statements.push(sql);
      return Promise.resolve({
        rows: sql.includes("current_database()")
          ? [{ current_database: currentDatabase }]
          : [],
      });
    },
  } as unknown as Pool;
  return { pool, statements };
};

describe("destructive database integration-test ownership", () => {
  it("rejects direct normal Compose defaults before opening a database resource", () => {
    const { opened, createResources } = openCountingResources();

    expect(() =>
      createGuardedDatabaseIntegrationResources({
        createResources,
        environment: {
          DATABASE_URL: "postgresql://starter:starter@postgres:5432/starter",
        },
      }),
    ).toThrow(refusalMessage);
    expect(opened).toEqual([]);
  });

  it.each([
    {
      label: "a non-owned project",
      environment: {
        ...ownedEnvironment,
        STARTER_DATABASE_TEST_PROJECT: "hono-starter-kit",
      },
    },
    {
      label: "a missing owned database name (compose passes an empty value)",
      environment: {
        DATABASE_URL: "postgresql://starter:starter@postgres:5432/",
        STARTER_DATABASE_TEST_NAME: "",
        STARTER_DATABASE_TEST_PROJECT: checkDockerProject,
      },
    },
    {
      label:
        "the database name in DATABASE_URL differs from STARTER_DATABASE_TEST_NAME",
      environment: {
        ...ownedEnvironment,
        DATABASE_URL:
          "postgresql://starter:starter@postgres:5432/starter_test_ffffffffffffffff",
      },
    },
    {
      label: "the development database name starter even with an owned project",
      environment: {
        DATABASE_URL: "postgresql://starter:starter@127.0.0.1:5432/starter",
        STARTER_DATABASE_TEST_NAME: "starter",
        STARTER_DATABASE_TEST_PROJECT: testDatabaseProject,
      },
    },
    {
      label:
        "the development database at 127.0.0.1:5432 with an owned name set",
      environment: {
        DATABASE_URL: "postgresql://starter:starter@127.0.0.1:5432/starter",
        STARTER_DATABASE_TEST_NAME: ownedDatabaseName,
        STARTER_DATABASE_TEST_PROJECT: testDatabaseProject,
      },
    },
    {
      label: "a host other than postgres:5432 or 127.0.0.1 (localhost)",
      environment: {
        ...ownedEnvironment,
        DATABASE_URL: `postgresql://starter:starter@localhost:55432/${ownedDatabaseName}`,
      },
    },
    {
      label: "a host other than postgres:5432 or 127.0.0.1 (remote)",
      environment: {
        ...ownedEnvironment,
        DATABASE_URL: `postgresql://starter:starter@db.example.com:5432/${ownedDatabaseName}`,
      },
    },
    {
      label: "the compose host on another port",
      environment: {
        ...ownedEnvironment,
        DATABASE_URL: `postgresql://starter:starter@postgres:6543/${ownedDatabaseName}`,
      },
    },
    {
      label: "the loopback host without an explicit port",
      environment: {
        ...ownedEnvironment,
        DATABASE_URL: `postgresql://starter:starter@127.0.0.1/${ownedDatabaseName}`,
      },
    },
    {
      label: "query parameters that could redirect the connection",
      environment: {
        ...ownedEnvironment,
        DATABASE_URL: `${composeDatabaseUrl}?host=/var/run/postgresql`,
      },
    },
    {
      label: "credentials other than the compose test user",
      environment: {
        ...ownedEnvironment,
        DATABASE_URL: `postgresql://postgres:starter@postgres:5432/${ownedDatabaseName}`,
      },
    },
  ])("rejects $label before opening a database resource", ({ environment }) => {
    const { opened, createResources } = openCountingResources();

    expect(() =>
      createGuardedDatabaseIntegrationResources({
        createResources,
        environment,
      }),
    ).toThrow(refusalMessage);
    expect(opened).toEqual([]);
  });

  it.each([
    {
      label: "the compose path used by check:docker",
      environment: ownedEnvironment,
    },
    {
      label: "the host path used by test:db",
      environment: {
        DATABASE_URL: hostDatabaseUrl,
        STARTER_DATABASE_TEST_NAME: ownedDatabaseName,
        STARTER_DATABASE_TEST_PROJECT: testDatabaseProject,
      },
    },
  ])("accepts $label when every condition holds", ({ environment }) => {
    const { opened, createResources } = openCountingResources();

    const resources = createGuardedDatabaseIntegrationResources({
      createResources,
      environment,
    });

    expect(resources.ownedDatabaseName).toBe(ownedDatabaseName);
    expect(resources.pool).toBe(fakeResources.pool);
    expect(opened).toEqual([environment.DATABASE_URL]);
  });
});

describe("current_database() check before destructive statements", () => {
  it("refuses to reset when current_database() differs from the owned name", async () => {
    const { pool, statements } = createFakePool("starter");

    await expect(resetSchema(pool, ownedDatabaseName)).rejects.toThrow(
      'Refusing destructive database integration test: connected to database "starter", not the owned test database.',
    );
    await expect(resetToLatestSchema(pool, ownedDatabaseName)).rejects.toThrow(
      "not the owned test database",
    );
    await expect(
      assertConnectedToOwnedDatabase(pool, ownedDatabaseName),
    ).rejects.toThrow("not the owned test database");
    expect(statements.some((sql) => /drop|create/iu.test(sql))).toBe(false);
  });

  it("recreates the public schema only after current_database() matches", async () => {
    const { pool, statements } = createFakePool(ownedDatabaseName);

    await resetSchema(pool, ownedDatabaseName);

    expect(statements).toEqual([
      "select current_database()",
      "drop schema public cascade",
      "create schema public",
    ]);
  });
});

describe("schema-scoped test cleanup", () => {
  it("refuses to recreate or drop a test schema when current_database() differs from the owned name", async () => {
    const { pool, statements } = createFakePool("starter");

    await expect(
      recreateTestSchema(pool, ownedDatabaseName, "starter_scoped_test"),
    ).rejects.toThrow("not the owned test database");
    await expect(
      dropTestSchema(pool, ownedDatabaseName, "starter_scoped_test"),
    ).rejects.toThrow("not the owned test database");
    expect(statements.some((sql) => /drop|create/iu.test(sql))).toBe(false);
  });

  it("drops and recreates the test schema only after current_database() matches", async () => {
    const { pool, statements } = createFakePool(ownedDatabaseName);

    await recreateTestSchema(pool, ownedDatabaseName, "starter_scoped_test");
    await dropTestSchema(pool, ownedDatabaseName, "starter_scoped_test");

    expect(statements).toEqual([
      "select current_database()",
      "drop schema if exists starter_scoped_test cascade",
      "create schema starter_scoped_test",
      "select current_database()",
      "drop schema if exists starter_scoped_test cascade",
    ]);
  });

  it.each(["public", "", "a b", "x; drop schema public"])(
    "refuses the test schema name %j before querying",
    async (schema) => {
      const { pool, statements } = createFakePool(ownedDatabaseName);

      await expect(
        dropTestSchema(pool, ownedDatabaseName, schema),
      ).rejects.toThrow("Invalid test schema name");
      await expect(
        recreateTestSchema(pool, ownedDatabaseName, schema),
      ).rejects.toThrow("Invalid test schema name");
      expect(statements).toEqual([]);
    },
  );
});

it("removes copied migrations even when database resource close fails", async () => {
  const closeFailure = new Error("close failed");
  const removed: string[] = [];

  await expect(
    closeDatabaseIntegrationResources({
      close: () => Promise.reject(closeFailure),
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
      temporaryMigrationsRoot: "/tmp/copied-migrations",
    }),
  ).rejects.toBe(closeFailure);
  expect(removed).toEqual(["/tmp/copied-migrations"]);
});

describe("search_path startup option for schema-scoped integration tests", () => {
  it("passes the search_path as a startup option to the pool", () => {
    const startupOptions: (string | undefined)[] = [];

    createGuardedDatabaseIntegrationResources({
      createResources: (input) => {
        startupOptions.push(input.startupOptions);
        return fakeResources;
      },
      environment: ownedEnvironment,
      schema: "starter_scoped_test",
    });

    expect(startupOptions).toEqual(["-c search_path=starter_scoped_test"]);
  });

  it("adds no startup option when no schema is given", () => {
    const startupOptions: (string | undefined)[] = [];

    createGuardedDatabaseIntegrationResources({
      createResources: (input) => {
        startupOptions.push(input.startupOptions);
        return fakeResources;
      },
      environment: ownedEnvironment,
    });

    expect(startupOptions).toEqual([undefined]);
  });

  it.each(["", "public; drop", "Upper", "a b", "-c x", "x".repeat(64)])(
    "rejects the schema name %j before opening a database resource",
    (schema) => {
      let openCount = 0;

      expect(() =>
        createGuardedDatabaseIntegrationResources({
          createResources: () => {
            openCount += 1;
            return fakeResources;
          },
          environment: ownedEnvironment,
          schema,
        }),
      ).toThrow("Invalid test schema name");
      expect(openCount).toBe(0);
      expect(() => toSearchPathStartupOption(schema)).toThrow();
    },
  );
});
