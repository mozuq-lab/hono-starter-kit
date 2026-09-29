import { describe, expect, it } from "vitest";
import { createCreateProject } from "./create-project.js";
import { InMemoryProjectRepository } from "./project.repository.memory.js";
import { InMemoryProjectUnitOfWork } from "./project.unit-of-work.memory.js";

const owner = { userId: "user_owner", roles: [] };

describe("createCreateProject", () => {
  it("creates a normalized active version-one Project owned by the actor", async () => {
    const repository = new InMemoryProjectRepository([]);
    const unitOfWork = new InMemoryProjectUnitOfWork(repository);
    const createProject = createCreateProject({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      generateId: () => "created",
      unitOfWork,
    });

    await expect(
      createProject({ actor: owner, name: "  Created  " }),
    ).resolves.toEqual({
      id: "project_created",
      ownerUserId: "user_owner",
      name: "Created",
      status: "active",
      version: 1,
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
      updatedAt: new Date("2026-08-06T00:00:00.000Z"),
    });
    await expect(
      repository.findById({ id: "project_created", ownerUserId: "user_owner" }),
    ).resolves.toMatchObject({ name: "Created", version: 1 });
  });

  it("sets createdAt and updatedAt to the same clock reading", async () => {
    const readings = [
      new Date("2026-08-06T00:00:00.000Z"),
      new Date("2026-08-06T00:00:01.000Z"),
    ];
    const createProject = createCreateProject({
      clock: () => readings.shift() ?? new Date(Number.NaN),
      generateId: () => "created",
      unitOfWork: new InMemoryProjectUnitOfWork(
        new InMemoryProjectRepository([]),
      ),
    });

    const created = await createProject({ actor: owner, name: "Created" });

    expect(created.createdAt).toEqual(new Date("2026-08-06T00:00:00.000Z"));
    expect(created.updatedAt).toEqual(created.createdAt);
    expect(created.updatedAt).not.toBe(created.createdAt);
  });

  it("leaves the committed repository unchanged when unit-of-work work rejects", async () => {
    const repository = new InMemoryProjectRepository([]);
    const unitOfWork = new InMemoryProjectUnitOfWork(repository);

    await expect(
      unitOfWork.execute(async ({ projects }) => {
        await projects.create({
          id: "project_rolled_back",
          ownerUserId: "user_owner",
          name: "Rolled Back",
          status: "active",
          version: 1,
          createdAt: new Date("2026-08-06T00:00:00.000Z"),
          updatedAt: new Date("2026-08-06T00:00:00.000Z"),
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    await expect(
      repository.findById({
        id: "project_rolled_back",
        ownerUserId: "user_owner",
      }),
    ).resolves.toBeUndefined();
  });
});
