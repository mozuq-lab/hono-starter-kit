import { describe, expect, it } from "vitest";
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
} from "./project.errors.js";
import { InMemoryProjectRepository } from "./project.repository.memory.js";
import { InMemoryProjectUnitOfWork } from "./project.unit-of-work.memory.js";
import { createUpdateProject } from "./update-project.js";
import type { Project } from "./project.model.js";

const owner = { userId: "user_owner", roles: [] };
const other = { userId: "user_other", roles: [] };

const alpha: Project = {
  id: "project_alpha",
  ownerUserId: "user_owner",
  name: "Alpha",
  status: "active",
  version: 1,
  createdAt: new Date("2026-08-03T00:00:00.000Z"),
  updatedAt: new Date("2026-08-03T00:00:00.000Z"),
};

const archived: Project = {
  id: "project_archived",
  ownerUserId: "user_owner",
  name: "Archived",
  status: "archived",
  version: 1,
  createdAt: new Date("2026-08-04T00:00:00.000Z"),
  updatedAt: new Date("2026-08-04T00:00:00.000Z"),
};

const findAlpha = (repository: InMemoryProjectRepository) =>
  repository.findById({ id: "project_alpha", ownerUserId: "user_owner" });

const createUpdate = (repository: InMemoryProjectRepository) =>
  createUpdateProject({
    clock: () => new Date("2026-08-06T01:00:00.000Z"),
    unitOfWork: new InMemoryProjectUnitOfWork(repository),
  });

describe("createUpdateProject", () => {
  it("normalizes an active Project name and increments its version", async () => {
    const repository = new InMemoryProjectRepository([alpha]);

    await expect(
      createUpdate(repository)({
        actor: owner,
        id: "project_alpha",
        name: "  Renamed  ",
        version: 1,
      }),
    ).resolves.toEqual({
      ...alpha,
      name: "Renamed",
      version: 2,
      updatedAt: new Date("2026-08-06T01:00:00.000Z"),
    });
  });

  it("classifies a missing Project", async () => {
    const repository = new InMemoryProjectRepository([alpha]);

    await expect(
      createUpdate(repository)({
        actor: owner,
        id: "missing",
        name: "Name",
        version: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("classifies an archived Project", async () => {
    const repository = new InMemoryProjectRepository([archived]);

    await expect(
      createUpdate(repository)({
        actor: owner,
        id: "project_archived",
        name: "Name",
        version: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectArchivedError);
  });

  it("classifies a stale version without committing the attempted write", async () => {
    const repository = new InMemoryProjectRepository([alpha]);

    await expect(
      createUpdate(repository)({
        actor: owner,
        id: "project_alpha",
        name: "Name",
        version: 99,
      }),
    ).rejects.toBeInstanceOf(ProjectVersionConflictError);
    await expect(findAlpha(repository)).resolves.toEqual(alpha);
  });

  it("rejects an invalid name before opening the unit of work", async () => {
    let opened = false;
    const repository = new InMemoryProjectRepository([alpha]);
    const updateProject = createUpdateProject({
      clock: () => new Date("2026-08-06T01:00:00.000Z"),
      unitOfWork: {
        execute: async () => {
          opened = true;
          return Promise.reject(new Error("unit of work should not open"));
        },
      },
    });

    await expect(
      updateProject({
        actor: owner,
        id: "project_alpha",
        name: "   ",
        version: 1,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(opened).toBe(false);
    await expect(findAlpha(repository)).resolves.toEqual(alpha);
  });

  it("classifies another user's Project as not found and leaves it unchanged", async () => {
    const repository = new InMemoryProjectRepository([alpha, archived]);

    await expect(
      createUpdate(repository)({
        actor: other,
        id: "project_alpha",
        name: "Hijacked",
        version: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      createUpdate(repository)({
        actor: other,
        id: "project_archived",
        name: "Hijacked",
        version: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(findAlpha(repository)).resolves.toEqual(alpha);
  });
});
