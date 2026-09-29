import { InMemoryProjectRepository } from "./project.repository.memory.js";
import type { ProjectRepository } from "./project.repository.js";
import type { ProjectUnitOfWork } from "./project.unit-of-work.js";

export class InMemoryProjectUnitOfWork implements ProjectUnitOfWork {
  constructor(private readonly repository: InMemoryProjectRepository) {}

  async execute<T>(
    work: (repositories: { projects: ProjectRepository }) => Promise<T>,
  ): Promise<T> {
    const transactionRepository = new InMemoryProjectRepository(
      this.repository.snapshot(),
    );
    const result = await work({ projects: transactionRepository });
    this.repository.replaceAll(transactionRepository.snapshot());
    return result;
  }
}
