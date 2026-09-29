import { createHash } from "node:crypto";
import { getDevIdentity, type Project } from "@starter/backend";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { KyselyAuthSessionStore } from "./auth-session-store.kysely.js";
import {
  closeDatabaseIntegrationResources,
  createGuardedDatabaseIntegrationResources,
  resetToLatestSchema,
} from "./database-test-support.js";
import { KyselyProjectRepository } from "./project.repository.kysely.js";
import { KyselyProjectUnitOfWork } from "./project.unit-of-work.kysely.js";
import { seedAlphaProject } from "./seed.js";

const resources = createGuardedDatabaseIntegrationResources({
  environment: process.env,
});
const { db, pool } = resources;
const repository = new KyselyProjectRepository(db);
const unitOfWork = new KyselyProjectUnitOfWork(db);

beforeEach(async () => {
  await resetToLatestSchema(resources.pool, resources.ownedDatabaseName);
});

afterAll(async () => {
  await closeDatabaseIntegrationResources({
    close: () => resources.close(),
    temporaryMigrationsRoot: undefined,
  });
});

const owner = "user_owner";
const other = "user_other";

const insertUser = (id: string) =>
  db
    .insertInto("users")
    .values({
      id,
      email: null,
      display_name: null,
      roles: [],
      created_at: new Date("2026-08-01T00:00:00.000Z"),
      updated_at: new Date("2026-08-01T00:00:00.000Z"),
    })
    .execute();

const project = (overrides: Partial<Project> & { id: string }): Project => ({
  ownerUserId: owner,
  name: "Project",
  status: "active",
  version: 1,
  createdAt: new Date("2026-08-02T00:00:00.000Z"),
  updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  ...overrides,
});

const created = project({
  id: "project_created",
  name: "Created",
  createdAt: new Date("2026-08-06T00:00:00.000Z"),
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
});

const createProject = () =>
  unitOfWork.execute(({ projects }) => projects.create(created));

const sqlStateOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );

// establish と同じ形の Dev ログイン。session の ID は DB の CHECK に合う 64 桁の hex にする。
const devLogin = (newUserId: string, at: string) =>
  new KyselyAuthSessionStore(db).establish({
    identity: getDevIdentity(),
    newUserId,
    session: {
      idHash: createHash("sha256").update(`${newUserId}:${at}`).digest("hex"),
      absoluteExpiresAt: new Date(Date.parse(at) + 7 * 24 * 60 * 60 * 1000),
      idleExpiresAt: new Date(Date.parse(at) + 24 * 60 * 60 * 1000),
      createdAt: new Date(at),
      lastAccessedAt: new Date(at),
    },
  });

// 本番の seed では api-node が同じ組み合わせ（Dev identity と固定の user ID）を渡す。
const devOwner = {
  identity: getDevIdentity(),
  userId: "user_local_developer",
};

const alphaOwnedBy = (ownerUserId: string): Project => ({
  id: "project_alpha",
  ownerUserId,
  name: "Alpha",
  status: "active",
  version: 1,
  createdAt: new Date("2026-08-03T00:00:00.000Z"),
  updatedAt: new Date("2026-08-03T00:00:00.000Z"),
});

