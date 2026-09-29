// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectDto } from "@starter/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { ProjectsErrorView } from "./projects-error-view.js";
import { ProjectsView } from "./projects-view.js";

const project: ProjectDto = {
  id: "project_alpha",
  name: "Alpha",
  status: "active",
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

afterEach(cleanup);

describe("ProjectsView", () => {
  it("renders each project's name, status, and update time", () => {
    render(<ProjectsView projects={[project]} />, { wrapper: MemoryRouter });

    expect(
      screen.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Create Project" }),
    ).toHaveAttribute("href", "/projects/new");
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("active")).toHaveClass("rounded-full");
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute(
      "href",
      "/projects/project_alpha",
    );
    expect(
      screen.getByText("2026-08-03T00:00:00.000Z", { selector: "time" }),
    ).toHaveAttribute("datetime", "2026-08-03T00:00:00.000Z");
  });

  it("renders a distinct empty state", () => {
    render(<ProjectsView projects={[]} />, { wrapper: MemoryRouter });

    expect(screen.getByText("Project はまだありません。")).toBeInTheDocument();
  });

  it("retains an archived Project card with its archived badge", () => {
    render(
      <ProjectsView
        projects={[{ ...project, id: "project_archived", status: "archived" }]}
      />,
      { wrapper: MemoryRouter },
    );

    expect(screen.getByText("archived")).toHaveClass("rounded-full");
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute(
      "href",
      "/projects/project_archived",
    );
  });
});

describe("ProjectsView navigation", () => {
  it("navigates to a Project without a full page load", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        { path: "/projects", element: <ProjectsView projects={[project]} /> },
        {
          path: "/projects/:projectId",
          element: <h1>Project detail</h1>,
        },
      ],
      { initialEntries: ["/projects"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("link", { name: "Alpha" }));

    expect(
      await screen.findByRole("heading", { name: "Project detail" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects/project_alpha");
  });

  it("navigates to the create page without a full page load", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        { path: "/projects", element: <ProjectsView projects={[]} /> },
        { path: "/projects/new", element: <h1>New project</h1> },
      ],
      { initialEntries: ["/projects"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("link", { name: "Create Project" }));

    expect(
      await screen.findByRole("heading", { name: "New project" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects/new");
  });
});

describe("ProjectsErrorView", () => {
  it("shows the unavailable message and request id", () => {
    render(
      <ProjectsErrorView requestId="request_test_123" onRetry={() => {}} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Projects を読み込めませんでした。",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("request_test_123");
  });

  it("calls onRetry from the accessible retry button", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ProjectsErrorView onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "再試行" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
