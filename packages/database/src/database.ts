import { createRequire } from "node:module";
import { Kysely, PostgresDialect } from "kysely";
import type { Pool as PgPool } from "pg";
import type { PoolConfig } from "pg";
import type { Database } from "./database.types.js";

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as typeof import("pg");

export type DatabaseResources = {
  db: Kysely<Database>;
  pool: PgPool;
  close(): Promise<void>;
};

export type DatabaseConnectionConfig =
  | { mode: "url"; connectionString: string }
  | {
      mode: "structured";
      host: string;
      port: number;
      database: string;
      user: string;
      password: string | (() => Promise<string>);
      ssl: { ca: string; rejectUnauthorized: true };
    };

/**
 * pool と各接続のタイムアウト方針。値は配備構成を知る composition 側（api-node）が決め、
 * このパッケージは pg の設定へ写すだけにする。
 *
 * `statementTimeoutMillis` を超えるクエリが正当に必要なら、トランザクション内で
 * `SET LOCAL statement_timeout = '60s'` のように書くと、そのトランザクションだけ延ばせる。
 */
export type DatabaseSessionPolicy = Readonly<{
  maxConnections: number;
  /** TCP 接続・TLS と認証・password の取得・pool の空き待ちのすべてにかかる上限。 */
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  /** `false` なら接続の起動パラメータに載せず、サーバーの既定（無効）に任せる。 */
  statementTimeoutMillis: number | false;
  idleInTransactionSessionTimeoutMillis: number | false;
}>;

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
};

const toPgSessionOptions = (policy: DatabaseSessionPolicy): PoolConfig => {
  assertPositiveInteger("maxConnections", policy.maxConnections);
  assertPositiveInteger(
    "connectionTimeoutMillis",
    policy.connectionTimeoutMillis,
  );
  assertPositiveInteger("idleTimeoutMillis", policy.idleTimeoutMillis);
  if (policy.statementTimeoutMillis !== false) {
    assertPositiveInteger(
      "statementTimeoutMillis",
      policy.statementTimeoutMillis,
    );
  }
  if (policy.idleInTransactionSessionTimeoutMillis !== false) {
    assertPositiveInteger(
      "idleInTransactionSessionTimeoutMillis",
      policy.idleInTransactionSessionTimeoutMillis,
    );
  }

  return {
    max: policy.maxConnections,
    connectionTimeoutMillis: policy.connectionTimeoutMillis,
    idleTimeoutMillis: policy.idleTimeoutMillis,
    ...(policy.statementTimeoutMillis === false
      ? {}
      : { statement_timeout: policy.statementTimeoutMillis }),
    ...(policy.idleInTransactionSessionTimeoutMillis === false
      ? {}
      : {
          idle_in_transaction_session_timeout:
            policy.idleInTransactionSessionTimeoutMillis,
        }),
  };
};

export const toPgPoolConfig = (
  connection: DatabaseConnectionConfig,
  policy: DatabaseSessionPolicy,
): PoolConfig => {
  const sessionOptions = toPgSessionOptions(policy);

  if (connection.mode === "url") {
    return {
      connectionString: connection.connectionString,
      ...sessionOptions,
    };
  }

  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl: connection.ssl,
    ...sessionOptions,
  };
};

// 既定の記録。ドライバの message には接続先が入りうるので出力しない。
// 構造化ログを持つ composition（api-node）は onClientError で差し替える。
const logClientErrorWithoutDetails = (): void => {
  console.error("PostgreSQL connection closed.");
};

export const createDatabaseResources = ({
  connection,
  policy,
  onClientError = logClientErrorWithoutDetails,
  startupOptions,
}: {
  connection: DatabaseConnectionConfig;
  policy: DatabaseSessionPolicy;
  /**
   * 接続の startup packet で渡す PostgreSQL の options（例 `-c search_path=x`）。
   * 接続後の SET と違い、client が貸し出される前に必ず効く。統合テストが専用 schema で動くために使う。
   */
  startupOptions?: string;
  /** サーバーやネットワークが接続を切ったときに呼ぶ。例外を投げないこと。 */
  onClientError?: (error: unknown) => void;
}): DatabaseResources => {
  const pool = new Pool({
    ...toPgPoolConfig(connection, policy),
    ...(startupOptions === undefined ? {} : { options: startupOptions }),
  });
  // pg-pool は貸し出し中の client から idle 用の error リスナーを外し、Kysely も付けない。
  // リスナーのない client にサーバーが切断を送ると（idle_in_transaction_session_timeout、
  // RDS の再起動やフェイルオーバー、pg_terminate_backend）、emit("error") が
  // uncaughtException になり API プロセスごと落ちる。切れた client は release 時に
  // pool から外されるので、ここでは記録だけすればよい。
  pool.on("connect", (client) => {
    client.on("error", onClientError);
  });
  // idle の client の切断は上の client リスナーも受けるので、記録を二重にしない。
  // pool の error が未処理のまま throw されないために、リスナーだけは残す。
  pool.on("error", () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool, close: () => db.destroy() };
};
