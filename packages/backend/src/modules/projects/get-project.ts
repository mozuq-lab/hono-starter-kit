import type { Actor } from "../../platform/auth/auth.model.js";
import type { Project } from "./project.model.js";
import { ProjectNotFoundError } from "./project.errors.js";
import type { ProjectRepository } from "./project.repository.js";

export const createGetProject =
  (repository: ProjectRepository) =>
  async ({ actor, id }: { actor: Actor; id: string }): Promise<Project> => {
    const project = await repository.findById({
      id,
      ownerUserId: actor.userId,
    });
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  };

export type GetProject = ReturnType<typeof createGetProject>;
