import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import {
  closeDatabaseIntegrationResources,
  createGuardedDatabaseIntegrationResources,
  resetSchema,
} from "./database-test-support.js";
import { defaultMigrationsDirectory } from "./migration-files.js";
import { applyMigrations } from "./migration-runner.js";
import { KyselyProjectRepository } from "./project.repository.kysely.js";

const resources = createGuardedDatabaseIntegrationResources({
  environment: process.env,
});
let temporaryRoot: string | undefined;

const createTemporaryRoot = async (): Promise<string> => {
  temporaryRoot = await mkdtemp(
    join(tmpdir(), "starter-database-integration-"),
  );
  return temporaryRoot;
};

// 空の schema から始めるのは migration の適用そのものを検証するため。最新の schema は各テストが作る。
beforeEach(async () => {
  await resetSchema(resources.pool, resources.ownedDatabaseName);
});

afterEach(async () => {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { force: true, recursive: true });
    temporaryRoot = undefined;
  }
});

afterAll(async () => {
  await closeDatabaseIntegrationResources({
    close: () => resources.close(),
    temporaryMigrationsRoot: temporaryRoot,
  });
});

const copyMigrations = async (
  directory: string,
  filenames: readonly string[],
): Promise<void> => {
  await mkdir(directory);
  for (const filename of filenames) {
    await cp(
      join(defaultMigrationsDirectory, filename),
      join(directory, filename),
    );
  }
};

const migrationsThrough0004 = [
  "0001_create_projects.sql",
  "0002_add_project_version.sql",
  "0003_create_auth.sql",
  "0004_create_external_login_transactions.sql",
] as const;

const insertOwner = () =>
  resources.pool.query(
    `insert into users (id, roles, created_at, updated_at)
     values ('user_owner', '{}', $1, $1)`,
    ["2026-08-01T00:00:00.000Z"],
  );

const appliedFilenames = async (): Promise<string[]> =>
  (
    await resources.pool.query<{ filename: string }>(
      "select filename from starter_migrations order by filename",
    )
  ).rows.map((row) => row.filename);

it("applies every migration to an empty schema and accepts a project through the repository", async () => {
  const { db, pool } = resources;

  expect(
    await applyMigrations({
      pool,
      migrationsDirectory: defaultMigrationsDirectory,
    }),
  ).toEqual({
    applied: [
      "0001_create_projects.sql",
      "0002_add_project_version.sql",
      "0003_create_auth.sql",
      "0004_create_external_login_transactions.sql",
      "0005_add_project_owner_and_created_at.sql",
    ],
  });
  await insertOwner();
  const freshRepository = new KyselyProjectRepository(db);
  await expect(
    freshRepository.create({
      id: "project_fresh",
      ownerUserId: "user_owner",
      name: "Fresh",
      status: "active",
      version: 1,
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    }),
  ).resolves.toMatchObject({ id: "project_fresh", version: 1 });
  await expect(
    freshRepository.findById({
      id: "project_fresh",
      ownerUserId: "user_owner",
    }),
  ).resolves.toMatchObject({ id: "project_fresh", name: "Fresh", version: 1 });
});

// 0001〜0002 だけが適用された環境から 0003〜0004 へ上がる経路は、順序そのものが検証対象なので、
// 1 つの it の中で順にたどる。0005 は行のある projects を拒否するので、ここでは 0004 までにする。
it("upgrades a schema that only has migrations 0001 and 0002 to 0004 without losing rows", async () => {
  const { pool } = resources;
  const root = await createTemporaryRoot();
  const legacyMigrationsDirectory = join(root, "legacy-migrations");
  const through0004Directory = join(root, "through-0004");
  await copyMigrations(
    legacyMigrationsDirectory,
    migrationsThrough0004.slice(0, 2),
  );
  await copyMigrations(through0004Directory, migrationsThrough0004);

  expect(
    await applyMigrations({
      pool,
      migrationsDirectory: legacyMigrationsDirectory,
    }),
  ).toEqual({
    applied: ["0001_create_projects.sql", "0002_add_project_version.sql"],
  });
  await pool.query(
    `insert into projects (id, name, status, updated_at)
     values ($1, $2, $3, $4)`,
    ["project_legacy", "Legacy", "active", "2026-08-02T00:00:00.000Z"],
  );

  expect(
    await applyMigrations({
      pool,
      migrationsDirectory: through0004Directory,
    }),
  ).toEqual({
    applied: [
      "0003_create_auth.sql",
      "0004_create_external_login_transactions.sql",
    ],
  });
  await expect(
    pool.query("select id, name, status, version from projects"),
  ).resolves.toMatchObject({
    rows: [
      { id: "project_legacy", name: "Legacy", status: "active", version: 1 },
    ],
  });
  await expect(
    pool.query<{
      sessions: string;
      user_identities: string;
      users: string;
    }>(`select
      to_regclass('public.users')::text as users,
      to_regclass('public.user_identities')::text as user_identities,
      to_regclass('public.sessions')::text as sessions`),
  ).resolves.toMatchObject({
    rows: [
      {
        sessions: "sessions",
        user_identities: "user_identities",
        users: "users",
      },
    ],
  });

  expect(
    await applyMigrations({
      pool,
      migrationsDirectory: through0004Directory,
    }),
  ).toEqual({ applied: [] });
});

