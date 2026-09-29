import type { Actor } from "../../platform/auth/auth.model.js";
import type { ProjectRepository } from "./project.repository.js";

export const createListProjects =
  (repository: ProjectRepository) =>
  ({ actor }: { actor: Actor }) =>
    repository.list({ ownerUserId: actor.userId });

export type ListProjects = ReturnType<typeof createListProjects>;
