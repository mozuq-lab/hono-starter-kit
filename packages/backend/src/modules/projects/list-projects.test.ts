import { describe, expect, it } from "vitest";
import { InMemoryProjectRepository } from "./project.repository.memory.js";
import { createListProjects } from "./list-projects.js";
import type { Project } from "./project.model.js";
import type { ProjectRepository } from "./project.repository.js";

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

describe("listProjects", () => {
  it("returns a defensive copy of repository Projects", async () => {
    const listProjects = createListProjects(
      new InMemoryProjectRepository([alpha]),
    );
    await expect(listProjects({ actor: owner })).resolves.toEqual([alpha]);
  });

  it("lists projects newest first, breaking ties by id descending", async () => {
    const older = {
      ...alpha,
      id: "project_older",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-09T00:00:00.000Z"),
    };
    const tiedLow = { ...alpha, id: "project_b" };
    const tiedHigh = { ...alpha, id: "project_c" };
    const newest = {
      ...alpha,
      id: "project_a",
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    };
    const listProjects = createListProjects(
      new InMemoryProjectRepository([older, tiedLow, newest, tiedHigh]),
    );

    await expect(listProjects({ actor: owner })).resolves.toEqual([
      newest,
      tiedHigh,
      tiedLow,
      older,
    ]);
  });

  it("lists only the projects the actor owns", async () => {
    const others = {
      ...alpha,
      id: "project_others",
      ownerUserId: "user_other",
    };
    const listProjects = createListProjects(
      new InMemoryProjectRepository([alpha, others]),
    );

    await expect(listProjects({ actor: owner })).resolves.toEqual([alpha]);
    await expect(
      listProjects({ actor: { userId: "user_other", roles: [] } }),
    ).resolves.toEqual([others]);
  });

  it("returns an empty list", async () => {
    const listProjects = createListProjects(new InMemoryProjectRepository([]));
    await expect(listProjects({ actor: owner })).resolves.toEqual([]);
  });

  it("does not hide repository failures", async () => {
    const failure = new Error("repository unavailable");
    const repository: ProjectRepository = {
      list: async () => Promise.reject(failure),
      findById: async () => Promise.reject(failure),
      create: async () => Promise.reject(failure),
      update: async () => Promise.reject(failure),
      archive: async () => Promise.reject(failure),
    };
    await expect(createListProjects(repository)({ actor: owner })).rejects.toBe(
      failure,
    );
  });
});
