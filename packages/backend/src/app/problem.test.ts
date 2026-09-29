import { problemTypes, type ProblemCode } from "@starter/contracts";
import type { Context } from "hono";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  ProjectValidationError,
  ProjectVersionConflictError,
  type ProjectErrorCode,
} from "../modules/projects/project.errors.js";
import { ApplicationError } from "../platform/errors/application-error.js";
import type { AppEnv } from "./app-env.js";
import { buildProblem, problemCatalog } from "./problem.js";

const context = {
  get: () => "request_problem",
  req: { path: "/api/projects" },
} as unknown as Context<AppEnv>;

// wire に出る status と title をカタログとは独立に固定する。カタログ側だけを書き換えると
// ここで落ちるので、既存クライアントに見える値の変更はテストの変更を伴う。
// satisfies により、契約のコードを足してここに書き忘れるとコンパイルエラーになる。
const wire = {
  INTERNAL_ERROR: { status: 500, title: "Internal Server Error" },
  UNAUTHENTICATED: { status: 401, title: "Unauthenticated" },
  ORIGIN_NOT_ALLOWED: { status: 403, title: "Origin not allowed" },
  VALIDATION_ERROR: { status: 400, title: "Validation Error" },
  NOT_FOUND: { status: 404, title: "Not Found" },
  PAYLOAD_TOO_LARGE: { status: 413, title: "Payload Too Large" },
  PROJECT_NOT_FOUND: { status: 404, title: "Project not found" },
  PROJECT_ARCHIVED: { status: 409, title: "Project is archived" },
  PROJECT_VERSION_CONFLICT: { status: 409, title: "Project version conflict" },
} as const satisfies Record<ProblemCode, { status: number; title: string }>;

const codes = Object.keys(problemTypes) as ProblemCode[];

describe("Problem catalog", () => {
  it.each(codes)(
    "builds a Problem with the contract type URI and catalog status for %s",
    (code) => {
      // 本文のバイト列（キーの順序を含む）が変わらないことを文字列で確かめる。
      expect(JSON.stringify(buildProblem(context, code))).toBe(
        JSON.stringify({
          type: problemTypes[code],
          title: wire[code].title,
          status: wire[code].status,
          code,
          requestId: "request_problem",
          instance: "/api/projects",
        }),
      );
    },
  );

  it("the catalog covers every Problem code the contract owns", () => {
    expect(Object.keys(problemCatalog).sort()).toEqual(
      Object.keys(problemTypes).sort(),
    );
  });

  it("appends field errors last and omits the key when there are none", () => {
    const withFields = buildProblem(context, "VALIDATION_ERROR", {
      fieldErrors: { name: ["bad"] },
    });

    expect(Object.keys(withFields).at(-1)).toBe("fieldErrors");
    expect(withFields.fieldErrors).toEqual({ name: ["bad"] });
    expect("fieldErrors" in buildProblem(context, "VALIDATION_ERROR")).toBe(
      false,
    );
  });
});

describe("domain errors", () => {
  // ドメインは contracts に依存しないので、コードが契約に含まれることはここで確かめる。
  it("uses only codes the contract owns", () => {
    expectTypeOf<ProjectErrorCode>().toExtend<ProblemCode>();
  });

  it("reaches onError as ApplicationError", () => {
    for (const error of [
      new ProjectNotFoundError("project_alpha"),
      new ProjectValidationError({ name: ["bad"] }),
      new ProjectArchivedError("project_alpha"),
      new ProjectVersionConflictError("project_alpha", 2),
    ]) {
      expect(error).toBeInstanceOf(ApplicationError);
    }
  });
});
