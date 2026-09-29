import { classifyProjectMutation } from "./classify-project-mutation.js";
import type { Actor } from "../../platform/auth/auth.model.js";
import type { Project } from "./project.model.js";
import type { ProjectUnitOfWork } from "./project.unit-of-work.js";

export const createArchiveProject =
  ({
    clock,
    unitOfWork,
  }: {
    clock: () => Date;
    unitOfWork: ProjectUnitOfWork;
  }) =>
  async (input: {
    actor: Actor;
    id: string;
    version: number;
  }): Promise<Project> => {
    const updatedAt = new Date(clock().getTime());
    return unitOfWork.execute(async ({ projects }) => {
      const target = { id: input.id, ownerUserId: input.actor.userId };
      const archived = await projects.archive({
        ...target,
        expectedVersion: input.version,
        updatedAt,
      });
      return archived ?? classifyProjectMutation(projects, target);
    });
  };

export type ArchiveProject = ReturnType<typeof createArchiveProject>;
