import { describe, expect, it } from "vitest";
import { createGetProject } from "./get-project.js";
import type { Project } from "./project.model.js";
import { ProjectNotFoundError } from "./project.errors.js";
import { InMemoryProjectRepository } from "./project.repository.memory.js";

const owner = { userId: "user_owner", roles: [] };

const alpha: Project = {
  id: "project_alpha",
  ownerUserId: "user_owner",
  name: "Alpha",
  status: "active",
  version: 1,
  createdAt: new Date("2026-08-03T00:00:00.000Z"),
  updatedAt: new Date("2026-08-03T00:00:00.000Z"),
};

describe("createGetProject", () => {
  it("returns a defensive Project detail", async () => {
    const getProject = createGetProject(new InMemoryProjectRepository([alpha]));

    await expect(
      getProject({ actor: owner, id: "project_alpha" }),
    ).resolves.toEqual(alpha);
  });

  it("isolates stored Projects from constructor and egress mutation", async () => {
    const input = {
      ...alpha,
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
    };
    const repository = new InMemoryProjectRepository([input]);
    const getProject = createGetProject(repository);

    input.name = "Changed input";
    input.version = 2;
    input.createdAt.setUTCFullYear(2029);
    input.updatedAt.setUTCFullYear(2030);

    const first = await getProject({ actor: owner, id: "project_alpha" });
    first.name = "Changed detail";
    first.version = 3;
    first.createdAt.setUTCFullYear(2031);
    first.updatedAt.setUTCFullYear(2031);

    const fromList = (await repository.list({ ownerUserId: "user_owner" }))[0];
    if (!fromList) throw new Error("Expected seeded Project");
    fromList.name = "Changed list";
    fromList.version = 4;
    fromList.createdAt.setUTCFullYear(2032);
    fromList.updatedAt.setUTCFullYear(2032);

    await expect(
      getProject({ actor: owner, id: "project_alpha" }),
    ).resolves.toEqual(alpha);
  });

  it("throws the typed not-found outcome", async () => {
    const getProject = createGetProject(new InMemoryProjectRepository([]));

    await expect(
      getProject({ actor: owner, id: "missing" }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("treats another user's Project as not found", async () => {
    const getProject = createGetProject(new InMemoryProjectRepository([alpha]));

    await expect(
      getProject({
        actor: { userId: "user_other", roles: [] },
        id: "project_alpha",
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
