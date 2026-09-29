import type { ProjectRepository, ProjectUnitOfWork } from "@starter/backend";
import type { Kysely } from "kysely";
import type { Database } from "./database.types.js";
import { KyselyProjectRepository } from "./project.repository.kysely.js";

export class KyselyProjectUnitOfWork implements ProjectUnitOfWork {
  constructor(private readonly db: Kysely<Database>) {}

  execute<T>(
    work: (repositories: { projects: ProjectRepository }) => Promise<T>,
  ): Promise<T> {
    return this.db
      .transaction()
      .execute((transaction) =>
        work({ projects: new KyselyProjectRepository(transaction) }),
      );
  }
}