it("applies 0005 to a schema through 0004 whose projects table is empty", async () => {
  const { pool } = resources;
  const root = await createTemporaryRoot();
  const through0004Directory = join(root, "through-0004");
  await copyMigrations(through0004Directory, migrationsThrough0004);
  await applyMigrations({ pool, migrationsDirectory: through0004Directory });

  expect(
    await applyMigrations({
      pool,
      migrationsDirectory: defaultMigrationsDirectory,
    }),
  ).toEqual({ applied: ["0005_add_project_owner_and_created_at.sql"] });
  // 一覧のクエリ（where owner_user_id = $1 order by created_at desc, id desc）を並べ替えなしで読む index。
  await expect(
    pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'projects_owner_created_at_idx'`,
    ),
  ).resolves.toMatchObject({
    rows: [
      {
        indexdef: expect.stringContaining(
          "(owner_user_id, created_at DESC, id DESC)",
        ) as unknown,
      },
    ],
  });
});

// 既存環境はない前提なので backfill を持たない。行のある DB には適用せず、所有者のない行を作らない。
it("refuses to apply 0005 while the projects table has rows and leaves the schema at 0004", async () => {
  const { pool } = resources;
  const root = await createTemporaryRoot();
  const through0004Directory = join(root, "through-0004");
  await copyMigrations(through0004Directory, migrationsThrough0004);
  await applyMigrations({ pool, migrationsDirectory: through0004Directory });
  await pool.query(
    `insert into projects (id, name, status, updated_at)
     values ($1, $2, $3, $4)`,
    ["project_legacy", "Legacy", "active", "2026-08-02T00:00:00.000Z"],
  );

  // 23502 は not_null_violation。NOT NULL で default のない列を、行のある表に足せない。
  await expect(
    applyMigrations({
      pool,
      migrationsDirectory: defaultMigrationsDirectory,
    }),
  ).rejects.toMatchObject({ code: "23502" });
  await expect(appliedFilenames()).resolves.toEqual([...migrationsThrough0004]);
  await expect(
    pool.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'projects'
         and column_name in ('owner_user_id', 'created_at')`,
    ),
  ).resolves.toMatchObject({ rowCount: 0 });
  await expect(pool.query("select id from projects")).resolves.toMatchObject({
    rows: [{ id: "project_legacy" }],
  });
});

it("rejects an applied migration whose file content changed", async () => {
  const { pool } = resources;
  await applyMigrations({
    pool,
    migrationsDirectory: defaultMigrationsDirectory,
  });
  const root = await createTemporaryRoot();

  const copiedMigrationsDirectory = join(root, "migrations");
  await cp(defaultMigrationsDirectory, copiedMigrationsDirectory, {
    recursive: true,
  });
  const copiedAppliedMigration = join(
    copiedMigrationsDirectory,
    "0001_create_projects.sql",
  );
  const changedMigration = await readFile(copiedAppliedMigration);
  changedMigration[0] = (changedMigration[0] ?? 0) ^ 1;
  await writeFile(copiedAppliedMigration, changedMigration);

  await expect(
    applyMigrations({
      pool,
      migrationsDirectory: copiedMigrationsDirectory,
    }),
  ).rejects.toThrow("Migration checksum mismatch: 0001_create_projects.sql");
});