describe("KyselyProjectRepository", () => {
  beforeEach(async () => {
    await insertUser(owner);
    await insertUser(other);
  });

  it("lists only the owner's projects newest first, breaking ties by id descending", async () => {
    const older = project({
      id: "project_older",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      // 更新日時は並びに影響しない。
      updatedAt: new Date("2026-08-09T00:00:00.000Z"),
    });
    const tiedLow = project({ id: "project_b" });
    const tiedHigh = project({ id: "project_c" });
    const newest = project({
      id: "project_a",
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
      updatedAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    const others = project({
      id: "project_others",
      ownerUserId: other,
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
      updatedAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    for (const row of [older, tiedLow, newest, others, tiedHigh]) {
      await repository.create(row);
    }

    const projects = await repository.list({ ownerUserId: owner });

    expect(projects).toEqual([newest, tiedHigh, tiedLow, older]);
    expect(projects[0]?.createdAt).toBeInstanceOf(Date);
    await expect(repository.list({ ownerUserId: other })).resolves.toEqual([
      others,
    ]);
  });

  it("treats another user's project as absent for reads and writes and leaves it unchanged", async () => {
    await createProject();

    await expect(
      repository.findById({ id: "project_created", ownerUserId: other }),
    ).resolves.toBeUndefined();
    await expect(
      repository.update({
        id: "project_created",
        ownerUserId: other,
        name: "Hijacked",
        expectedVersion: 1,
        updatedAt: new Date("2026-08-06T01:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.archive({
        id: "project_created",
        ownerUserId: other,
        expectedVersion: 1,
        updatedAt: new Date("2026-08-06T01:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findById({ id: "project_created", ownerUserId: owner }),
    ).resolves.toEqual(created);
  });

  it("commits a project created inside a unit of work", async () => {
    await expect(createProject()).resolves.toEqual(created);
    await expect(
      repository.findById({ id: "project_created", ownerUserId: owner }),
    ).resolves.toEqual(created);
  });

  it("updates with the expected version and ignores a stale version", async () => {
    await createProject();
    const updated = {
      ...created,
      name: "Updated",
      version: 2,
      updatedAt: new Date("2026-08-06T01:00:00.000Z"),
    };

    await expect(
      repository.update({
        id: "project_created",
        ownerUserId: owner,
        name: "Updated",
        expectedVersion: 1,
        updatedAt: new Date("2026-08-06T01:00:00.000Z"),
      }),
    ).resolves.toEqual(updated);
    await expect(
      repository.update({
        id: "project_created",
        ownerUserId: owner,
        name: "Stale",
        expectedVersion: 1,
        updatedAt: new Date("2026-08-06T01:01:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.findById({ id: "project_created", ownerUserId: owner }),
    ).resolves.toEqual(updated);
  });

  it("archives with the expected version and ignores a stale version", async () => {
    await createProject();
    const archived = {
      ...created,
      status: "archived" as const,
      version: 2,
      updatedAt: new Date("2026-08-06T02:00:00.000Z"),
    };

    await expect(
      repository.archive({
        id: "project_created",
        ownerUserId: owner,
        expectedVersion: 1,
        updatedAt: new Date("2026-08-06T02:00:00.000Z"),
      }),
    ).resolves.toEqual(archived);
    await expect(
      repository.archive({
        id: "project_created",
        ownerUserId: owner,
        expectedVersion: 1,
        updatedAt: new Date("2026-08-06T02:01:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    await expect(repository.list({ ownerUserId: owner })).resolves.toEqual([
      archived,
    ]);
  });

  it("rolls back a project created inside a unit of work that throws", async () => {
    await expect(
      unitOfWork.execute(async ({ projects }) => {
        await projects.create(project({ id: "project_rolled_back" }));
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    await expect(
      repository.findById({ id: "project_rolled_back", ownerUserId: owner }),
    ).resolves.toBeUndefined();
  });
});

describe("projects constraints", () => {
  beforeEach(async () => {
    await insertUser(owner);
  });

  it("rejects a project without an owner", async () => {
    await expect(
      sqlStateOf(
        pool.query(
          `insert into projects (id, name, status, created_at, updated_at)
           values ('project_orphan', 'Orphan', 'active', $1, $1)`,
          ["2026-08-06T00:00:00.000Z"],
        ),
      ),
    ).resolves.toBe("23502");
  });

  it("rejects an owner that is not a user", async () => {
    await expect(
      sqlStateOf(
        repository.create(
          project({ id: "project_ghost", ownerUserId: "ghost" }),
        ),
      ),
    ).resolves.toBe("23503");
  });

  // default に頼ると、アプリが created_at を入れ忘れても黙って通ってしまう。
  it("rejects a project without created_at instead of defaulting it", async () => {
    await expect(
      sqlStateOf(
        pool.query(
          `insert into projects (id, owner_user_id, name, status, updated_at)
           values ('project_undated', $1, 'Undated', 'active', $2)`,
          [owner, "2026-08-06T00:00:00.000Z"],
        ),
      ),
    ).resolves.toBe("23502");
  });

  it("rejects updated_at earlier than created_at", async () => {
    await expect(
      sqlStateOf(
        repository.create(
          project({
            id: "project_backwards",
            createdAt: new Date("2026-08-06T00:00:00.001Z"),
            updatedAt: new Date("2026-08-06T00:00:00.000Z"),
          }),
        ),
      ),
    ).resolves.toBe("23514");
  });
});

describe("seedAlphaProject", () => {
  it("lets the first Dev login after a fresh seed see Alpha", async () => {
    await seedAlphaProject(db, devOwner);

    const user = await devLogin(
      "user_random_after_seed",
      "2026-08-10T00:00:00.000Z",
    );

    expect(user.id).toBe("user_local_developer");
    await expect(repository.list({ ownerUserId: user.id })).resolves.toEqual([
      alphaOwnedBy("user_local_developer"),
    ]);
  });

  it("gives Alpha to the Dev user that logged in before the seed", async () => {
    const user = await devLogin(
      "user_logged_in_first",
      "2026-08-10T00:00:00.000Z",
    );

    await seedAlphaProject(db, devOwner);

    await expect(repository.list({ ownerUserId: user.id })).resolves.toEqual([
      alphaOwnedBy("user_logged_in_first"),
    ]);
    // seed が別の user を作って identity を付け替えていないこと。
    const users = await db.selectFrom("users").select("id").execute();
    expect(users).toEqual([{ id: "user_logged_in_first" }]);
    const again = await devLogin("user_unused", "2026-08-11T00:00:00.000Z");
    expect(again.id).toBe("user_logged_in_first");
  });

  it("restores the name, owner, and timestamps of Alpha and keeps other projects when run again", async () => {
    await seedAlphaProject(db, devOwner);
    await repository.update({
      id: "project_alpha",
      ownerUserId: "user_local_developer",
      name: "Renamed",
      expectedVersion: 1,
      updatedAt: new Date("2026-08-12T00:00:00.000Z"),
    });
    const beta = project({
      id: "project_beta",
      ownerUserId: "user_local_developer",
      name: "Beta",
      status: "archived",
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
      updatedAt: new Date("2026-08-04T00:00:00.000Z"),
    });
    await repository.create(beta);
    // 別の user に移された Alpha も、再 seed で Dev の user に戻る。
    await insertUser(other);
    await db
      .updateTable("projects")
      .set({ owner_user_id: other })
      .where("id", "=", "project_alpha")
      .execute();

    await seedAlphaProject(db, devOwner);

    await expect(
      repository.list({ ownerUserId: "user_local_developer" }),
    ).resolves.toEqual([beta, alphaOwnedBy("user_local_developer")]);
    await expect(repository.list({ ownerUserId: other })).resolves.toEqual([]);
  });
});
