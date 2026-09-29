import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { ListProjectsResponse, ProjectDto } from "@starter/contracts";
import { projectsClient } from "../../lib/api-client.js";

export const projectsListKey = ["projects", "list"] as const;

export const projectsListQueryOptions = (
  listProjects: typeof projectsClient.listProjects = (options) =>
    projectsClient.listProjects(options),
) =>
  queryOptions({
    queryKey: projectsListKey,
    queryFn: ({ signal }) => listProjects({ signal }),
  });

export const projectsDetailKey = (projectId: string) =>
  ["projects", "detail", projectId] as const;

// 一覧はサーバが created_at の新しい順で返す。作成直後の Project は必ず最も新しいので先頭に
// 置け、更新やアーカイブでは created_at が変わらないので位置も変わらない。どちらもクライアントで
// 並べ替えないので、サーバの照合順序を再現する比較関数を持たずに済む。
export const prependProjectToList = (
  current: ListProjectsResponse | undefined,
  project: ProjectDto,
): ListProjectsResponse | undefined =>
  current === undefined
    ? undefined
    : {
        items: [
          project,
          ...current.items.filter((item) => item.id !== project.id),
        ],
      };

// 一覧にない Project は足さない。一覧は staleTime が切れた後の次の取得で正しくなる。
export const replaceProjectInList = (
  current: ListProjectsResponse | undefined,
  project: ProjectDto,
): ListProjectsResponse | undefined =>
  current === undefined
    ? undefined
    : {
        items: current.items.map((item) =>
          item.id === project.id ? project : item,
        ),
      };

/** 作成は先頭に足し、更新・アーカイブ・再取得はその位置で置き換える。 */
export type ListPlacement = "prepend" | "replace";

export const storeProject = async (
  client: QueryClient,
  project: ProjectDto,
  placement: ListPlacement,
): Promise<void> => {
  // 先に進行中の取得を止めないと、書き込んだ確定値が古いレスポンスで上書きされる。
  await Promise.all([
    client.cancelQueries({
      queryKey: projectsDetailKey(project.id),
      exact: true,
    }),
    client.cancelQueries({ queryKey: projectsListKey, exact: true }),
  ]);
  client.setQueryData(projectsDetailKey(project.id), project);
  client.setQueryData<ListProjectsResponse>(projectsListKey, (current) =>
    placement === "prepend"
      ? prependProjectToList(current, project)
      : replaceProjectInList(current, project),
  );
};

export const projectsDetailQueryOptions = (
  projectId: string,
  getProject: typeof projectsClient.getProject = (id, options) =>
    projectsClient.getProject(id, options),
) =>
  queryOptions({
    queryKey: projectsDetailKey(projectId),
    queryFn: ({ signal }) => getProject(projectId, { signal }),
  });
