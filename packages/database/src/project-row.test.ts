import { describe, expect, it } from "vitest";
import { toProject } from "./project-row.js";

const createdAt = new Date("2026-08-02T00:00:00.000Z");
const updatedAt = new Date("2026-08-03T00:00:00.000Z");
const row = {
  id: "project_alpha",
  owner_user_id: "user_owner",
  name: "Alpha",
  status: "active" as const,
  version: 1,
  created_at: createdAt,
  updated_at: updatedAt,
};

describe("toProject", () => {
  it("maps a PostgreSQL row to the internal model without leaking the row", () => {
    const project = toProject(row);

    expect(project).toEqual({
      id: "project_alpha",
      ownerUserId: "user_owner",
      name: "Alpha",
      status: "active",
      version: 1,
      createdAt,
      updatedAt,
    });
    expect(project.createdAt).not.toBe(createdAt);
    expect(project.updatedAt).not.toBe(updatedAt);
    expect(project).not.toHaveProperty("updated_at");
    expect(project).not.toHaveProperty("created_at");
    expect(project).not.toHaveProperty("owner_user_id");
  });

  it("rejects an invalid updated_at returned by the driver", () => {
    expect(() =>
      toProject({ ...row, updated_at: new Date(Number.NaN) }),
    ).toThrow("projects.updated_at must be a valid Date");
  });

  it("rejects an invalid created_at returned by the driver", () => {
    expect(() =>
      toProject({ ...row, created_at: new Date(Number.NaN) }),
    ).toThrow("projects.created_at must be a valid Date");
  });
});
