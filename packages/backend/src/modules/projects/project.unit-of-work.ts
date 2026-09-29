import type { ProjectRepository } from "./project.repository.js";

export interface ProjectUnitOfWork {
  execute<T>(
    work: (repositories: { projects: ProjectRepository }) => Promise<T>,
  ): Promise<T>;
}
