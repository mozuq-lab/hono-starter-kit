import { projectNameMaxLength } from "@starter/contracts";
import { describe, expect, it } from "vitest";
import { ProjectValidationError } from "./project.errors.js";
import { normalizeProjectName } from "./project-name.js";

describe("normalizeProjectName", () => {
  it("trims one valid Project name", () => {
    expect(normalizeProjectName("  Alpha  ")).toBe("Alpha");
  });

  it.each(["", "   ", "A".repeat(101)])(
    "rejects an invalid Project name",
    (name) => {
      expect(() => normalizeProjectName(name)).toThrow(ProjectValidationError);
    },
  );

  // ドメインは contracts に依存させず値を自前で持つので、上限がずれたら CI で気づけるようにする。
  it("accepts exactly projectNameMaxLength characters and rejects one more", () => {
    expect(normalizeProjectName("A".repeat(projectNameMaxLength))).toHaveLength(
      projectNameMaxLength,
    );
    expect(() =>
      normalizeProjectName("A".repeat(projectNameMaxLength + 1)),
    ).toThrow(ProjectValidationError);
  });
});
