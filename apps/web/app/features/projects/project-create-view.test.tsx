// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { problemTypes } from "@starter/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectCreateView } from "./project-create-view.js";

afterEach(cleanup);

describe("ProjectCreateView", () => {
  it("submits the entered Project name", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ProjectCreateView onSubmit={onSubmit} />);

    expect(screen.getByLabelText("Project name")).toBeEnabled();
    await user.type(screen.getByLabelText("Project name"), "Created");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(onSubmit).toHaveBeenCalledWith("Created");
  });

  it("disables duplicate submission while pending and links a name error", () => {
    render(
      <ProjectCreateView
        pending
        fieldErrors={{ name: ["Project name is required."] }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Create Project" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Project name")).toHaveAttribute(
      "aria-describedby",
      "project-name-error",
    );
    expect(screen.getByText("Project name is required.")).toHaveAttribute(
      "id",
      "project-name-error",
    );
  });

  it("limits the name input to the contract's maximum length", () => {
    render(<ProjectCreateView />);

    expect(screen.getByLabelText("Project name")).toHaveAttribute(
      "maxlength",
      "100",
    );
  });

  it("describes the name input with a mutation Problem alert", () => {
    render(
      <ProjectCreateView
        problem={{
          type: problemTypes.INTERNAL_ERROR,
          title: "Internal Server Error",
          status: 500,
          code: "INTERNAL_ERROR",
          requestId: "request_create_failed",
        }}
      />,
    );

    const describedBy = screen
      .getByLabelText("Project name")
      .getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(screen.getByRole("alert")).toHaveAttribute("id", describedBy);
  });

  it("keeps the typed name after a failed creation", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ProjectCreateView />);

    await user.type(screen.getByLabelText("Project name"), "Created");
    rerender(
      <ProjectCreateView
        fieldErrors={{ name: ["Project name is required."] }}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("Created");
  });
});
