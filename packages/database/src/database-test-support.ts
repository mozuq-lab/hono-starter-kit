import { rm } from "node:fs/promises";
import type { Pool } from "pg";
import { runWithCleanup } from "./cleanup.js";
import { defaultMigrationsDirectory } from "./migration-files.js";
import { applyMigrations } from "./migration-runner.js";
import {
  createDatabaseResources,
  type DatabaseResources,
  type DatabaseSessionPolicy,
} from "./database.js";

// check:docker（test）と pnpm test:db（dbtest）が生成する使い捨て compose project の名前。
const ownedProjectPattern =
  /^hono-starter-kit-(test|dbtest)-[1-9][0-9]*-[a-f0-9]{16}$/u;
// runner が所有する postgres の中に compose exec で作る DB の名前。開発用の DB（starter）は
// この形に当てはまらないので、DATABASE_URL を開発用 DB に向けても開く前に拒否できる。
const ownedDatabaseNamePattern = /^starter_test_[a-f0-9]{16}$/u;
const refusalMessage =
  "Refusing destructive database integration test: DATABASE_URL must name the owned test database STARTER_DATABASE_TEST_NAME (starter_test_<16 hex>) of an owned test project.";

// 受け付ける接続先は 2 つだけ。compose の network の中（check:docker の db-test）と、
// ホストのループバックに公開したポート（test:db）。開発用 postgres も 127.0.0.1 に
// 同じ資格情報で公開されているので、ホストとポートでは区別できない。区別は DB 名が担う。
const isOwnedHostAndPort = (hostname: string, port: string): boolean =>
  (hostname === "postgres" && port === "5432") ||
  (hostname === "127.0.0.1" && /^[1-9][0-9]{0,4}$/u.test(port));

