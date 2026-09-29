import { ApplicationError } from "../../platform/errors/application-error.js";

export class ProjectNotFoundError extends ApplicationError {
  readonly code = "PROJECT_NOT_FOUND";

  constructor(readonly projectId: string) {
    super("Project not found");
  }
}

export class ProjectValidationError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";

  constructor(override readonly fieldErrors: Record<string, string[]>) {
    super("Project validation failed");
  }
}

export class ProjectArchivedError extends ApplicationError {
  readonly code = "PROJECT_ARCHIVED";

  constructor(readonly projectId: string) {
    super("Project is archived");
  }
}

export class ProjectVersionConflictError extends ApplicationError {
  readonly code = "PROJECT_VERSION_CONFLICT";

  constructor(
    readonly projectId: string,
    readonly currentVersion: number,
  ) {
    super("Project version conflict");
  }
}

/** Projects のドメインが投げるエラーのコード。契約に含まれることは HTTP 層の型テストで確かめる。 */
export type ProjectErrorCode =
  | ProjectNotFoundError["code"]
  | ProjectValidationError["code"]
  | ProjectArchivedError["code"]
  | ProjectVersionConflictError["code"];
