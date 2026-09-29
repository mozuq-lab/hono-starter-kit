import {
  type CreateProjectInput,
  type ArchiveProjectInput,
  type UpdateProjectInput,
  listProjectsResponseSchema,
  type ListProjectsResponse,
  projectDtoSchema,
  type ProjectDto,
} from "@starter/contracts";
import { createRpcClient } from "./client.js";
import { parsePayload, parseSuccess } from "./response.js";

/**
 * Projects API のクライアントを作る。
 *
 * どのメソッドも応答を契約スキーマで検証してから返すので、解決した値は信用してよい。
 * 失敗はすべて例外で、サーバが返した Problem は {@link ApiError}、
 * 契約に合わない応答は {@link UnexpectedApiResponseError} になる。
 *
 * @param baseUrl API のオリジン。
 * @param fetch 使用する fetch 実装。テストや SSR で差し替える。
 */
export const createProjectsClient = (options: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
}): {
  /**
   * Project を作成し、採番された結果を返す。
   *
   * @throws {ApiError} 名前が入力規則に合わなければ `VALIDATION_ERROR`。
   */
  createProject(input: CreateProjectInput): Promise<ProjectDto>;
  /**
   * Project の名前を更新し、更新後の状態を返す。
   *
   * `input.version` には読み取った時点の値を渡す。すでに他所で更新されていれば
   * サーバが弾くので、読み直してから再試行すること。
   *
   * @throws {ApiError} `PROJECT_NOT_FOUND` / `PROJECT_ARCHIVED` /
   *   `PROJECT_VERSION_CONFLICT` / `VALIDATION_ERROR`。
   */
  updateProject(
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<ProjectDto>;
  /**
   * Project をアーカイブし、更新後の状態を返す。アーカイブは元に戻せない。
   *
   * 更新と同じ楽観ロックが働く。
   *
   * @throws {ApiError} `PROJECT_NOT_FOUND` / `PROJECT_ARCHIVED` /
   *   `PROJECT_VERSION_CONFLICT`。
   */
  archiveProject(
    projectId: string,
    input: ArchiveProjectInput,
  ): Promise<ProjectDto>;
  /**
   * Project を一覧する。ページングはないので全件が返る。
   *
   * @param options.signal 画面離脱などで打ち切るための signal。
   */
  listProjects(options?: {
    signal?: AbortSignal;
  }): Promise<ListProjectsResponse>;
  /**
   * Project を 1 件取得する。
   *
   * @param options.signal 画面離脱などで打ち切るための signal。
   * @throws {ApiError} 見つからなければ `PROJECT_NOT_FOUND`。
   */
  getProject(
    projectId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProjectDto>;
} => {
  const rpc = createRpcClient(options);

  return {
    async createProject(input) {
      const response = await rpc.api.projects.$post({ json: input });
      return parseSuccess(
        await parsePayload(response),
        projectDtoSchema,
        response.status,
      );
    },

    async updateProject(projectId, input) {
      const response = await rpc.api.projects[":projectId"].$patch({
        param: { projectId },
        json: input,
      });
      return parseSuccess(
        await parsePayload(response),
        projectDtoSchema,
        response.status,
      );
    },

    async archiveProject(projectId, input) {
      const response = await rpc.api.projects[":projectId"].archive.$post({
        param: { projectId },
        json: input,
      });
      return parseSuccess(
        await parsePayload(response),
        projectDtoSchema,
        response.status,
      );
    },

    async listProjects({ signal } = {}) {
      const init: RequestInit = signal === undefined ? {} : { signal };
      const response = await rpc.api.projects.$get({}, { init });
      return parseSuccess(
        await parsePayload(response),
        listProjectsResponseSchema,
        response.status,
      );
    },

    async getProject(projectId, { signal } = {}) {
      const init: RequestInit = signal === undefined ? {} : { signal };
      const response = await rpc.api.projects[":projectId"].$get(
        { param: { projectId } },
        { init },
      );
      return parseSuccess(
        await parsePayload(response),
        projectDtoSchema,
        response.status,
      );
    },
  };
};
