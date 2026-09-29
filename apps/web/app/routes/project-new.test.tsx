// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { ApiError } from "@starter/api-client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  projectsDetailKey,
  projectsListKey,
} from "../features/projects/projects-query.js";
import { queryClient } from "../lib/query-client.js";
import ProjectNewRoute, { ErrorBoundary, clientAction } from "./project-new.js";

const { createProject } = vi.hoisted(() => ({ createProject: vi.fn() }));

vi.mock("../lib/api-client.js", () => ({
  projectsClient: { createProject },
}));

const validationError = new ApiError({
  type: "https://starter.local/problems/validation-error",
  title: "Validation Error",
  status: 400,
  code: "VALIDATION_ERROR",
  requestId: "request_create_invalid",
  fieldErrors: { name: ["Project name is required."] },
});

const validationErrorWithoutFieldErrors = new ApiError({
  type: "https://starter.local/problems/validation-error",
  title: "Validation Error",
  status: 400,
  code: "VALIDATION_ERROR",
  requestId: "request_create_rule",
});

const internalError = new ApiError({
  type: "https://starter.local/problems/internal-server-error",
  title: "Internal Server Error",
  status: 500,
  code: "INTERNAL_ERROR",
  requestId: "request_create_failed",
});

const unauthenticated = new ApiError({
  type: "https://starter.local/problems/unauthenticated",
  title: "Unauthenticated",
  status: 401,
  code: "UNAUTHENTICATED",
  requestId: "request_create_unauthenticated",
});

const actionRequest = (name = "Created") =>
  new Request("https://app.example.test/projects/new", {
    method: "POST",
    body: new URLSearchParams({ name }),
  });

afterEach(() => {
  cleanup();
  queryClient.clear();
});
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
});

describe("project-new clientAction", () => {
  it("stores created detail without synthesizing an incomplete list cache", async () => {
    const created = {
      id: "project_created",
      name: "Created",
      status: "active" as const,
      version: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
    };
    createProject.mockResolvedValue(created);

    await clientAction({ request: actionRequest() } as never);

    expect(queryClient.getQueryData(projectsDetailKey(created.id))).toEqual(
      created,
    );
    expect(queryClient.getQueryData(projectsListKey)).toBeUndefined();
  });

  it("returns the same field and Problem action data shape as the detail route", async () => {
    createProject.mockRejectedValue(validationError);

    await expect(
      clientAction({ request: actionRequest() } as never),
    ).resolves.toEqual({
      fieldErrors: { name: ["Project name is required."] },
      problem: validationError.problem,
    });
  });

  it("rejects a blank name with the contract schema before calling the API", async () => {
    await expect(
      clientAction({ request: actionRequest("   ") } as never),
    ).resolves.toEqual({
      fieldErrors: { name: ["Project name is required."] },
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("rethrows a non-validation API Problem", async () => {
    createProject.mockRejectedValue(internalError);

    await expect(
      clientAction({ request: actionRequest() } as never),
    ).rejects.toBe(internalError);
  });

  it("sends an expired session to login instead of a generic error screen", async () => {
    createProject.mockRejectedValue(unauthenticated);
    queryClient.setQueryData(projectsDetailKey("project_alpha"), {
      id: "project_alpha",
    });

    const result = await clientAction({
      request: actionRequest(),
    } as never).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Response);
    expect(result).toMatchObject({ status: 302 });
    expect((result as Response).headers.get("Location")).toBe(
      "/login?returnTo=%2Fprojects%2Fnew",
    );
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("ProjectNewRoute", () => {
  it("shows the server Problem when a rejected create carries no field error", async () => {
    const user = userEvent.setup();
    createProject.mockRejectedValueOnce(validationErrorWithoutFieldErrors);
    const router = createMemoryRouter(
      [
        {
          path: "/projects/new",
          action: ({ request }) => clientAction({ request } as never),
          Component: ProjectNewRoute,
        },
      ],
      { initialEntries: ["/projects/new"] },
    );

    render(<RouterProvider router={router} />);

    await user.type(screen.getByLabelText("Project name"), "Created");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The submitted values were rejected. Please review the form.",
    );
  });
});

describe("ProjectNewRoute ErrorBoundary", () => {
  it("resets a failed creation action to the form without replaying its POST", async () => {
    const user = userEvent.setup();
    createProject.mockRejectedValueOnce(internalError);
    const router = createMemoryRouter(
      [
        {
          path: "/projects/new",
          action: ({ request }) => clientAction({ request } as never),
          Component: ProjectNewRoute,
          errorElement: <ErrorBoundary />,
        },
      ],
      { initialEntries: ["/projects/new"] },
    );

    render(<RouterProvider router={router} />);

    await user.type(screen.getByLabelText("Project name"), "Created");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Request ID: request_create_failed",
    );
    expect(createProject).toHaveBeenCalledOnce();
    expect(createProject).toHaveBeenCalledWith({ name: "Created" });

    await user.click(screen.getByRole("button", { name: "再試行" }));

    expect(
      await screen.findByRole("heading", { name: "Create Project" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects/new");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.getByLabelText("Project name")).toHaveValue("");
    expect(createProject).toHaveBeenCalledOnce();
  });
});