const hasOwnedDatabaseTarget = (
  databaseUrl: string,
  ownedDatabaseName: string,
): boolean => {
  try {
    const parsed = new URL(databaseUrl);
    return (
      parsed.protocol === "postgresql:" &&
      parsed.username === "starter" &&
      parsed.password === "starter" &&
      isOwnedHostAndPort(parsed.hostname, parsed.port) &&
      parsed.pathname === `/${ownedDatabaseName}` &&
      // pg は query の host や options でも接続先を変えられるので、何も付けさせない。
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
};

// 既存の統合テストは長い DDL と同時実行を確かめるので、サーバー側のタイムアウトは付けない。
// タイムアウトの挙動を確かめるテストは policy を差し替える。
export const integrationTestSessionPolicy: DatabaseSessionPolicy = {
  maxConnections: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  statementTimeoutMillis: false,
  idleInTransactionSessionTimeoutMillis: false,
};

const schemaNamePattern = /^[a-z_][a-z0-9_]{0,62}$/u;

// 専用 schema で動かすテスト用の startup option。接続後の SET だと、失敗しても最初のクエリが
// public に流れてしまうので、client が貸し出される前に効く startup parameter で渡す。
// 値は option 文字列に埋め込むので、識別子として安全な形だけを通す。
export const toSearchPathStartupOption = (schema: string): string => {
  if (!schemaNamePattern.test(schema)) {
    throw new Error(`Invalid test schema name: ${JSON.stringify(schema)}`);
  }
  return `-c search_path=${schema}`;
};

/** guard を通った接続と、破壊的な操作の直前に照合する所有 DB の名前。 */
export type GuardedDatabaseResources = DatabaseResources & {
  readonly ownedDatabaseName: string;
};

export const createGuardedDatabaseIntegrationResources = ({
  createResources = createDatabaseResources,
  environment,
  policy = integrationTestSessionPolicy,
  schema,
}: {
  createResources?: typeof createDatabaseResources;
  environment: Readonly<Record<string, string | undefined>>;
  policy?: DatabaseSessionPolicy;
  /** 指定すると、全接続の search_path をこの schema に固定する。 */
  schema?: string;
}): GuardedDatabaseResources => {
  const databaseUrl = environment.DATABASE_URL?.trim() ?? "";
  const project = environment.STARTER_DATABASE_TEST_PROJECT?.trim() ?? "";
  const ownedDatabaseName =
    environment.STARTER_DATABASE_TEST_NAME?.trim() ?? "";

  if (
    !ownedProjectPattern.test(project) ||
    !ownedDatabaseNamePattern.test(ownedDatabaseName) ||
    !hasOwnedDatabaseTarget(databaseUrl, ownedDatabaseName)
  ) {
    throw new Error(refusalMessage);
  }

  const startupOptions =
    schema === undefined ? undefined : toSearchPathStartupOption(schema);
  return {
    ...createResources({
      connection: { mode: "url", connectionString: databaseUrl },
      policy,
      ...(startupOptions === undefined ? {} : { startupOptions }),
    }),
    ownedDatabaseName,
  };
};

export const closeDatabaseIntegrationResources = async ({
  close,
  remove = (path) => rm(path, { force: true, recursive: true }),
  temporaryMigrationsRoot,
}: {
  close: () => Promise<void>;
  remove?: (path: string) => Promise<void>;
  temporaryMigrationsRoot: string | undefined;
}): Promise<void> => {
  await runWithCleanup(close, async () => {
    if (temporaryMigrationsRoot !== undefined) {
      await remove(temporaryMigrationsRoot);
    }
  });
};

type Queryable = Pick<Pool, "query">;

// URL の guard は「どこへ繋ぐつもりか」しか見ない。破壊的な文の直前に、実際に繋がった DB を
// サーバーに問い合わせて照合する。pool や接続の取り違えがあっても、ここで止まる。
export const assertConnectedToOwnedDatabase = async (
  pool: Queryable,
  ownedDatabaseName: string,
): Promise<void> => {
  const result = await pool.query<{ current_database: string }>(
    "select current_database()",
  );
  const connected = result.rows[0]?.current_database;
  if (
    !ownedDatabaseNamePattern.test(ownedDatabaseName) ||
    connected !== ownedDatabaseName
  ) {
    throw new Error(
      `Refusing destructive database integration test: connected to database ${JSON.stringify(connected ?? null)}, not the owned test database.`,
    );
  }
};

// public は他のファイルが resetSchema で扱う。専用 schema の片付けで public を消さないよう拒否する。
const assertTestSchemaName = (schema: string): void => {
  if (!schemaNamePattern.test(schema) || schema === "public") {
    throw new Error(`Invalid test schema name: ${JSON.stringify(schema)}`);
  }
};

// 専用 schema で動くテストの片付け。afterAll でも drop の直前に接続先を照合し直すので、
// beforeAll の照合に失敗した pool が残っていても、ここで止まる。
export const dropTestSchema = async (
  pool: Queryable,
  ownedDatabaseName: string,
  schema: string,
): Promise<void> => {
  assertTestSchemaName(schema);
  await assertConnectedToOwnedDatabase(pool, ownedDatabaseName);
  await pool.query(`drop schema if exists ${schema} cascade`);
};

export const recreateTestSchema = async (
  pool: Queryable,
  ownedDatabaseName: string,
  schema: string,
): Promise<void> => {
  await dropTestSchema(pool, ownedDatabaseName, schema);
  await pool.query(`create schema ${schema}`);
};

// テストごとに空の public から始める。テスト間で状態を持ち越さないことが、ファイルを
// 分割した目的そのものである。transaction の rollback で分けないのは、同時実行のテストが
// 複数の接続を使い、1 つの transaction に収まらないため。
export const resetSchema = async (
  pool: Queryable,
  ownedDatabaseName: string,
): Promise<void> => {
  await assertConnectedToOwnedDatabase(pool, ownedDatabaseName);
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
};

export const resetToLatestSchema = async (
  pool: Pool,
  ownedDatabaseName: string,
): Promise<void> => {
  await resetSchema(pool, ownedDatabaseName);
  await applyMigrations({
    pool,
    migrationsDirectory: defaultMigrationsDirectory,
  });
};
