import type { Project } from "./project.model.js";
import type { ProjectRepository } from "./project.repository.js";

const cloneProject = (project: Project): Project => ({
  ...project,
  createdAt: new Date(project.createdAt.getTime()),
  updatedAt: new Date(project.updatedAt.getTime()),
});

// Kysely の `order by created_at desc, id desc` と同じ並び。id は project_<UUID> の ASCII
// なので、照合順序に依らない符号単位の比較で PostgreSQL と一致する。
const newestFirst = (left: Project, right: Project): number => {
  const byCreatedAt = right.createdAt.getTime() - left.createdAt.getTime();
  if (byCreatedAt !== 0) return byCreatedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
};

export class InMemoryProjectRepository implements ProjectRepository {
  #projects: Project[];

  constructor(projects: readonly Project[]) {
    this.#projects = projects.map(cloneProject);
  }

  list(input: { ownerUserId: string }): Promise<readonly Project[]> {
    return Promise.resolve(
      this.#projects
        .filter((project) => project.ownerUserId === input.ownerUserId)
        .map(cloneProject)
        .sort(newestFirst),
    );
  }

  findById(input: {
    id: string;
    ownerUserId: string;
  }): Promise<Project | undefined> {
    const project = this.#projects.find(
      (candidate) =>
        candidate.id === input.id &&
        candidate.ownerUserId === input.ownerUserId,
    );
    return Promise.resolve(
      project === undefined ? undefined : cloneProject(project),
    );
  }

  create(project: Project): Promise<Project> {
    const created = cloneProject(project);
    this.#projects.push(created);
    return Promise.resolve(cloneProject(created));
  }

  update(input: {
    id: string;
    ownerUserId: string;
    name: string;
    expectedVersion: number;
    updatedAt: Date;
  }): Promise<Project | undefined> {
    const index = this.#findWritableIndex(input);
    if (index === -1) return Promise.resolve(undefined);

    const current = this.#projects[index]!;
    const updated: Project = {
      ...current,
      name: input.name,
      version: current.version + 1,
      updatedAt: new Date(input.updatedAt.getTime()),
    };
    this.#projects[index] = updated;
    return Promise.resolve(cloneProject(updated));
  }

  archive(input: {
    id: string;
    ownerUserId: string;
    expectedVersion: number;
    updatedAt: Date;
  }): Promise<Project | undefined> {
    const index = this.#findWritableIndex(input);
    if (index === -1) return Promise.resolve(undefined);

    const current = this.#projects[index]!;
    const archived: Project = {
      ...current,
      status: "archived",
      version: current.version + 1,
      updatedAt: new Date(input.updatedAt.getTime()),
    };
    this.#projects[index] = archived;
    return Promise.resolve(cloneProject(archived));
  }

  snapshot(): readonly Project[] {
    return this.#projects.map(cloneProject);
  }

  replaceAll(projects: readonly Project[]): void {
    this.#projects = projects.map(cloneProject);
  }

  #findWritableIndex(input: {
    id: string;
    ownerUserId: string;
    expectedVersion: number;
  }): number {
    return this.#projects.findIndex(
      (project) =>
        project.id === input.id &&
        project.ownerUserId === input.ownerUserId &&
        project.status === "active" &&
        project.version === input.expectedVersion,
    );
  }
}
