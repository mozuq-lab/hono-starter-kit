// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@starter/api-client";
import { QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { projectsListKey } from "../features/projects/projects-query.js";
import { queryClient, sessionNavigation } from "../lib/query-client.js";
import ProjectsRoute, { clientLoader, ErrorBoundary } from "./projects.js";

const { listProjects } = vi.hoisted(() => ({ listProjects: vi.fn() }));

vi.mock("../lib/api-client.js", () => ({
  projectsClient: { listProjects },
}));

const project = {
  id: "project_alpha",
  name: "Alpha",
  status: "active" as const,
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const internalError = new ApiError({
  type: "https://starter.local/problems/internal-server-error",
  title: "Internal Server Error",
  status: 500,
  code: "INTERNAL_ERROR",
  requestId: "request_projects_failed",
});

const unauthenticated = new ApiError({
  type: "https://starter.local/problems/unauthenticated",
  title: "Unauthenticated",
  status: 401,
  code: "UNAUTHENTICATED",
  requestId: "request_projects_unauthenticated",
});

const renderProjectsRoute = () => {
  const router = createMemoryRouter(
    [
      {
        path: "/projects",
        loader: () => clientLoader(),
        Component: ProjectsRoute,
        errorElement: <ErrorBoundary />,
      },
    ],
    { initialEntries: ["/projects"] },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return router;
};

// 見出しが出た時点では、useQuery の購読（passive effect）がまだ済んでいないことがある。
// 購読前に背景の再取得が失敗するとクエリが invalidated になり、遅れて購読した observer が
// マウント時の再取得でもう一度 listProjects を呼ぶ。再取得を起こすテストは購読を待ってから始める。
const renderProjectsRouteWithCachedList = async () => {
  queryClient.setQueryData(projectsListKey, { items: [project] });
  renderProjectsRoute();
  await screen.findByRole("heading", { name: "Alpha" });
  await waitFor(() => {
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: projectsListKey })
        ?.getObserversCount(),
    ).toBe(1);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  window.history.pushState({}, "", "/projects");
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("projects clientLoader", () => {
  it("fills the shared list cache once and serves later visits from it", async () => {
    listProjects.mockResolvedValue({ items: [project] });

    await expect(clientLoader()).resolves.toEqual({ items: [project] });
    expect(queryClient.getQueryData(projectsListKey)).toEqual({
      items: [project],
    });

    await clientLoader();

    expect(listProjects).toHaveBeenCalledOnce();
  });
});

describe("ProjectsRoute ErrorBoundary", () => {
  it("shows the request id and recovers the list with Retry", async () => {
    const user = userEvent.setup();
    let releaseReload: (() => void) | undefined;
    const reload = new Promise((resolve) => {
      releaseReload = () => resolve({ items: [project] });
    });
    listProjects.mockRejectedValueOnce(internalError).mockReturnValue(reload);
    renderProjectsRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Request ID: request_projects_failed",
    );

    await user.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
    releaseReload?.();

    expect(
      await screen.findByRole("heading", { name: "Alpha" }),
    ).toBeInTheDocument();
  });
});

describe("ProjectsRoute background refetch failures", () => {
  it("keeps the cached list visible and reports the stale data instead of failing the screen", async () => {
    await renderProjectsRouteWithCachedList();

    listProjects.mockRejectedValue(internalError);
    await queryClient
      .refetchQueries({ queryKey: projectsListKey })
      .catch(() => undefined);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "最新の Projects を取得できませんでした。",
    );
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();
  });

  it("clears the stale data notice once a retry succeeds", async () => {
    const user = userEvent.setup();
    await renderProjectsRouteWithCachedList();
    listProjects.mockRejectedValue(internalError);
    await queryClient
      .refetchQueries({ queryKey: projectsListKey })
      .catch(() => undefined);
    await screen.findByRole("status");

    const renamed = { ...project, name: "Alpha Renamed", version: 2 };
    listProjects.mockResolvedValue({ items: [renamed] });
    await user.click(screen.getByRole("button", { name: "再取得" }));

    expect(
      await screen.findByRole("heading", { name: "Alpha Renamed" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ProjectsRoute background refetch retry", () => {
  beforeEach(() => {
    // 既定の待ち時間（1 秒）はテストを遅くするだけなので詰める。再試行の回数は変えない。
    queryClient.setQueryDefaults(projectsListKey, { retryDelay: 0 });
  });

  it("retries a background refetch once after a network failure", async () => {
    await renderProjectsRouteWithCachedList();

    const renamed = { ...project, name: "Alpha Renamed", version: 2 };
    listProjects
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ items: [renamed] });
    await queryClient.refetchQueries({ queryKey: projectsListKey });

    expect(
      await screen.findByRole("heading", { name: "Alpha Renamed" }),
    ).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not retry a Problem response", async () => {
    await renderProjectsRouteWithCachedList();

    listProjects.mockRejectedValue(internalError);
    await queryClient
      .refetchQueries({ queryKey: projectsListKey })
      .catch(() => undefined);

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it("gives up after one retry of a persistent network failure", async () => {
    await renderProjectsRouteWithCachedList();

    listProjects.mockRejectedValue(new TypeError("Failed to fetch"));
    await queryClient
      .refetchQueries({ queryKey: projectsListKey })
      .catch(() => undefined);

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });
});

describe("ProjectsRoute session expiry", () => {
  it("sends a background refetch that expires the session to login instead of showing stale Projects", async () => {
    const assign = vi
      .spyOn(sessionNavigation, "assign")
      .mockImplementation(() => undefined);
    await renderProjectsRouteWithCachedList();

    listProjects.mockRejectedValue(unauthenticated);
    await queryClient
      .refetchQueries({ queryKey: projectsListKey })
      .catch(() => undefined);

    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fprojects");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    // 期限切れは再取得で直らないので、再取得を促す通知は出さない。
    expect(screen.queryByRole("status")).toBeNull();
  });
});
