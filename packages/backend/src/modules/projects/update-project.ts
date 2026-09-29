import type { Actor } from "../../platform/auth/auth.model.js";
import type { Project } from "./project.model.js";
import { normalizeProjectName } from "./project-name.js";
import type { ProjectUnitOfWork } from "./project.unit-of-work.js";
import { classifyProjectMutation } from "./classify-project-mutation.js";

export const createUpdateProject =
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
    name: string;
    version: number;
  }): Promise<Project> => {
    const name = normalizeProjectName(input.name);
    const updatedAt = new Date(clock().getTime());
    return unitOfWork.execute(async ({ projects }) => {
      const target = { id: input.id, ownerUserId: input.actor.userId };
      const updated = await projects.update({
        ...target,
        name,
        expectedVersion: input.version,
        updatedAt,
      });
      return updated ?? classifyProjectMutation(projects, target);
    });
  };

export type UpdateProject = ReturnType<typeof createUpdateProject>;
