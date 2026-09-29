import {
  ProjectArchivedError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
} from "./project.errors.js";
import type { ProjectRepository } from "./project.repository.js";

// 所有者で絞った取得を最初に行うので、他人の Project は archived や version の分類に届かず、
// 状態を漏らさずに PROJECT_NOT_FOUND になる。
export const classifyProjectMutation = async (
  repository: ProjectRepository,
  input: { id: string; ownerUserId: string },
): Promise<never> => {
  const current = await repository.findById(input);
  if (!current) throw new ProjectNotFoundError(input.id);
  if (current.status === "archived") {
    throw new ProjectArchivedError(input.id);
  }
  throw new ProjectVersionConflictError(input.id, current.version);
};
