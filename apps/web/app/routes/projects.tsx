import { ApiError } from "@starter/api-client";
import { useQuery } from "@tanstack/react-query";
import { useRevalidator, useRouteError } from "react-router";
import { ProjectsErrorView } from "../features/projects/projects-error-view.js";
import { ghostButtonClass, pageMainClass } from "../components/ui-classes.js";
import {
  projectsListKey,
  projectsListQueryOptions,
} from "../features/projects/projects-query.js";
import { ProjectsView } from "../features/projects/projects-view.js";
import { queryClient, retryTransientFailureOnce } from "../lib/query-client.js";

export async function clientLoader() {
  return queryClient.ensureQueryData(projectsListQueryOptions());
}
clientLoader.hydrate = true as const;

function ProjectsHydrateFallback() {
  return (
    <main aria-busy="true" className={pageMainClass}>
      Projects を読み込んでいます。
    </main>
  );
}

export default function ProjectsRoute() {
  const { data, error, refetch } = useQuery({
    ...projectsListQueryOptions(),
    retry: retryTransientFailureOnce,
  });

  if (!data) {
    if (error) throw error;
    return <ProjectsHydrateFallback />;
  }

  // 背景の再取得が失敗してもキャッシュは出したまま、古い可能性だけを控えめに伝える。
  // 401 はグローバルフックがキャッシュを捨てるので、ここには 401 以外だけが残る。
  const staleAfterFailedRefetch = error !== null;

  return (
    <>
      {staleAfterFailedRefetch ? (
        <p
          className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 border-l-4 border-l-blue-600 bg-white p-4 text-sm shadow-sm dark:border-slate-800 dark:border-l-blue-500 dark:bg-slate-900"
          role="status"
        >
          最新の Projects
          を取得できませんでした。表示中の内容は最後に取得できたものです。
          <button
            className={ghostButtonClass}
            onClick={() => void refetch()}
            type="button"
          >
            再取得
          </button>
        </p>
      ) : null}
      <ProjectsView projects={data.items} />
    </>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  const retry = async () => {
    await queryClient.resetQueries({ queryKey: projectsListKey });
    await revalidator.revalidate();
  };

  return (
    <ProjectsErrorView requestId={requestId} onRetry={() => void retry()} />
  );
}
