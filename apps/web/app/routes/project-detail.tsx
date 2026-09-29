import { ApiError } from "@starter/api-client";
import { projectIdSchema } from "@starter/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  type ClientLoaderFunctionArgs,
  type ClientActionFunctionArgs,
  Link,
  useFetcher,
  useNavigate,
  useParams,
  useRouteError,
} from "react-router";
import { ProjectDetailView } from "../features/projects/project-detail-view.js";
import {
  submitProjectArchive,
  submitProjectUpdate,
  type ProjectMutationActionData,
} from "../features/projects/project-mutations.js";
import { ProjectsErrorView } from "../features/projects/projects-error-view.js";
import {
  projectsDetailKey,
  projectsDetailQueryOptions,
} from "../features/projects/projects-query.js";
import { queryClient, retryTransientFailureOnce } from "../lib/query-client.js";

const getProjectId = (projectId: string | undefined) =>
  projectIdSchema.parse(projectId);

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const projectId = getProjectId(params.projectId);
  return queryClient.ensureQueryData(projectsDetailQueryOptions(projectId));
}
clientLoader.hydrate = true as const;

export async function clientAction({
  params,
  request,
}: ClientActionFunctionArgs): Promise<ProjectMutationActionData | undefined> {
  const projectId = getProjectId(params.projectId);
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent !== "update" && intent !== "archive") return undefined;

  const context = { client: queryClient, requestUrl: request.url };
  const version = Number(formData.get("version"));
  const name = formData.get("name");

  const outcome =
    intent === "archive"
      ? await submitProjectArchive(context, projectId, { version })
      : await submitProjectUpdate(context, projectId, {
          name: typeof name === "string" ? name : "",
          version,
        });

  // undefined では fetcher に前回の Problem が残り、成功後も失敗として扱われる。
  return "rejected" in outcome ? outcome.rejected : {};
}

function ProjectDetailHydrateFallback() {
  return <main aria-busy="true">Project を読み込んでいます。</main>;
}

export default function ProjectDetailRoute() {
  const projectId = getProjectId(useParams().projectId);
  const { data, error } = useQuery({
    ...projectsDetailQueryOptions(projectId),
    retry: retryTransientFailureOnce,
  });
  const updateFetcher = useFetcher<ProjectMutationActionData>();

  if (!data) {
    if (error) throw error;
    return <ProjectDetailHydrateFallback />;
  }

  return (
    <ProjectDetailView
      fieldErrors={updateFetcher.data?.fieldErrors}
      FormComponent={updateFetcher.Form}
      pending={updateFetcher.state !== "idle"}
      pendingFormData={updateFetcher.formData}
      problem={updateFetcher.data?.problem}
      project={data}
    />
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const projectId = useParams().projectId;
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  if (error instanceof ApiError && error.code === "PROJECT_NOT_FOUND") {
    return (
      <main>
        <h1>Project が見つかりません。</h1>
        <Link to="/projects">Projects に戻る</Link>
      </main>
    );
  }

  const retry = async () => {
    if (projectId) {
      await queryClient.resetQueries({
        queryKey: projectsDetailKey(projectId),
      });
      await navigate(`/projects/${encodeURIComponent(projectId)}`, {
        replace: true,
      });
    }
  };

  return (
    <ProjectsErrorView requestId={requestId} onRetry={() => void retry()} />
  );
}
