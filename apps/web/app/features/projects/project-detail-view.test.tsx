// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render as renderWithoutRouter,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import {
  problemTypes,
  type Problem,
  type ProjectDto,
} from "@starter/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { ProjectDetailView } from "./project-detail-view.js";

const activeProject: ProjectDto = {
  id: "project_alpha",
  name: "Alpha",
  status: "active",
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const otherProject: ProjectDto = {
  id: "project_beta",
  name: "Beta",
  status: "active",
  version: 3,
  updatedAt: "2026-08-04T00:00:00.000Z",
};

const updateFormData = (name: string, version = "1") => {
  const formData = new FormData();
  formData.set("intent", "update");
  formData.set("name", name);
  formData.set("version", version);
  return formData;
};

const renderedUpdateFormData = () => {
  const form = screen.getByLabelText("Project name").closest("form");
  if (form === null) throw new Error("Project update form was not found.");
  return new FormData(form);
};

const validationProblem: Problem = {
  type: problemTypes.VALIDATION_ERROR,
  title: "Validation Error",
  status: 400,
  code: "VALIDATION_ERROR",
  requestId: "request_update_invalid",
};

afterEach(cleanup);

// 戻るリンクが <Link> なので、どの描画も router の文脈の中に置く。
const render = (ui: ReactElement) =>
  renderWithoutRouter(ui, { wrapper: MemoryRouter });

describe("ProjectDetailView", () => {
  it("renders an active Project's name, status, version, and back link", () => {
    render(<ProjectDetailView project={activeProject} />);

    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("active")).toHaveClass("project-status");
    expect(screen.getByText("Version: 1")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Projects に戻る" }),
    ).toHaveAttribute("href", "/projects");
  });

  it("returns to the list without a full page load", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/projects/:projectId",
          element: <ProjectDetailView project={activeProject} />,
        },
        { path: "/projects", element: <h1>Project list</h1> },
      ],
      { initialEntries: ["/projects/project_alpha"] },
    );
    renderWithoutRouter(<RouterProvider router={router} />);

    await user.click(screen.getByRole("link", { name: "Projects に戻る" }));

    expect(
      await screen.findByRole("heading", { name: "Project list" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects");
  });

  it("renders an archived Project status badge", () => {
    render(
      <ProjectDetailView project={{ ...activeProject, status: "archived" }} />,
    );

    expect(screen.getByText("archived")).toHaveClass("project-status");
    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
  });

  it("renders the pending update name without changing the confirmed Project", () => {
    const formData = new FormData();
    formData.set("intent", "update");
    formData.set("name", "Optimistic Name");
    formData.set("version", "1");

    render(
      <ProjectDetailView
        project={activeProject}
        pendingFormData={formData}
        pending
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Optimistic Name" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue(
      "Optimistic Name",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("updates the name input when a submitted fetcher becomes pending", () => {
    const formData = new FormData();
    formData.set("intent", "update");
    formData.set("name", "Optimistic Name");
    formData.set("version", "1");
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    rerender(
      <ProjectDetailView
        project={activeProject}
        pendingFormData={formData}
        pending
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue(
      "Optimistic Name",
    );
  });

  it("保存中の追加入力を受け付けず、成功後は再び編集できる", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Sent draft" },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("Sent draft")}
        project={activeProject}
      />,
    );

    await user.type(screen.getByLabelText("Project name"), " unsent suffix");

    expect(screen.getByLabelText("Project name")).toHaveValue("Sent draft");
    expect(renderedUpdateFormData().get("name")).toBe("Sent draft");

    rerender(
      <ProjectDetailView
        project={{ ...activeProject, name: "Sent draft", version: 2 }}
      />,
    );
    await user.type(screen.getByLabelText("Project name"), " next edit");

    expect(screen.getByLabelText("Project name")).toHaveValue(
      "Sent draft next edit",
    );
  });

  it("編集中の再取得では下書きの名前と編集開始時の version を送信する", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Draft from version one" },
    });
    rerender(
      <ProjectDetailView
        project={{ ...activeProject, name: "Other client change", version: 2 }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Draft from version one continued" },
    });

    expect(Object.fromEntries(renderedUpdateFormData())).toEqual({
      intent: "update",
      name: "Draft from version one continued",
      version: "1",
    });
  });

  it("保存成功後に始めた下書きは成功時の version を基準にする", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "First edit" },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("First edit")}
        project={activeProject}
      />,
    );
    rerender(
      <ProjectDetailView
        project={{ ...activeProject, name: "First edit", version: 2 }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Second edit" },
    });
    rerender(
      <ProjectDetailView
        project={{ ...activeProject, name: "Other client change", version: 3 }}
      />,
    );

    expect(Object.fromEntries(renderedUpdateFormData())).toEqual({
      intent: "update",
      name: "Second edit",
      version: "2",
    });
  });

  it("明示的な version conflict 後の再試行だけ基準を更新する", () => {
    const conflict: Problem = {
      type: problemTypes.PROJECT_VERSION_CONFLICT,
      title: "Project version conflict",
      status: 409,
      code: "PROJECT_VERSION_CONFLICT",
      requestId: "request_update_conflict",
    };
    const { rerender } = render(<ProjectDetailView project={activeProject} />);
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Rejected draft" },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("Rejected draft")}
        project={activeProject}
      />,
    );
    rerender(
      <ProjectDetailView
        problem={conflict}
        project={{ ...activeProject, name: "Server winner", version: 2 }}
      />,
    );

    expect(renderedUpdateFormData().get("version")).toBe("2");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project was updated on the server.",
    );

    rerender(
      <ProjectDetailView
        problem={conflict}
        project={{
          ...activeProject,
          name: "Another server update",
          version: 3,
        }}
      />,
    );

    expect(Object.fromEntries(renderedUpdateFormData())).toEqual({
      intent: "update",
      name: "Rejected draft",
      version: "2",
    });
  });

  it("入力検証失敗では再取得された version を下書きに採用しない", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "   " },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("   ")}
        project={activeProject}
      />,
    );
    rerender(
      <ProjectDetailView
        fieldErrors={{ name: ["Project name is required."] }}
        problem={validationProblem}
        project={{ ...activeProject, name: "Other client change", version: 2 }}
      />,
    );

    expect(renderedUpdateFormData().get("version")).toBe("1");
  });

  it("keeps the rejected 101 character name in the input after a validation failure", () => {
    const rejectedName = "a".repeat(101);
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    // maxLength により打鍵では101文字に届かないので、貼り付け/自動入力相当の変更で流し込む
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: rejectedName },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData(rejectedName)}
        project={activeProject}
      />,
    );
    rerender(
      <ProjectDetailView
        fieldErrors={{
          name: ["Project name must be 100 characters or fewer."],
        }}
        problem={validationProblem}
        project={activeProject}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue(rejectedName);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project name must be 100 characters or fewer.",
    );
  });

  it("keeps the typed name in the input after a failed update", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    await user.clear(screen.getByLabelText("Project name"));
    await user.type(screen.getByLabelText("Project name"), "   ");
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("   ")}
        project={activeProject}
      />,
    );
    rerender(
      <ProjectDetailView
        fieldErrors={{ name: ["Project name is required."] }}
        problem={validationProblem}
        project={activeProject}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("   ");
  });

  it("keeps the submitted name in the input after a version conflict", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Stale UI" },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("Stale UI")}
        project={activeProject}
      />,
    );
    rerender(
      <ProjectDetailView
        problem={{
          type: problemTypes.PROJECT_VERSION_CONFLICT,
          title: "Project version conflict",
          status: 409,
          code: "PROJECT_VERSION_CONFLICT",
          requestId: "request_update_conflict",
        }}
        project={{ ...activeProject, name: "Server Winner", version: 2 }}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("Stale UI");
    expect(
      screen.getByRole("heading", { name: "Server Winner" }),
    ).toBeInTheDocument();
  });

  it("syncs the input to the server-confirmed name after a successful update", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "  Renamed  " },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("  Renamed  ")}
        project={activeProject}
      />,
    );
    rerender(
      <ProjectDetailView
        project={{ ...activeProject, name: "Renamed", version: 2 }}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("Renamed");
  });

  it("keeps unsubmitted input when the confirmed Project is refetched", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Unsent Draft" },
    });
    rerender(
      <ProjectDetailView
        project={{ ...activeProject, name: "Refetched", version: 2 }}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("Unsent Draft");
    expect(
      screen.getByRole("heading", { name: "Refetched" }),
    ).toBeInTheDocument();
  });

  it("別 Project への切替では下書きと基準 version を引き継がない", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Accidentally typed for Alpha" },
    });
    rerender(<ProjectDetailView project={otherProject} />);

    expect(screen.getByLabelText("Project name")).toHaveValue("Beta");
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(renderedUpdateFormData().get("version")).toBe("3");

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Draft for Beta" },
    });
    rerender(<ProjectDetailView project={{ ...otherProject, version: 4 }} />);

    expect(renderedUpdateFormData().get("version")).toBe("3");
  });

  it("closes an open archive confirmation when another Project is rendered", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    await user.click(screen.getByRole("button", { name: "Archive Project" }));
    expect(
      screen.getByRole("button", { name: "Confirm archive" }),
    ).toBeVisible();

    rerender(<ProjectDetailView project={otherProject} />);

    expect(
      screen.queryByRole("button", { name: "Confirm archive" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Archive Project" }),
    ).toBeVisible();
  });

  it("keeps the submitted name when a field other than name is rejected", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Renamed Draft" },
    });
    rerender(
      <ProjectDetailView
        pending
        pendingFormData={updateFormData("Renamed Draft", "not-a-number")}
        project={activeProject}
      />,
    );
    // クライアント検証だけで弾かれた版なので Problem は付かない。
    rerender(
      <ProjectDetailView
        fieldErrors={{
          version: ["Invalid input: expected number, received NaN"],
        }}
        project={activeProject}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("Renamed Draft");
  });

  it("follows the confirmed name while the input is untouched", () => {
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    rerender(
      <ProjectDetailView
        project={{ ...activeProject, name: "Refetched", version: 2 }}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("Refetched");
  });

  it("limits the name input to the contract's maximum length", () => {
    render(<ProjectDetailView project={activeProject} />);

    expect(screen.getByLabelText("Project name")).toHaveAttribute(
      "maxlength",
      "100",
    );
  });

  it("describes the name input with a mutation Problem alert", () => {
    render(
      <ProjectDetailView
        problem={{
          type: problemTypes.PROJECT_ARCHIVED,
          title: "Project archived",
          status: 409,
          code: "PROJECT_ARCHIVED",
          requestId: "request_update_archived",
        }}
        project={activeProject}
      />,
    );

    const describedBy = screen
      .getByLabelText("Project name")
      .getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(screen.getByRole("alert")).toHaveAttribute("id", describedBy);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project is archived and cannot be updated.",
    );
  });

  it("keeps the described alert id unique while the archive confirmation is open", async () => {
    const user = userEvent.setup();
    render(
      <ProjectDetailView
        problem={{
          type: problemTypes.PROJECT_ARCHIVED,
          title: "Project archived",
          status: 409,
          code: "PROJECT_ARCHIVED",
          requestId: "request_update_archived",
        }}
        project={activeProject}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive Project" }));

    const describedBy = screen
      .getByLabelText("Project name")
      .getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.querySelectorAll(`#${String(describedBy)}`)).toHaveLength(
      1,
    );
  });

  it("renders the server-confirmed Project and a conflict alert after a stale update", () => {
    render(
      <ProjectDetailView
        project={{ ...activeProject, name: "Server Confirmed", version: 2 }}
        problem={{
          type: "https://starter.local/problems/project-version-conflict",
          title: "Project version conflict",
          status: 409,
          code: "PROJECT_VERSION_CONFLICT",
          requestId: "request_update_conflict",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Server Confirmed" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project was updated on the server.",
    );
  });

  it("renders name field errors from a failed update", () => {
    render(
      <ProjectDetailView
        project={activeProject}
        fieldErrors={{ name: ["Project name is required."] }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project name is required.",
    );
  });

  it("requires an inline confirmation before archiving", async () => {
    const user = userEvent.setup();
    render(<ProjectDetailView project={activeProject} />);

    await user.click(screen.getByRole("button", { name: "Archive Project" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Archiving cannot be undone.",
    );
    expect(
      screen.getByRole("button", { name: "Confirm archive" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByText("Archiving cannot be undone."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Archive Project" }),
    ).toBeVisible();
  });

  it("renders a pending archive as archived without changing confirmed cache data", () => {
    const formData = new FormData();
    formData.set("intent", "archive");
    formData.set("version", "1");

    render(
      <ProjectDetailView
        project={activeProject}
        pending
        pendingFormData={formData}
      />,
    );

    expect(screen.getByText("archived")).toHaveClass("project-status");
    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive Project" }),
    ).not.toBeInTheDocument();
  });

  it("restores active controls after an archive failure", async () => {
    const archiveFormData = new FormData();
    archiveFormData.set("intent", "archive");
    archiveFormData.set("version", "1");
    const user = userEvent.setup();
    const { rerender } = render(<ProjectDetailView project={activeProject} />);

    await user.click(screen.getByRole("button", { name: "Archive Project" }));
    rerender(
      <ProjectDetailView
        project={activeProject}
        pending
        pendingFormData={archiveFormData}
      />,
    );

    rerender(
      <ProjectDetailView
        problem={{
          type: "https://starter.local/problems/project-version-conflict",
          title: "Project version conflict",
          status: 409,
          code: "PROJECT_VERSION_CONFLICT",
          requestId: "request_archive_conflict",
        }}
        project={activeProject}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Project name")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Archive Project" }),
      ).toBeVisible();
    });
  });

  it("removes every mutation control for a confirmed archived Project", () => {
    render(
      <ProjectDetailView project={{ ...activeProject, status: "archived" }} />,
    );

    expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive Project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm archive" }),
    ).not.toBeInTheDocument();
  });
});
