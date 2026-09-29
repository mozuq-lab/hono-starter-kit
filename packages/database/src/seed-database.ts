import { runWithCleanup } from "./cleanup.js";
import {
  createDatabaseResources,
  type DatabaseConnectionConfig,
  type DatabaseSessionPolicy,
} from "./database.js";
import { seedAlphaProject, type AlphaOwner } from "./seed.js";

export const seedDatabase = async ({
  connection,
  policy,
  owner,
  createResources = createDatabaseResources,
  log = console.log,
  seedProject = seedAlphaProject,
}: {
  connection: DatabaseConnectionConfig;
  policy: DatabaseSessionPolicy;
  owner: AlphaOwner;
  createResources?: typeof createDatabaseResources;
  log?: (message: string) => void;
  seedProject?: typeof seedAlphaProject;
}): Promise<void> => {
  const resources = createResources({ connection, policy });
  await runWithCleanup(
    () => seedProject(resources.db, owner),
    () => resources.close(),
  );
  log("Database seed completed.");
};
