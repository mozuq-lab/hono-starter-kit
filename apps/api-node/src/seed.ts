import { pathToFileURL } from "node:url";
import { getDevIdentity } from "@starter/backend";
import { seedDatabase as seedPackageDatabase } from "@starter/database";
import {
  resolveDatabaseConfig,
  type DatabaseEnvironment,
  type ResolveDatabaseConfig,
} from "./database-config.js";
import { createSecretClient, type SecretClient } from "./database-password.js";
import { migrationSessionPolicy } from "./database-session-policy.js";
import { devUserId } from "./dev-user.js";

type SeedDependencies = {
  createSecretClient(): SecretClient;
  resolveDatabase: ResolveDatabaseConfig;
  seedDatabase: typeof seedPackageDatabase;
};

const defaultDependencies: SeedDependencies = {
  createSecretClient,
  resolveDatabase: resolveDatabaseConfig,
  seedDatabase: seedPackageDatabase,
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

export const runSeed = async (
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<SeedDependencies> = {},
): Promise<void> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  // seedDatabase は戻る前に pool を閉じるので、destroy は必ず DB を閉じたあとになる。
  const secretClient = dependencies.createSecretClient();
  try {
    const connection = await dependencies.resolveDatabase(
      {
        nodeEnv: environment.NODE_ENV,
        databaseEnvironment: databaseEnvironmentFrom(environment),
      },
      { secretClient },
    );
    // seed は運用者が手で流す一回きりの処理で、API の 15 秒の上限は要らない。
    // Dev identity は backend が持つ。database は backend を型でしか読まないので、ここで解決して渡す。
    await dependencies.seedDatabase({
      connection,
      policy: migrationSessionPolicy,
      owner: { identity: getDevIdentity(), userId: devUserId },
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

const seedFailureMessage = (error: unknown) =>
  error instanceof Error && safeConfigurationMessages.has(error.message)
    ? error.message
    : "Database seed failed.";

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runSeed();
  } catch (error) {
    console.error(seedFailureMessage(error));
    process.exitCode = 1;
  }
}
