// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@starter/api-client";
import { QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  projectsDetailKey,
  projectsListKey,
} from "../features/projects/projects-query.js";
import { queryClient } from "../lib/query-client.js";
import ProjectDetailRoute, {
  clientAction,
  clientLoader,
  ErrorBoundary,
} from "./project-detail.js";

const { archiveProject, getProject, updateProject } = vi.hoisted(() => ({
  archiveProject: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("../lib/api-client.js", () => ({
  projectsClient: { archiveProject, getProject, updateProject },
}));

const project = {
  id: "project_alpha",
  name: "Alpha",
  status: "active" as const,
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const conflict = new ApiError({
  type: "https://starter.local/problems/project-version-conflict",
  title: "Project version conflict",
  status: 409,
  code: "PROJECT_VERSION_CONFLICT",
  requestId: "request_update_conflict",
});

const archived = new ApiError({
  type: "https://starter.local/problems/project-archived",
  title: "Project is archived",
  status: 409,
  code: "PROJECT_ARCHIVED",
  requestId: "request_update_archived",
});

const unauthenticated = new ApiError({
  type: "https://starter.local/problems/unauthenticated",
  title: "Unauthenticated",
  status: 401,
  code: "UNAUTHENTICATED",
  requestId: "request_unauthenticated",
});

const notFound = new ApiError({
  type: "https://starter.local/problems/project-not-found",
  title: "Project not found",
  status: 404,
  code: "PROJECT_NOT_FOUND",
  requestId: "request_not_found",
});

const internalError = new ApiError({
  type: "https://starter.local/problems/internal-server-error",
  title: "Internal Server Error",
  status: 500,
  code: "INTERNAL_ERROR",
  requestId: "request_archive_failed",
});

const updateRequest = (name = "Renamed", version = "1") =>
  new Request("https://app.example.test/projects/project_alpha", {
    method: "POST",
    body: new URLSearchParams({ intent: "update", name, version }),
  });

const archiveRequest = (version = "1") =>
  new Request("https://app.example.test/projects/project_alpha", {
    method: "POST",
    body: new URLSearchParams({ intent: "archive", version }),
  });

// 警告や Version の表示は、fetcher が再検証を終える前（loading）に変わる。loading の間は
// 入力欄が送信値を楽観表示しボタンも無効になる。idle に戻った後も、下書きの値と送信する
// version を確定値へ寄せるのは次の passive effect なので、ボタンの有効化に加えてその結果まで
// 待ってから値を確かめたり再送したりする。
const waitForSaveSettled = (expected: { name: string; version: string }) =>
  waitFor(() => {
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByLabelText("Project name")).toHaveValue(expected.name);
    expect(
      document.querySelector('input[type="hidden"][name="version"]'),
    ).toHaveValue(expected.version);
  });

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  queryClient.setQueryData(projectsListKey, { items: [project] });
  queryClient.setQueryData(projectsDetailKey(project.id), project);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("project-detail clientAction", () => {
  it("stores a confirmed update in both Project caches", async () => {
    const updated = {
      ...project,
      name: "Renamed",
      version: 2,
      updatedAt: "2026-08-06T01:00:00.000Z",
    };
    updateProject.mockResolvedValue(updated);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: updateRequest(),
      } as never),
    ).resolves.toEqual({});
    expect(updateProject).toHaveBeenCalledWith("project_alpha", {
      name: "Renamed",
      version: 1,
    });
    expect(queryClient.getQueryData(projectsDetailKey(project.id))).toEqual(
      updated,
    );
    expect(queryClient.getQueryData(projectsListKey)).toEqual({
      items: [updated],
    });
  });

  it("rolls back a conflict to the server-confirmed Project and returns its Problem", async () => {
    const current = {
      ...project,
      name: "Server Confirmed",
      version: 2,
      updatedAt: "2026-08-06T01:00:00.000Z",
    };
    updateProject.mockRejectedValue(conflict);
    getProject.mockResolvedValue(current);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: updateRequest(),
      } as never),
    ).resolves.toEqual({ problem: conflict.problem });
    expect(getProject).toHaveBeenCalledWith("project_alpha");
    expect(queryClient.getQueryData(projectsDetailKey(project.id))).toEqual(
      current,
    );
    expect(queryClient.getQueryData(projectsListKey)).toEqual({
      items: [current],
    });
  });

  it("returns typed validation Problems and lets unexpected errors reach the boundary", async () => {
    const validation = new ApiError({
      type: "https://starter.local/problems/validation-error",
      title: "Validation Error",
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_update_invalid",
      fieldErrors: { name: ["Project name is required."] },
    });
    updateProject.mockRejectedValueOnce(validation);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: updateRequest("Name"),
      } as never),
    ).resolves.toEqual({
      fieldErrors: { name: ["Project name is required."] },
      problem: validation.problem,
    });

    const unexpected = new Error("network unavailable");
    updateProject.mockRejectedValueOnce(unexpected);
    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: updateRequest(),
      } as never),
    ).rejects.toBe(unexpected);
  });

  it("returns a field validation action datum for whitespace without calling the API", async () => {
    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: updateRequest("   "),
      } as never),
    ).resolves.toEqual({
      fieldErrors: { name: ["Project name is required."] },
    });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("refetches the server Project when an update loses to an archive", async () => {
    const current = {
      ...project,
      status: "archived" as const,
      version: 2,
      updatedAt: "2026-08-06T03:00:00.000Z",
    };
    updateProject.mockRejectedValue(archived);
    getProject.mockResolvedValue(current);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: updateRequest(),
      } as never),
    ).resolves.toEqual({ problem: archived.problem });
    expect(getProject).toHaveBeenCalledWith("project_alpha");
    expect(queryClient.getQueryData(projectsDetailKey(project.id))).toEqual(
      current,
    );
    expect(queryClient.getQueryData(projectsListKey)).toEqual({
      items: [current],
    });
  });

  it.each<[string, () => Request, typeof updateProject]>([
    ["update", updateRequest, updateProject],
    ["archive", archiveRequest, archiveProject],
  ])(
    "sends an expired session from %s to login instead of a generic error screen",
    async (_intent, buildRequest, mutate) => {
      mutate.mockRejectedValue(unauthenticated);

      const result = await clientAction({
        params: { projectId: "project_alpha" },
        request: buildRequest(),
      } as never).catch((error: unknown) => error);

      expect(result).toBeInstanceOf(Response);
      expect(result).toMatchObject({ status: 302 });
      expect((result as Response).headers.get("Location")).toBe(
        "/login?returnTo=%2Fprojects%2Fproject_alpha",
      );
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    },
  );

  it("stores a confirmed archive in detail and list caches", async () => {
    const archived = {
      ...project,
      status: "archived" as const,
      version: 2,
      updatedAt: "2026-08-06T02:00:00.000Z",
    };
    archiveProject.mockResolvedValue(archived);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: archiveRequest(),
      } as never),
    ).resolves.toEqual({});
    expect(archiveProject).toHaveBeenCalledWith("project_alpha", {
      version: 1,
    });
    expect(queryClient.getQueryData(projectsDetailKey(project.id))).toEqual(
      archived,
    );
    expect(queryClient.getQueryData(projectsListKey)).toEqual({
      items: [archived],
    });
  });

  it("refetches the server Project and returns a structured archive conflict", async () => {
    const current = {
      ...project,
      name: "Server Confirmed",
      version: 2,
      updatedAt: "2026-08-06T02:00:00.000Z",
    };
    archiveProject.mockRejectedValue(conflict);
    getProject.mockResolvedValue(current);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: archiveRequest(),
      } as never),
    ).resolves.toEqual({ problem: conflict.problem });
    expect(getProject).toHaveBeenCalledWith("project_alpha");
    expect(queryClient.getQueryData(projectsDetailKey(project.id))).toEqual(
      current,
    );
    expect(queryClient.getQueryData(projectsListKey)).toEqual({
      items: [current],
    });
  });

  it("rejects an invalid archive version before calling the API", async () => {
    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: archiveRequest("not-a-number"),
      } as never),
    ).resolves.toEqual({
      fieldErrors: {
        version: ["Invalid input: expected number, received NaN"],
      },
    });
    expect(archiveProject).not.toHaveBeenCalled();
  });

  it("rethrows an archive 500 Problem so the route error boundary can recover", async () => {
    archiveProject.mockRejectedValue(internalError);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: archiveRequest(),
      } as never),
    ).rejects.toBe(internalError);
  });

  it("rethrows an update 500 Problem so the route error boundary can recover", async () => {
    updateProject.mockRejectedValue(internalError);

    await expect(
      clientAction({
        params: { projectId: "project_alpha" },
        request: updateRequest(),
      } as never),
    ).rejects.toBe(internalError);
  });
});

