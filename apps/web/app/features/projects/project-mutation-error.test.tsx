// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import {
  platformProblemTypes,
  projectProblemTypes,
  type PlatformProblemCode,
  type Problem,
  type ProblemCode,
  type ProjectProblemCode,
} from "@starter/contracts";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  knownProblemMessage,
  ProjectMutationError,
} from "./project-mutation-error.js";

const problemOf = (
  code: string,
  overrides: Partial<Problem> = {},
): Problem => ({
  type: `https://starter.local/problems/${code.toLowerCase()}`,
  title: `Title for ${code}`,
  status: 400,
  code,
  requestId: "request_mutation_test",
  ...overrides,
});

const knownCodes = [
  ...Object.keys(platformProblemTypes),
  ...Object.keys(projectProblemTypes),
] as ProjectProblemCode[];

afterEach(cleanup);

describe("ProjectMutationError", () => {
  // 網羅の対象は「Projects の API が返し得るコード」に限る。別モジュールのコードが
  // 契約に増えても、このフォームがコンパイルエラーにならないようにするため。
  it("covers every platform code and only the Projects codes exhaustively", () => {
    expectTypeOf<PlatformProblemCode>().toExtend<ProjectProblemCode>();
    expectTypeOf<ProjectProblemCode>().toExtend<ProblemCode>();
    expectTypeOf(knownProblemMessage)
      .parameter(0)
      .toEqualTypeOf<ProjectProblemCode>();
  });

  it("renders nothing without field errors or a Problem", () => {
    const { container } = render(
      <ProjectMutationError fieldErrors={undefined} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders name field errors with the id the input describes", () => {
    render(
      <ProjectMutationError
        fieldErrors={{ name: ["Project name is required.", "Try again."] }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project name is required. Try again.",
    );
    expect(screen.getByRole("alert")).toHaveAttribute(
      "id",
      "project-name-error",
    );
  });

  it("keeps the known Problem messages the flows depend on", () => {
    render(
      <ProjectMutationError
        fieldErrors={undefined}
        problem={problemOf("PROJECT_VERSION_CONFLICT", { status: 409 })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project was updated on the server.",
    );

    cleanup();
    render(
      <ProjectMutationError
        fieldErrors={undefined}
        problem={problemOf("PROJECT_ARCHIVED", { status: 409 })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project is archived and cannot be updated.",
    );
  });

  it.each(knownCodes)("renders a dedicated message for %s", (code) => {
    render(
      <ProjectMutationError
        fieldErrors={undefined}
        problem={problemOf(code, {
          title: "Raw contract title",
          detail: "internal stack detail",
        })}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("id", "project-mutation-problem");
    expect(alert.textContent).not.toBe("");
    expect(alert).not.toHaveTextContent("Raw contract title");
    expect(alert).not.toHaveTextContent("internal stack detail");
  });

  it("falls back to the Problem title for an unknown code", () => {
    render(
      <ProjectMutationError
        fieldErrors={undefined}
        problem={problemOf("PROJECT_QUOTA_EXCEEDED", {
          title: "Project quota exceeded",
          detail: "tenant 42 exceeded the seat quota",
          requestId: "request_unknown_code",
        })}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Project quota exceeded");
    expect(alert).toHaveTextContent("request_unknown_code");
    expect(alert).not.toHaveTextContent("tenant 42 exceeded the seat quota");
    expect(alert).toHaveAttribute("id", "project-mutation-problem");
  });

  it("never reveals developer detail for a known code", () => {
    render(
      <ProjectMutationError
        fieldErrors={undefined}
        problem={problemOf("PROJECT_VERSION_CONFLICT", {
          status: 409,
          detail: "version 3 expected, 1 sent",
        })}
      />,
    );

    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "version 3 expected, 1 sent",
    );
  });

  it("prefers field errors over the accompanying validation Problem", () => {
    render(
      <ProjectMutationError
        fieldErrors={{ name: ["Project name is required."] }}
        problem={problemOf("VALIDATION_ERROR")}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project name is required.",
    );
    expect(screen.getByRole("alert")).toHaveAttribute(
      "id",
      "project-name-error",
    );
  });

  it("still reports a validation Problem that carries no name error", () => {
    render(
      <ProjectMutationError
        fieldErrors={{ version: ["Invalid input: expected number"] }}
        problem={problemOf("VALIDATION_ERROR")}
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).not.toBe("");
  });
});
