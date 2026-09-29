import { describe, expect, it } from "vitest";
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
} from "./project.errors.js";
import { InMemoryProjectRepository } from "./project.repository.memory.js";
import { InMemoryProjectUnitOfWork } from "./project.unit-of-work.memory.js";
import { createArchiveProject } from "./archive-project.js";
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

const findAlpha = (repository: InMemoryProjectRepository) =>
  repository.findById({ id: "project_alpha", ownerUserId: "user_owner" });

const createArchive = (repository: InMemoryProjectRepository) =>
  createArchiveProject({
    clock: () => new Date("2026-08-06T02:00:00.000Z"),
    unitOfWork: new InMemoryProjectUnitOfWork(repository),
  });

describe("createArchiveProject", () => {
  it("archives an active Project, incrementing its version and cloning the clock timestamp", async () => {
    const repository = new InMemoryProjectRepository([alpha]);

    await expect(
      createArchive(repository)({
        actor: owner,
        id: "project_alpha",
        version: 1,
      }),
    ).resolves.toEqual({
      ...alpha,
      status: "archived",
      version: 2,
      updatedAt: new Date("2026-08-06T02:00:00.000Z"),
    });
  });

  it("classifies a repeated archive as archived without advancing state", async () => {
    const repository = new InMemoryProjectRepository([alpha]);
    const archiveProject = createArchive(repository);

    await archiveProject({ actor: owner, id: "project_alpha", version: 1 });
    await expect(
      archiveProject({ actor: owner, id: "project_alpha", version: 1 }),
    ).rejects.toBeInstanceOf(ProjectArchivedError);
    await expect(findAlpha(repository)).resolves.toEqual({
      ...alpha,
      status: "archived",
      version: 2,
      updatedAt: new Date("2026-08-06T02:00:00.000Z"),
    });
  });

  it("classifies a missing Project", async () => {
    const repository = new InMemoryProjectRepository([alpha]);

    await expect(
      createArchive(repository)({ actor: owner, id: "missing", version: 1 }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("classifies a stale active version without committing an archive", async () => {
    const repository = new InMemoryProjectRepository([alpha]);

    await expect(
      createArchive(repository)({
        actor: owner,
        id: "project_alpha",
        version: 99,
      }),
    ).rejects.toBeInstanceOf(ProjectVersionConflictError);
    await expect(findAlpha(repository)).resolves.toEqual(alpha);
  });

  it("classifies another user's Project as not found even when it is archived", async () => {
    const repository = new InMemoryProjectRepository([
      { ...alpha, status: "archived" },
    ]);

    await expect(
      createArchive(repository)({
        actor: other,
        id: "project_alpha",
        version: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("classifies another user's Project as not found with a stale version and leaves it unchanged", async () => {
    const repository = new InMemoryProjectRepository([alpha]);

    await expect(
      createArchive(repository)({
        actor: other,
        id: "project_alpha",
        version: 99,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      createArchive(repository)({
        actor: other,
        id: "project_alpha",
        version: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(findAlpha(repository)).resolves.toEqual(alpha);
  });
});