describe("ProjectDetailRoute ErrorBoundary", () => {
  it("routes a missing Project back to Projects without a full page load", async () => {
    const user = userEvent.setup();
    getProject.mockRejectedValue(notFound);
    const router = createMemoryRouter(
      [
        { path: "/projects", element: <h1>Projects</h1> },
        {
          path: "/projects/:projectId",
          loader: ({ params }) => clientLoader({ params } as never),
          Component: ProjectDetailRoute,
          errorElement: <ErrorBoundary />,
        },
      ],
      { initialEntries: ["/projects/project_missing"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Project が見つかりません。",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Projects に戻る" }));

    expect(
      await screen.findByRole("heading", { name: "Projects" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects");
  });
});

describe("ProjectDetailRoute Project switching", () => {
  it("does not carry an unsaved name draft into the next Project", async () => {
    const user = userEvent.setup();
    const beta = {
      id: "project_beta",
      name: "Beta",
      status: "active" as const,
      version: 3,
      updatedAt: "2026-08-04T00:00:00.000Z",
    };
    queryClient.setQueryData(projectsDetailKey(beta.id), beta);
    const router = createMemoryRouter(
      [
        {
          path: "/projects/:projectId",
          loader: ({ params }) => clientLoader({ params } as never),
          Component: ProjectDetailRoute,
          errorElement: <ErrorBoundary />,
        },
      ],
      { initialEntries: ["/projects/project_alpha"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.clear(await screen.findByLabelText("Project name"));
    await user.type(
      screen.getByLabelText("Project name"),
      "Draft meant for Alpha",
    );
    expect(screen.getByLabelText("Project name")).toHaveValue(
      "Draft meant for Alpha",
    );

    await act(async () => {
      await router.navigate("/projects/project_beta");
    });

    expect(
      await screen.findByRole("heading", { name: "Beta" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("Beta");
  });
});

describe("ProjectDetailRoute の下書き競合", () => {
  it("再取得前の下書きは競合し、明示的な再試行で取得済み version を送る", async () => {
    const user = userEvent.setup();
    const serverWinner = { ...project, name: "Server winner", version: 2 };
    const confirmed = { ...project, name: "My draft", version: 3 };
    getProject.mockResolvedValue(serverWinner);
    updateProject
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(confirmed);
    const router = createMemoryRouter(
      [
        {
          path: "/projects/:projectId",
          loader: ({ params }) => clientLoader({ params } as never),
          action: ({ params, request }) =>
            clientAction({ params, request } as never),
          Component: ProjectDetailRoute,
          errorElement: <ErrorBoundary />,
        },
      ],
      { initialEntries: ["/projects/project_alpha"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await user.clear(await screen.findByLabelText("Project name"));
    await user.type(screen.getByLabelText("Project name"), "  My draft  ");

    act(() => {
      queryClient.setQueryData(projectsDetailKey(project.id), serverWinner);
    });
    await screen.findByRole("heading", { name: "Server winner" });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Project was updated on the server.",
    );
    await waitForSaveSettled({ name: "  My draft  ", version: "2" });
    expect(updateProject).toHaveBeenNthCalledWith(1, "project_alpha", {
      name: "  My draft  ",
      version: 1,
    });
    expect(screen.getByLabelText("Project name")).toHaveValue("  My draft  ");
    expect(queryClient.getQueryData(projectsDetailKey(project.id))).toEqual(
      serverWinner,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateProject).toHaveBeenNthCalledWith(2, "project_alpha", {
      name: "  My draft  ",
      version: 2,
    });
    expect(await screen.findByText("Version: 3")).toBeInTheDocument();
    await waitForSaveSettled({ name: "My draft", version: "3" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("My draft");
  });
});

describe("ProjectDetailRoute archive recovery", () => {
  it("returns from a failed archive to server-confirmed active controls without replaying its POST", async () => {
    const user = userEvent.setup();
    archiveProject.mockRejectedValueOnce(internalError);
    getProject.mockResolvedValue(project);
    const router = createMemoryRouter(
      [
        {
          path: "/projects/:projectId",
          loader: ({ params }) => clientLoader({ params } as never),
          action: ({ params, request }) =>
            clientAction({ params, request } as never),
          Component: ProjectDetailRoute,
          errorElement: <ErrorBoundary />,
        },
      ],
      { initialEntries: ["/projects/project_alpha"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Archive Project" }),
    );
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Request ID: request_archive_failed",
    );
    expect(archiveProject).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "再試行" }));

    expect(
      await screen.findByRole("heading", { name: "Alpha" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Archive Project" }),
    ).toBeVisible();
    expect(archiveProject).toHaveBeenCalledOnce();
  });
});
