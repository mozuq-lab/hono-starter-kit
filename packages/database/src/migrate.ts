import { runWithCleanup } from "./cleanup.js";
import {
  createDatabaseResources,
  type DatabaseConnectionConfig,
  type DatabaseSessionPolicy,
} from "./database.js";
import { applyMigrations } from "./migration-runner.js";

export const migrate = async ({
  connection,
  policy,
  migrationsDirectory,
  apply = applyMigrations,
  createResources = createDatabaseResources,
  log = console.log,
}: {
  connection: DatabaseConnectionConfig;
  policy: DatabaseSessionPolicy;
  migrationsDirectory?: string;
  apply?: typeof applyMigrations;
  createResources?: typeof createDatabaseResources;
  log?: (message: string) => void;
}): Promise<void> => {
  const resources = createResources({ connection, policy });
  await runWithCleanup(
    () =>
      apply({
        pool: resources.pool,
        ...(migrationsDirectory === undefined ? {} : { migrationsDirectory }),
      }),
    () => resources.close(),
  );
  log("Database migrations applied.");
};
