import type { Actor } from "../../platform/auth/auth.model.js";
import type { Project } from "./project.model.js";
import { normalizeProjectName } from "./project-name.js";
import type { ProjectUnitOfWork } from "./project.unit-of-work.js";

export const createCreateProject =
  ({
    clock,
    generateId,
    unitOfWork,
  }: {
    clock: () => Date;
    generateId: () => string;
    unitOfWork: ProjectUnitOfWork;
  }) =>
  async ({
    actor,
    name: inputName,
  }: {
    actor: Actor;
    name: string;
  }): Promise<Project> => {
    const name = normalizeProjectName(inputName);
    return unitOfWork.execute(({ projects }) => {
      // 同じ読み取りを両方に入れる。別々に読むと updated_at < created_at になり得て、
      // DB の check (updated_at >= created_at) に落ちる。
      const now = clock().getTime();
      const project: Project = {
        id: `project_${generateId()}`,
        ownerUserId: actor.userId,
        name,
        status: "active",
        version: 1,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };
      return projects.create(project);
    });
  };

export type CreateProject = ReturnType<typeof createCreateProject>;
