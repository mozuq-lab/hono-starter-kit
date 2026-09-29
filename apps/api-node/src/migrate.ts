import { pathToFileURL } from "node:url";
import {
  getActionableMigrationStateErrorMessage,
  migrate as migrateDatabase,
} from "@starter/database";
import {
  resolveDatabaseConfig,
  type DatabaseEnvironment,
  type ResolveDatabaseConfig,
} from "./database-config.js";
import { createSecretClient, type SecretClient } from "./database-password.js";
import { migrationSessionPolicy } from "./database-session-policy.js";

type MigrationDependencies = {
  createSecretClient(): SecretClient;
  migrate: typeof migrateDatabase;
  resolveDatabase: ResolveDatabaseConfig;
};

const defaultDependencies: MigrationDependencies = {
  createSecretClient,
  migrate: migrateDatabase,
  resolveDatabase: resolveDatabaseConfig,
};

const databaseEnvironmentFrom = (
  environment: NodeJS.ProcessEnv,
): DatabaseEnvironment => ({
  ...(environment.DATABASE_URL === undefined
    ? {}
    : { DATABASE_URL: environment.DATABASE_URL }),
  ...(environment.PGHOST === undefined ? {} : { PGHOST: environment.PGHOST }),
  ...(environment.PGPORT === undefined ? {} : { PGPORT: environment.PGPORT }),
  ...(environment.PGDATABASE === undefined
    ? {}
    : { PGDATABASE: environment.PGDATABASE }),
  ...(environment.PGUSER === undefined ? {} : { PGUSER: environment.PGUSER }),
  ...(environment.PGPASSWORD === undefined
    ? {}
    : { PGPASSWORD: environment.PGPASSWORD }),
  ...(environment.PGPASSWORD_SECRET_ARN === undefined
    ? {}
    : { PGPASSWORD_SECRET_ARN: environment.PGPASSWORD_SECRET_ARN }),
  ...(environment.PGSSLROOTCERT === undefined
    ? {}
    : { PGSSLROOTCERT: environment.PGSSLROOTCERT }),
});

// マイグレーションを適用するのはこの CLI だけ。API 起動時
// （runtime-composition の assertMigrations）は状態を検査するだけで適用しない。
export const runMigrations = async (
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<MigrationDependencies> = {},
): Promise<void> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  const migrationsDirectory = environment.MIGRATIONS_DIRECTORY?.trim();
  // migrate は戻る前に pool を閉じるので、destroy は必ず DB を閉じたあとになる。
  const secretClient = dependencies.createSecretClient();
  try {
    const connection = await dependencies.resolveDatabase(
      {
        nodeEnv: environment.NODE_ENV,
        databaseEnvironment: databaseEnvironmentFrom(environment),
      },
      { secretClient },
    );
    await dependencies.migrate({
      connection,
      policy: migrationSessionPolicy,
      ...(migrationsDirectory === undefined || migrationsDirectory === ""
        ? {}
        : { migrationsDirectory }),
    });
  } finally {
    secretClient.destroy();
  }
};

const safeConfigurationMessages = new Set([
  "NODE_ENV must be development, production, or test",
  "DATABASE_URL is required in production",
  "DATABASE_URL is unavailable in test runtime",
  "DATABASE_URL must be a valid PostgreSQL URL",
  "DATABASE_URL cannot be combined with structured PostgreSQL settings",
  "Structured PostgreSQL configuration requires PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD or PGPASSWORD_SECRET_ARN, and PGSSLROOTCERT",
  "PGPASSWORD cannot be combined with PGPASSWORD_SECRET_ARN",
  "PGPORT must be a base-10 integer from 1 to 65535",
  "PGHOST and PGDATABASE must be non-blank and contain no control characters",
  "PGSSLROOTCERT must reference a readable PEM certificate bundle",
]);

// 設定の誤りと、運用者の次の行動を示す migration の失敗（checksum の不一致、履歴の食い違い、
// ロック待ちの上限、statement_timeout）だけを表示する。それ以外はドライバの message に
// 接続先や SQL の断片が入りうるので、固定の文言にする。
export const migrationFailureMessage = (error: unknown): string =>
  error instanceof Error && safeConfigurationMessages.has(error.message)
    ? error.message
    : (getActionableMigrationStateErrorMessage(error) ??
      "Database migration failed.");

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runMigrations();
  } catch (error) {
    console.error(migrationFailureMessage(error));
    process.exitCode = 1;
  }
}
