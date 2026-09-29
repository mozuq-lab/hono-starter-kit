import { ApiError } from "@starter/api-client";
import {
  archiveProjectInputSchema,
  createProjectInputSchema,
  toFieldErrors,
  updateProjectInputSchema,
  type Problem,
  type ProjectDto,
} from "@starter/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { projectsClient } from "../../lib/api-client.js";
import { isSessionExpired, redirectToLogin } from "../../lib/query-client.js";
import { storeProject } from "./projects-query.js";

export type ProjectMutationActionData = {
  fieldErrors?: Record<string, string[]> | undefined;
  problem?: Problem | undefined;
};

export type ProjectMutationOutcome =
  { confirmed: ProjectDto } | { rejected: ProjectMutationActionData };

export type ProjectMutationContext = {
  client: QueryClient;
  requestUrl: string;
};

type ValidationIssue = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

/**
 * サーバの確定状態を取り直さないと、キャッシュ上の Project と返ってきた Problem が
 * 矛盾したまま固定される Problem コード。update と archive で同じ判定を使う。
 */
const staleCacheProblemCodes = new Set([
  "PROJECT_ARCHIVED",
  "PROJECT_VERSION_CONFLICT",
]);

const isActionableMutationProblem = (error: ApiError): boolean =>
  error.code === "VALIDATION_ERROR" || staleCacheProblemCodes.has(error.code);

const rejectFromIssues = (
  issues: readonly ValidationIssue[],
): ProjectMutationOutcome => ({
  rejected: { fieldErrors: toFieldErrors(issues) },
});

const rejectFromError = async (
  error: unknown,
  { client, requestUrl }: ProjectMutationContext,
  projectId?: string,
): Promise<ProjectMutationOutcome> => {
  if (!(error instanceof ApiError)) throw error;
  if (isSessionExpired(error)) redirectToLogin(requestUrl, client);
  if (!isActionableMutationProblem(error)) throw error;

  if (projectId !== undefined && staleCacheProblemCodes.has(error.code)) {
    await storeProject(
      client,
      await projectsClient.getProject(projectId),
      "replace",
    );
  }

  return {
    rejected: {
      fieldErrors: error.problem.fieldErrors,
      problem: error.problem,
    },
  };
};

export const submitProjectCreate = async (
  context: ProjectMutationContext,
  input: { name: string },
): Promise<ProjectMutationOutcome> => {
  const parsed = createProjectInputSchema.safeParse(input);
  if (!parsed.success) return rejectFromIssues(parsed.error.issues);

  try {
    const project = await projectsClient.createProject(parsed.data);
    await storeProject(context.client, project, "prepend");
    return { confirmed: project };
  } catch (error) {
    return rejectFromError(error, context);
  }
};

export const submitProjectUpdate = async (
  context: ProjectMutationContext,
  projectId: string,
  input: { name: string; version: number },
): Promise<ProjectMutationOutcome> => {
  const parsed = updateProjectInputSchema.safeParse(input);
  if (!parsed.success) return rejectFromIssues(parsed.error.issues);

  try {
    const project = await projectsClient.updateProject(projectId, parsed.data);
    await storeProject(context.client, project, "replace");
    return { confirmed: project };
  } catch (error) {
    return rejectFromError(error, context, projectId);
  }
};

export const submitProjectArchive = async (
  context: ProjectMutationContext,
  projectId: string,
  input: { version: number },
): Promise<ProjectMutationOutcome> => {
  const parsed = archiveProjectInputSchema.safeParse(input);
  if (!parsed.success) return rejectFromIssues(parsed.error.issues);

  try {
    const project = await projectsClient.archiveProject(projectId, parsed.data);
    await storeProject(context.client, project, "replace");
    return { confirmed: project };
  } catch (error) {
    return rejectFromError(error, context, projectId);
  }
};
