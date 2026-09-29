import { describe, expect, it } from "vitest";
import {
  createProjectInputSchema,
  isKnownProblemCode,
  isProjectProblemCode,
  listProjectsResponseSchema,
  platformProblemTypes,
  problemSchema,
  problemTypes,
  projectDtoSchema,
  projectNameMaxLength,
  projectProblemTypes,
  updateProjectInputSchema,
} from "./index.js";

const project = {
  id: "project_alpha",
  name: "Alpha",
  status: "active",
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

describe("public contracts", () => {
  it("accepts the Projects list response", () => {
    expect(listProjectsResponseSchema.parse({ items: [project] })).toEqual({
      items: [project],
    });
  });

  it.each([
    { ...project, id: "" },
    { ...project, status: "paused" },
    { ...project, updatedAt: new Date("2026-08-03T00:00:00.000Z") },
  ])("rejects an invalid Project DTO", (value) => {
    expect(projectDtoSchema.safeParse(value).success).toBe(false);
  });

  it("requires a positive integer Project version", () => {
    expect(projectDtoSchema.safeParse({ ...project, version: 0 }).success).toBe(
      false,
    );
    expect(
      projectDtoSchema.safeParse({ ...project, version: 1.5 }).success,
    ).toBe(false);
  });

  it("validates names by trimmed length without transforming them", () => {
    expect(createProjectInputSchema.parse({ name: " Alpha " })).toEqual({
      name: " Alpha ",
    });
    expect(createProjectInputSchema.safeParse({ name: "   " }).success).toBe(
      false,
    );
    expect(
      updateProjectInputSchema.safeParse({ name: "A".repeat(101), version: 1 })
        .success,
    ).toBe(false);
  });

  it("accepts exactly the shared maximum name length and rejects one more", () => {
    const atLimit = "A".repeat(projectNameMaxLength);

    expect(createProjectInputSchema.safeParse({ name: atLimit }).success).toBe(
      true,
    );
    expect(
      createProjectInputSchema.safeParse({ name: `${atLimit}A` }).success,
    ).toBe(false);
    expect(projectDtoSchema.shape.name.maxLength).toBe(projectNameMaxLength);
  });

  it("requires status, code, and requestId in a Problem", () => {
    expect(
      problemSchema.safeParse({
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
      }).success,
    ).toBe(false);
  });

  it("accepts validation field errors in a Problem", () => {
    expect(
      problemSchema.parse({
        type: "https://starter.local/problems/validation-error",
        title: "Validation Error",
        status: 400,
        code: "VALIDATION_ERROR",
        requestId: "request_test_123",
        fieldErrors: { name: ["Project name is required."] },
      }).fieldErrors,
    ).toEqual({ name: ["Project name is required."] });
  });

  it("owns the Problem type URI for every known code", () => {
    expect(problemTypes).toEqual({
      INTERNAL_ERROR: "https://starter.local/problems/internal-server-error",
      UNAUTHENTICATED: "https://starter.local/problems/unauthenticated",
      ORIGIN_NOT_ALLOWED: "https://starter.local/problems/origin-not-allowed",
      NOT_FOUND: "https://starter.local/problems/not-found",
      PAYLOAD_TOO_LARGE: "https://starter.local/problems/payload-too-large",
      PROJECT_NOT_FOUND: "https://starter.local/problems/project-not-found",
      PROJECT_ARCHIVED: "https://starter.local/problems/project-archived",
      PROJECT_VERSION_CONFLICT:
        "https://starter.local/problems/project-version-conflict",
      VALIDATION_ERROR: "https://starter.local/problems/validation-error",
    });
  });

  // スプレッドでの合成は重複キーを後勝ちで黙って上書きするので、合成後の problemTypes
  // からは重複を検出できない。合成前の表同士で確かめる。
  it("platform and project problem codes do not overlap", () => {
    const platformCodes = Object.keys(platformProblemTypes);
    const projectCodes = Object.keys(projectProblemTypes);

    expect(projectCodes.filter((code) => platformCodes.includes(code))).toEqual(
      [],
    );
    expect(Object.keys(problemTypes).sort()).toEqual(
      [...platformCodes, ...projectCodes].sort(),
    );
  });

  it("narrows only the codes a Projects API can return", () => {
    expect(isProjectProblemCode("PROJECT_ARCHIVED")).toBe(true);
    expect(isProjectProblemCode("UNAUTHENTICATED")).toBe(true);
    expect(isProjectProblemCode("TASK_NOT_FOUND")).toBe(false);
    expect(isProjectProblemCode("toString")).toBe(false);
  });

  it("keeps the wire schema tolerant of codes it does not know yet", () => {
    expect(
      problemSchema.safeParse({
        type: "https://starter.local/problems/future",
        title: "Future",
        status: 418,
        code: "SOMETHING_NEW",
        requestId: "request_test_123",
      }).success,
    ).toBe(true);
    expect(isKnownProblemCode("SOMETHING_NEW")).toBe(false);
    expect(isKnownProblemCode("VALIDATION_ERROR")).toBe(true);
  });
});
