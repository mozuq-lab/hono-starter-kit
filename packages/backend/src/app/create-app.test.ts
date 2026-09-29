import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createCreateProject,
  type CreateProject,
} from "../modules/projects/create-project.js";
import {
  createArchiveProject,
  type ArchiveProject,
} from "../modules/projects/archive-project.js";
import {
  createGetProject,
  type GetProject,
} from "../modules/projects/get-project.js";
import {
  createListProjects,
  type ListProjects,
} from "../modules/projects/list-projects.js";
import type { Project } from "../modules/projects/project.model.js";
import { InMemoryProjectRepository } from "../modules/projects/project.repository.memory.js";
import { InMemoryProjectUnitOfWork } from "../modules/projects/project.unit-of-work.memory.js";
import {
  createUpdateProject,
  type UpdateProject,
} from "../modules/projects/update-project.js";
import { InMemoryAuthSessionStore } from "../platform/auth/auth-session-store.memory.js";
import {
  createAuthenticateSession,
  type AuthenticateSession,
} from "../platform/auth/authenticate-session.js";
import { createDevLoginRoutes } from "../platform/auth/dev-login.routes.js";
import { createEstablishSession } from "../platform/auth/establish-session.js";
import { getDevIdentity } from "../platform/auth/dev-identity.js";
import { createRevokeSession } from "../platform/auth/revoke-session.js";
import type { SessionCookieConfig } from "../platform/auth/session-cookie.js";
import { ApplicationError } from "../platform/errors/application-error.js";
import type { AppEnv } from "./app-env.js";
import { createApp } from "./create-app.js";
import type { ObserveRequest, RequestOutcome } from "./request-observer.js";

// createTestApp の Dev ログインは generateUserId で user_test になる。
const alpha: Project = {
  id: "project_alpha",
  ownerUserId: "user_test",
  name: "Alpha",
  status: "active",
  version: 1,
  createdAt: new Date("2026-08-03T00:00:00.000Z"),
  updatedAt: new Date("2026-08-03T00:00:00.000Z"),
};

const alphaDto = {
  id: "project_alpha",
  name: "Alpha",
  status: "active",
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const unusedCreateProject = async (input: { name: string }): Promise<never> => {
  void input;
  return Promise.reject(new Error("createProject is not used by this test"));
};

const unusedUpdateProject = async (input: {
  id: string;
  name: string;
  version: number;
}): Promise<never> => {
  void input;
  return Promise.reject(new Error("updateProject is not used by this test"));
};

const unusedArchiveProject = async (input: {
  id: string;
  version: number;
}): Promise<never> => {
  void input;
  return Promise.reject(new Error("archiveProject is not used by this test"));
};

const allowedOrigin = "http://127.0.0.1:5173";
const sessionCookie: SessionCookieConfig = {
  name: "session",
  secure: false,
  maxAgeSeconds: 604_800,
};
const sessionPolicy = {
  absoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  idleTtlMs: 24 * 60 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
};

type ProjectTestDependencies = {
  createProject: CreateProject;
  archiveProject: ArchiveProject;
  getProject: GetProject;
  listProjects: ListProjects;
  updateProject: UpdateProject;
};

const createTestApp = (
  projectDependencies: ProjectTestDependencies,
  {
    authenticateByDefault = true,
    authenticateSession: authenticateSessionOverride,
    loginRoutes: loginRoutesOverride,
    observeRequest,
  }: {
    authenticateByDefault?: boolean;
    authenticateSession?: AuthenticateSession;
    loginRoutes?: Hono<AppEnv>;
    observeRequest?: ObserveRequest;
  } = {},
) => {
  const store = new InMemoryAuthSessionStore();
  let sessionSequence = 0;
  const clock = () => new Date("2026-08-06T00:00:00.000Z");
  const hashSessionId = (value: string) => `hash:${value}`;
  const establishSession = createEstablishSession({
    clock,
    generateSessionId: () => `raw_session_${++sessionSequence}`,
    generateUserId: () => "user_test",
    hashSessionId,
    policy: sessionPolicy,
    store,
  });
  const authenticateSession = createAuthenticateSession({
    clock,
    hashSessionId,
    policy: sessionPolicy,
    store,
  });
  const revokeSession = createRevokeSession({ hashSessionId, store });
  const loginRoutes =
    loginRoutesOverride ??
    createDevLoginRoutes({
      establishSession,
      sessionCookie,
    });
  const app = createApp({
    ...projectDependencies,
    allowedOrigin,
    authenticateSession: authenticateSessionOverride ?? authenticateSession,
    loginRoutes,
    revokeSession,
    sessionCookie,
    ...(observeRequest === undefined ? {} : { observeRequest }),
  });
  const defaultSession = authenticateByDefault
    ? establishSession({ identity: getDevIdentity() })
    : Promise.resolve(undefined);

  return {
    request: async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authentication = await defaultSession;
      if (
        authentication !== undefined &&
        path.startsWith("/api/") &&
        !headers.has("Cookie")
      ) {
        headers.set("Cookie", `session=${authentication.sessionId}`);
      }
      if (
        authenticateByDefault &&
        path.startsWith("/api/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(
          init?.method?.toUpperCase() ?? "GET",
        ) &&
        !headers.has("Origin")
      ) {
        headers.set("Origin", allowedOrigin);
      }
      return app.request(path, { ...init, headers });
    },
  };
};

const unusedProjectDependencies = (): ProjectTestDependencies => {
  const repository = new InMemoryProjectRepository([]);
  return {
    archiveProject: unusedArchiveProject,
    createProject: unusedCreateProject,
    getProject: createGetProject(repository),
    listProjects: createListProjects(repository),
    updateProject: unusedUpdateProject,
  };
};

const responseCookie = (response: Response): string => {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
};

const assertArchiveProjectIsRequired = () => {
  // @ts-expect-error 明示的な合成では archiveProject は必須。
  createTestApp({
    createProject: unusedCreateProject,
    getProject: createGetProject(new InMemoryProjectRepository([])),
    listProjects: () => Promise.resolve([]),
    updateProject: unusedUpdateProject,
  });
};
void assertArchiveProjectIsRequired;

describe("createApp", () => {
  it("mounts a general login route adapter without coupling to Dev auth", async () => {
    const loginRoutes = new Hono<AppEnv>().get("/login", (context) =>
      context.text("external login", 418),
    );
    const app = createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
      loginRoutes,
    });

    const response = await app.request("/auth/login");

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("external login");
  });

  it("keeps health public and protects Projects and current user", async () => {
    const app = createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
    });

    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("cache-control")).toBeNull();

    for (const path of ["/api/me", "/api/projects"]) {
      const response = await app.request(path, {
        headers: { "X-Request-Id": "request_unauthenticated" },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        status: 401,
        code: "UNAUTHENTICATED",
        requestId: "request_unauthenticated",
      });
    }
  });

  it("returns indistinguishable Problems for missing and unknown sessions", async () => {
    const app = createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
    });
    const headers = { "X-Request-Id": "request_same_failure" };

    const missing = await app.request("/api/me", { headers });
    const unknown = await app.request("/api/me", {
      headers: { ...headers, Cookie: "session=unknown_session" },
    });

    expect(missing.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await missing.json());
  });

  it("logs in, authenticates API requests, and rotates an existing session", async () => {
    const app = createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
    });

    const firstLogin = await app.request(
      "/auth/login?returnTo=%2Fprojects%2Fproject_alpha",
    );
    expect(firstLogin.status).toBe(303);
    expect(firstLogin.headers.get("location")).toBe("/projects/project_alpha");
    expect(firstLogin.headers.get("cache-control")).toBe("no-store");
    expect(firstLogin.headers.get("set-cookie")).toContain("session=");
    expect(firstLogin.headers.get("set-cookie")).not.toContain("Secure");
    const firstCookie = responseCookie(firstLogin);

    const me = await app.request("/api/me", {
      headers: { Cookie: firstCookie },
    });
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await me.json()).toEqual({
      user: {
        id: "user_test",
        email: "developer@starter.local",
        displayName: "Local Developer",
        roles: ["projects:read", "projects:write"],
      },
    });

    const projects = await app.request("/api/projects", {
      headers: { Cookie: firstCookie },
    });
    expect(projects.status).toBe(200);
    expect(projects.headers.get("cache-control")).toBe("no-store");

    const wrongCookieName = await app.request("/api/me", {
      headers: { Cookie: `__Host-${firstCookie}` },
    });
    expect(wrongCookieName.status).toBe(401);

    const secondLogin = await app.request("/auth/login", {
      headers: { Cookie: firstCookie },
    });
    expect(secondLogin.status).toBe(303);
    expect(secondLogin.headers.get("location")).toBe("/projects");
    const secondCookie = responseCookie(secondLogin);
    expect(secondCookie).not.toBe(firstCookie);

    const rotated = await app.request("/api/me", {
      headers: { Cookie: firstCookie },
    });
    const current = await app.request("/api/me", {
      headers: { Cookie: secondCookie },
    });
    expect(rotated.status).toBe(401);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("no-store");
  });

  it("does not emit a protocol-relative login redirect after path normalization", async () => {
    const app = createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
    });

    const response = await app.request(
      `/auth/login?returnTo=${encodeURIComponent("/.//evil.example/steal")}`,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/projects");
  });

  it("requires the exact Origin to log out, clears the cookie, and revokes it", async () => {
    const app = createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
    });
    const login = await app.request("/auth/login");
    const cookie = responseCookie(login);

    const rejected = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(await rejected.json()).toMatchObject({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
    });

    const logout = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: allowedOrigin },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("cache-control")).toBe("no-store");
    expect(logout.headers.get("set-cookie")).toContain("session=");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    const revoked = await app.request("/api/me", {
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(401);
  });

  it("requires the exact Origin before unsafe Project writes", async () => {
    const repository = new InMemoryProjectRepository([]);
    const app = createTestApp(
      {
        archiveProject: unusedArchiveProject,
        getProject: createGetProject(repository),
        listProjects: createListProjects(repository),
        createProject: createCreateProject({
          clock: () => new Date("2026-08-06T00:00:00.000Z"),
          generateId: () => "created",
          unitOfWork: new InMemoryProjectUnitOfWork(repository),
        }),
        updateProject: unusedUpdateProject,
      },
      { authenticateByDefault: false },
    );
    const cookie = responseCookie(await app.request("/auth/login"));
    const request = (origin?: string) =>
      app.request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Created" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          ...(origin === undefined ? {} : { Origin: origin }),
        },
      });

    const missing = await request();
    const different = await request("http://localhost:5173");
    expect(missing.status).toBe(403);
    expect(different.status).toBe(403);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(
      repository.list({ ownerUserId: "user_test" }),
    ).resolves.toEqual([]);

    const allowed = await request(allowedOrigin);
    expect(allowed.status).toBe(201);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  });

  it("creates a normalized Project with its public DTO and Location", async () => {
    const repository = new InMemoryProjectRepository([]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      createProject: createCreateProject({
        clock: () => new Date("2026-08-06T00:00:00.000Z"),
        generateId: () => "created",
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
      updateProject: unusedUpdateProject,
    }).request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: " Created " }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(
      "/api/projects/project_created",
    );
    expect(await response.json()).toEqual({
      id: "project_created",
      name: "Created",
      status: "active",
      version: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
  });

  it("returns request-ID-preserving field errors for an invalid Project name", async () => {
    const repository = new InMemoryProjectRepository([]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      createProject: createCreateProject({
        clock: () => new Date("2026-08-06T00:00:00.000Z"),
        generateId: () => "created",
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
      updateProject: unusedUpdateProject,
    }).request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_create_invalid",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_create_invalid",
      fieldErrors: { name: ["Project name is required."] },
    });
  });

  it("returns a request-ID-preserving validation Problem for malformed JSON", async () => {
    const repository = new InMemoryProjectRepository([]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      createProject: createCreateProject({
        clock: () => new Date("2026-08-06T00:00:00.000Z"),
        generateId: () => "created",
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
      updateProject: unusedUpdateProject,
    }).request("/api/projects", {
      method: "POST",
      body: '{"name":',
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_create_malformed",
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_create_malformed",
      fieldErrors: { body: ["Request body must be valid JSON."] },
    });
  });

  // Content-Type が JSON でない要求は本文を読まずに検証へ進む。宣言と中身の食い違いを
  // サーバが推測で埋めないための境界であり、api-client は hc 経由で常にこの型を付ける。
  it("rejects a JSON body sent without a JSON Content-Type", async () => {
    const repository = new InMemoryProjectRepository([]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      createProject: createCreateProject({
        clock: () => new Date("2026-08-06T00:00:00.000Z"),
        generateId: () => "created",
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
      updateProject: unusedUpdateProject,
    }).request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Example" }),
      headers: {
        "Content-Type": "text/plain",
        "X-Request-Id": "request_create_untyped_body",
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_create_untyped_body",
    });
  });

  it("returns Projects as public DTOs", async () => {
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([alpha])),
      listProjects: () => Promise.resolve([alpha]),
      updateProject: unusedUpdateProject,
    }).request("/api/projects");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body).toEqual({ items: [alphaDto] });
    expect(body.items[0]).not.toHaveProperty("ownerUserId");
    expect(body.items[0]).not.toHaveProperty("createdAt");
  });

  it("returns the actor's Projects newest first", async () => {
    const zulu = {
      ...alpha,
      id: "project_zulu",
      name: "Zulu",
      createdAt: new Date("2026-08-04T00:00:00.000Z"),
    };
    const repository = new InMemoryProjectRepository([alpha, zulu]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      updateProject: unusedUpdateProject,
    }).request("/api/projects");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ ...alphaDto, id: "project_zulu", name: "Zulu" }, alphaDto],
    });
  });

  it("returns an empty Projects list", async () => {
    expect(
      await Promise.resolve(
        createTestApp({
          archiveProject: unusedArchiveProject,
          createProject: unusedCreateProject,
          getProject: createGetProject(new InMemoryProjectRepository([])),
          listProjects: () => Promise.resolve([]),
          updateProject: unusedUpdateProject,
        }).request("/api/projects"),
      ).then((response) => response.json()),
    ).toEqual({ items: [] });
  });

  it("returns a versioned Project detail", async () => {
    const app = createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      listProjects: () => Promise.resolve([alpha]),
      getProject: createGetProject(new InMemoryProjectRepository([alpha])),
      updateProject: unusedUpdateProject,
    });
    const response = await app.request("/api/projects/project_alpha");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "project_alpha",
      name: "Alpha",
      status: "active",
      version: 1,
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("updates a Project and returns a runtime-validated public DTO", async () => {
    const repository = new InMemoryProjectRepository([alpha]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      updateProject: createUpdateProject({
        clock: () => new Date("2026-08-06T01:00:00.000Z"),
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
    }).request("/api/projects/project_alpha", {
      method: "PATCH",
      body: JSON.stringify({ name: " Renamed ", version: 1 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "project_alpha",
      name: "Renamed",
      status: "active",
      version: 2,
      updatedAt: "2026-08-06T01:00:00.000Z",
    });
  });

  it("archives a Project and returns its incremented public DTO", async () => {
    const repository = new InMemoryProjectRepository([
      { ...alpha, version: 2 },
    ]);
    const response = await createTestApp({
      createProject: unusedCreateProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      updateProject: unusedUpdateProject,
      archiveProject: createArchiveProject({
        clock: () => new Date("2026-08-06T02:00:00.000Z"),
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
    }).request("/api/projects/project_alpha/archive", {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...alphaDto,
      status: "archived",
      version: 3,
      updatedAt: "2026-08-06T02:00:00.000Z",
    });
  });

  it("preserves request-ID Problems for repeated, stale, and missing archives", async () => {
    const repository = new InMemoryProjectRepository([
      { ...alpha, version: 2 },
      { ...alpha, id: "project_stale", version: 2 },
    ]);
    const app = createTestApp({
      createProject: unusedCreateProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      updateProject: unusedUpdateProject,
      archiveProject: createArchiveProject({
        clock: () => new Date("2026-08-06T02:00:00.000Z"),
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
    });

    await app.request("/api/projects/project_alpha/archive", {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
      headers: { "Content-Type": "application/json" },
    });
    const repeated = await app.request("/api/projects/project_alpha/archive", {
      method: "POST",
      body: JSON.stringify({ version: 2 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_archive_archived",
      },
    });
    const stale = await app.request("/api/projects/project_stale/archive", {
      method: "POST",
      body: JSON.stringify({ version: 99 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_archive_conflict",
      },
    });
    const missing = await app.request("/api/projects/missing/archive", {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_archive_missing",
      },
    });

    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      code: "PROJECT_ARCHIVED",
      requestId: "request_archive_archived",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "PROJECT_VERSION_CONFLICT",
      requestId: "request_archive_conflict",
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "PROJECT_NOT_FOUND",
      requestId: "request_archive_missing",
    });
    await expect(
      repository.findById({ id: "project_stale", ownerUserId: "user_test" }),
    ).resolves.toEqual({
      ...alpha,
      id: "project_stale",
      version: 2,
    });
  });

  it("returns request-ID-preserving validation Problems for malformed archive JSON", async () => {
    const response = await createTestApp({
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([alpha])),
      listProjects: () => Promise.resolve([alpha]),
      updateProject: unusedUpdateProject,
      archiveProject: createArchiveProject({
        clock: () => new Date("2026-08-06T02:00:00.000Z"),
        unitOfWork: new InMemoryProjectUnitOfWork(
          new InMemoryProjectRepository([alpha]),
        ),
      }),
    }).request("/api/projects/project_alpha/archive", {
      method: "POST",
      body: '{"version":',
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_archive_malformed",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      requestId: "request_archive_malformed",
      fieldErrors: { body: ["Request body must be valid JSON."] },
    });
  });

  it("sanitizes a failing archive use case into a request-ID-preserving 500 Problem", async () => {
    const response = await createTestApp({
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([alpha])),
      listProjects: () => Promise.resolve([alpha]),
      updateProject: unusedUpdateProject,
      archiveProject: async () =>
        Promise.reject(new Error("secret archive repository detail")),
    }).request("/api/projects/project_alpha/archive", {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_archive_500",
      },
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(response.headers.get("x-request-id")).toBe("request_archive_500");
    expect(body).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      requestId: "request_archive_500",
    });
    expect(JSON.stringify(body)).not.toContain(
      "secret archive repository detail",
    );
  });

  it("returns a request-ID-preserving stale-version Problem", async () => {
    const repository = new InMemoryProjectRepository([alpha]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      updateProject: createUpdateProject({
        clock: () => new Date("2026-08-06T01:00:00.000Z"),
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
    }).request("/api/projects/project_alpha", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", version: 99 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_update_conflict",
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: 409,
      code: "PROJECT_VERSION_CONFLICT",
      requestId: "request_update_conflict",
    });
  });

  it("returns a request-ID-preserving archived Project Problem", async () => {
    const repository = new InMemoryProjectRepository([
      { ...alpha, status: "archived" as const },
    ]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      updateProject: createUpdateProject({
        clock: () => new Date("2026-08-06T01:00:00.000Z"),
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
    }).request("/api/projects/project_alpha", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", version: 1 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_update_archived",
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: 409,
      code: "PROJECT_ARCHIVED",
      requestId: "request_update_archived",
    });
  });

  it("returns a request-ID-preserving validation Problem for malformed update JSON", async () => {
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([alpha])),
      listProjects: () => Promise.resolve([alpha]),
      updateProject: unusedUpdateProject,
    }).request("/api/projects/project_alpha", {
      method: "PATCH",
      body: '{"name":',
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_update_malformed",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_update_malformed",
      fieldErrors: { body: ["Request body must be valid JSON."] },
    });
  });

  it("returns a request-ID-preserving field Problem for an invalid update name", async () => {
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([alpha])),
      listProjects: () => Promise.resolve([alpha]),
      updateProject: unusedUpdateProject,
    }).request("/api/projects/project_alpha", {
      method: "PATCH",
      body: JSON.stringify({ name: "   ", version: 1 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_update_invalid",
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_update_invalid",
      fieldErrors: { name: ["Project name is required."] },
    });
  });

  it("returns a request-ID-preserving Project 404 for a missing update target", async () => {
    const repository = new InMemoryProjectRepository([]);
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(repository),
      listProjects: createListProjects(repository),
      updateProject: createUpdateProject({
        clock: () => new Date("2026-08-06T01:00:00.000Z"),
        unitOfWork: new InMemoryProjectUnitOfWork(repository),
      }),
    }).request("/api/projects/missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "Name", version: 1 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_update_missing",
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 404,
      code: "PROJECT_NOT_FOUND",
      requestId: "request_update_missing",
    });
  });

  it("sanitizes a failing update use case into a request-ID-preserving 500 Problem", async () => {
    const response = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([alpha])),
      listProjects: () => Promise.resolve([alpha]),
      updateProject: async () =>
        Promise.reject(new Error("secret update repository detail")),
    }).request("/api/projects/project_alpha", {
      method: "PATCH",
      body: JSON.stringify({ name: "Name", version: 1 }),
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request_update_500",
      },
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(body).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      requestId: "request_update_500",
    });
    expect(JSON.stringify(body)).not.toContain(
      "secret update repository detail",
    );
  });

  it("returns an explicit sanitized Project 404", async () => {
    const app = createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      listProjects: () => Promise.resolve([alpha]),
      getProject: createGetProject(new InMemoryProjectRepository([])),
      updateProject: unusedUpdateProject,
    });
    const response = await app.request("/api/projects/missing", {
      headers: { "X-Request-Id": "request_detail_404" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "PROJECT_NOT_FOUND",
      requestId: "request_detail_404",
    });
  });

  it("returns a sanitized Problem with the Request ID on failures", async () => {
    const failed = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([])),
      listProjects: async () =>
        Promise.reject(new Error("secret database detail")),
      updateProject: unusedUpdateProject,
    }).request("/api/projects", {
      headers: { "X-Request-Id": "request_test_123" },
    });
    const body: unknown = await failed.json();

    expect(failed.status).toBe(500);
    expect(failed.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(failed.headers.get("x-request-id")).toBe("request_test_123");
    expect(body).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      requestId: "request_test_123",
    });
    expect(JSON.stringify(body)).not.toContain("secret database detail");
  });

  // 契約にないコードを外へ出さない安全側の挙動。型テストでドメインのコードは契約に
  // 含まれるので通常は起きないが、登録を忘れたモジュールのエラーはここに落ちる。
  it("an ApplicationError with an unknown code becomes INTERNAL_ERROR", async () => {
    class TaskNotFoundError extends ApplicationError {
      readonly code = "TASK_NOT_FOUND";
    }
    const failed = await createTestApp({
      archiveProject: unusedArchiveProject,
      createProject: unusedCreateProject,
      getProject: createGetProject(new InMemoryProjectRepository([])),
      listProjects: async () =>
        Promise.reject(new TaskNotFoundError("secret task detail")),
      updateProject: unusedUpdateProject,
    }).request("/api/projects", {
      headers: { "X-Request-Id": "request_unknown_code" },
    });
    const body: unknown = await failed.json();

    expect(failed.status).toBe(500);
    expect(failed.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(body).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      requestId: "request_unknown_code",
    });
    expect(JSON.stringify(body)).not.toContain("TASK_NOT_FOUND");
    expect(JSON.stringify(body)).not.toContain("secret task detail");
  });
});

// 2 人の利用者を、cookie の値で actor を切り替える認証で組み立てる。所有者の絞り込みは
// use case と repository の責務なので、ここでは HTTP から見た結果（一覧と 404）を確かめる。
describe("createApp Project ownership", () => {
  const ownerCookie = "session=owner";
  const otherCookie = "session=other";

  const createOwnershipApp = (projects: readonly Project[]) => {
    const repository = new InMemoryProjectRepository(projects);
    const unitOfWork = new InMemoryProjectUnitOfWork(repository);
    const clock = () => new Date("2026-08-06T03:00:00.000Z");
    const actorsBySession = new Map([
      ["owner", "user_owner"],
      ["other", "user_other"],
    ]);
    const app = createTestApp(
      {
        createProject: createCreateProject({
          clock,
          generateId: () => "created",
          unitOfWork,
        }),
        archiveProject: createArchiveProject({ clock, unitOfWork }),
        getProject: createGetProject(repository),
        listProjects: createListProjects(repository),
        updateProject: createUpdateProject({ clock, unitOfWork }),
      },
      {
        authenticateSession: (sessionId) => {
          const userId =
            sessionId === undefined
              ? undefined
              : actorsBySession.get(sessionId);
          return Promise.resolve(
            userId === undefined
              ? undefined
              : {
                  actor: { userId, roles: [] },
                  user: { id: userId, roles: [] },
                },
          );
        },
      },
    );
    return { app, repository };
  };

  const ownedAlpha: Project = { ...alpha, ownerUserId: "user_owner" };

  const writeAs = (
    app: ReturnType<typeof createTestApp>,
    cookie: string,
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
  ) =>
    app.request(path, {
      method,
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Request-Id": "request_ownership",
      },
    });

  it("a created project is owned by the creating user", async () => {
    const { app, repository } = createOwnershipApp([]);

    const created = await writeAs(app, ownerCookie, "/api/projects", "POST", {
      name: "Owned",
    });

    expect(created.status).toBe(201);
    await expect(
      repository.findById({ id: "project_created", ownerUserId: "user_owner" }),
    ).resolves.toMatchObject({ name: "Owned", ownerUserId: "user_owner" });
    await expect(
      repository.findById({ id: "project_created", ownerUserId: "user_other" }),
    ).resolves.toBeUndefined();
  });

  // 所有者は Session の actor だけから決まる。本文に所有者や actor を書いても、検証で
  // 落ちるか、use case に届く前に Session の actor で上書きされる。
  it("ignores an owner or actor in the create body and owns the project by the session actor", async () => {
    const { app, repository } = createOwnershipApp([]);

    const created = await writeAs(app, ownerCookie, "/api/projects", "POST", {
      name: "Owned",
      ownerUserId: "user_other",
      actor: { userId: "user_other", roles: [] },
    });

    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("ownerUserId");
    expect(body).not.toHaveProperty("actor");
    await expect(
      repository.findById({ id: "project_created", ownerUserId: "user_owner" }),
    ).resolves.toMatchObject({ name: "Owned", ownerUserId: "user_owner" });
    await expect(
      repository.list({ ownerUserId: "user_other" }),
    ).resolves.toEqual([]);
  });

  it("ignores an owner or actor in the rename body", async () => {
    const { app, repository } = createOwnershipApp([ownedAlpha]);

    const renamed = await writeAs(
      app,
      ownerCookie,
      "/api/projects/project_alpha",
      "PATCH",
      {
        name: "Renamed",
        version: 1,
        ownerUserId: "user_other",
        actor: { userId: "user_other", roles: [] },
      },
    );
    const hijack = await writeAs(
      app,
      otherCookie,
      "/api/projects/project_alpha",
      "PATCH",
      {
        name: "Hijacked",
        version: 2,
        ownerUserId: "user_owner",
        actor: { userId: "user_owner", roles: [] },
      },
    );

    expect(renamed.status).toBe(200);
    expect(hijack.status).toBe(404);
    await expect(
      repository.findById({ id: "project_alpha", ownerUserId: "user_owner" }),
    ).resolves.toMatchObject({
      name: "Renamed",
      version: 2,
      ownerUserId: "user_owner",
    });
    await expect(
      repository.list({ ownerUserId: "user_other" }),
    ).resolves.toEqual([]);
  });

  it("the owner can list and read their own project", async () => {
    const { app } = createOwnershipApp([ownedAlpha]);

    const list = await app.request("/api/projects", {
      headers: { Cookie: ownerCookie },
    });
    const detail = await app.request("/api/projects/project_alpha", {
      headers: { Cookie: ownerCookie },
    });

    expect(await list.json()).toEqual({ items: [alphaDto] });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(alphaDto);
  });

  it("another user's project is not listed", async () => {
    const { app } = createOwnershipApp([ownedAlpha]);

    const list = await app.request("/api/projects", {
      headers: { Cookie: otherCookie },
    });

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [] });
  });

  it("reading another user's project returns PROJECT_NOT_FOUND", async () => {
    const { app } = createOwnershipApp([ownedAlpha]);

    const detail = await app.request("/api/projects/project_alpha", {
      headers: { Cookie: otherCookie, "X-Request-Id": "request_ownership" },
    });
    const missing = await app.request("/api/projects/project_missing", {
      headers: { Cookie: otherCookie, "X-Request-Id": "request_ownership" },
    });

    expect(detail.status).toBe(404);
    // 他人の Project と存在しない Project を、応答から区別できないこと。instance は
    // 要求したパスそのものなので除いて比べる。
    const withoutInstance = async (response: Response) => {
      const { instance, ...rest } = (await response.json()) as {
        instance: string;
      };
      void instance;
      return rest;
    };
    expect(await withoutInstance(detail)).toEqual(
      await withoutInstance(missing),
    );
    expect(missing.status).toBe(404);
  });

  it("renaming another user's project returns PROJECT_NOT_FOUND and leaves it unchanged", async () => {
    const { app, repository } = createOwnershipApp([ownedAlpha]);

    const response = await writeAs(
      app,
      otherCookie,
      "/api/projects/project_alpha",
      "PATCH",
      { name: "Hijacked", version: 1 },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(
      repository.findById({ id: "project_alpha", ownerUserId: "user_owner" }),
    ).resolves.toEqual(ownedAlpha);
  });

  it("archiving another user's project returns PROJECT_NOT_FOUND even when it is archived", async () => {
    const archived: Project = { ...ownedAlpha, status: "archived" };
    const { app } = createOwnershipApp([archived]);

    const response = await writeAs(
      app,
      otherCookie,
      "/api/projects/project_alpha/archive",
      "POST",
      { version: 1 },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("archiving another user's project returns PROJECT_NOT_FOUND even with a stale version", async () => {
    const { app, repository } = createOwnershipApp([ownedAlpha]);

    const response = await writeAs(
      app,
      otherCookie,
      "/api/projects/project_alpha/archive",
      "POST",
      { version: 99 },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(
      repository.findById({ id: "project_alpha", ownerUserId: "user_owner" }),
    ).resolves.toEqual(ownedAlpha);
  });
});

describe("createApp HTTP safety", () => {
  it("returns a NOT_FOUND Problem for an unknown path under /api for an authenticated user", async () => {
    const app = createTestApp(unusedProjectDependencies());

    const unknownPath = await app.request("/api/unknown", {
      headers: { "X-Request-Id": "request_unknown_path" },
    });
    // Hono はメソッド違いにも 405 ではなく 404 を返すので、同じ Problem になることを確かめる。
    const methodMismatch = await app.request("/api/projects", {
      method: "DELETE",
      headers: { "X-Request-Id": "request_method_mismatch" },
    });

    expect(unknownPath.status).toBe(404);
    expect(unknownPath.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(unknownPath.headers.get("x-request-id")).toBe(
      "request_unknown_path",
    );
    expect(await unknownPath.json()).toEqual({
      type: "https://starter.local/problems/not-found",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
      requestId: "request_unknown_path",
      instance: "/api/unknown",
    });
    expect(methodMismatch.status).toBe(404);
    expect(await methodMismatch.json()).toMatchObject({
      code: "NOT_FOUND",
      requestId: "request_method_mismatch",
    });
  });

  it("keeps an unknown path under /api behind authentication", async () => {
    const response = await createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
    }).request("/api/unknown");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a body larger than the limit with a PAYLOAD_TOO_LARGE Problem before validation", async () => {
    let createCalls = 0;
    const app = createTestApp({
      ...unusedProjectDependencies(),
      createProject: async (input) => {
        createCalls += 1;
        return unusedCreateProject(input);
      },
    });
    const limit = 100 * 1024;
    // JSON として壊れた本文にして、検証より先に上限で止まったことを status で見分ける。
    const oversized = `{"name":"${"a".repeat(limit)}`;

    const withLength = await app.request("/api/projects", {
      method: "POST",
      body: oversized,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(oversized.length),
        "X-Request-Id": "request_too_large",
      },
    });
    // Content-Length のない本文は、上限まで読んだところで打ち切る経路を通る。
    const streamed = await app.request("/api/projects", {
      method: "POST",
      body: new Blob([oversized]).stream(),
      duplex: "half",
      headers: { "Content-Type": "application/json" },
    } as RequestInit);
    const atLimit = await app.request("/api/projects", {
      method: "POST",
      body: "x".repeat(limit),
      headers: { "Content-Type": "application/json" },
    });

    expect(withLength.status).toBe(413);
    expect(withLength.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await withLength.json()).toEqual({
      type: "https://starter.local/problems/payload-too-large",
      title: "Payload Too Large",
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      requestId: "request_too_large",
      instance: "/api/projects",
    });
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(atLimit.status).toBe(400);
    expect(createCalls).toBe(0);
  });

  // 認証の DB 参照より前に止めるので、未認証の大きな本文もメモリと DB を使わせない。
  it("rejects an oversized body before authentication", async () => {
    const response = await createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
    }).request("/api/projects", {
      method: "POST",
      body: "x".repeat(100 * 1024 + 1),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(100 * 1024 + 1),
      },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("createApp request observation", () => {
  const observed = () => {
    const outcomes: RequestOutcome[] = [];
    const observeRequest: ObserveRequest = (outcome) => {
      outcomes.push(outcome);
    };
    return { outcomes, observeRequest };
  };

  it("reports an unexpected use case failure to observeRequest with the handler route and status 500", async () => {
    const failure = new Error("secret database detail");
    const { outcomes, observeRequest } = observed();

    const response = await createTestApp(
      {
        ...unusedProjectDependencies(),
        listProjects: () => Promise.reject(failure),
      },
      { observeRequest },
    ).request("/api/projects", {
      headers: { "X-Request-Id": "request_observed_500" },
    });

    expect(response.status).toBe(500);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      requestId: "request_observed_500",
      method: "GET",
      route: "/api/projects",
      status: 500,
      unexpectedError: failure,
    });
    expect(outcomes[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  // routePath は最後に dispatch した middleware の pattern（/api/*）を返すので、
  // 一番記録したい「認証の途中で DB が落ちた」場面でエンドポイントが分からなくなる。
  it("reports the handler route, not the middleware pattern, when authentication fails with a 500", async () => {
    const failure = new Error("connect ECONNREFUSED 10.0.0.1:5432");
    const { outcomes, observeRequest } = observed();

    const response = await createTestApp(unusedProjectDependencies(), {
      authenticateSession: () => Promise.reject(failure),
      observeRequest,
    }).request("/api/projects/project_alpha");

    expect(response.status).toBe(500);
    expect(outcomes).toEqual([
      expect.objectContaining({
        route: "/api/projects/:projectId",
        status: 500,
        unexpectedError: failure,
      }),
    ]);
  });

  it("reports an empty route for an unknown path and a method mismatch", async () => {
    const { outcomes, observeRequest } = observed();
    const app = createTestApp(unusedProjectDependencies(), { observeRequest });

    await app.request("/api/unknown");
    await app.request("/api/projects", { method: "DELETE" });

    expect(outcomes.map(({ route, status }) => ({ route, status }))).toEqual([
      { route: "", status: 404 },
      { route: "", status: 404 },
    ]);
    expect(outcomes.some((outcome) => "unexpectedError" in outcome)).toBe(
      false,
    );
  });

  // どのエンドポイントに大きな本文が来たかが分かるよう、上限で止めてもハンドラの route を残す。
  it("reports the handler route for a body that exceeds the limit on an existing route", async () => {
    const { outcomes, observeRequest } = observed();

    await createTestApp(unusedProjectDependencies(), {
      observeRequest,
    }).request("/api/projects", {
      method: "POST",
      body: "x".repeat(100 * 1024 + 1),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(100 * 1024 + 1),
      },
    });

    expect(outcomes).toEqual([
      expect.objectContaining({
        method: "POST",
        route: "/api/projects",
        status: 413,
      }),
    ]);
    expect("unexpectedError" in outcomes[0]!).toBe(false);
  });

  it("reports a 401 without an unexpected error", async () => {
    const { outcomes, observeRequest } = observed();

    await createTestApp(unusedProjectDependencies(), {
      authenticateByDefault: false,
      observeRequest,
    }).request("/api/me");

    expect(outcomes).toEqual([
      expect.objectContaining({ route: "/api/me", status: 401 }),
    ]);
    expect("unexpectedError" in outcomes[0]!).toBe(false);
  });

  it("does not report a handled domain error such as PROJECT_NOT_FOUND as unexpected", async () => {
    const { outcomes, observeRequest } = observed();

    const response = await createTestApp(unusedProjectDependencies(), {
      observeRequest,
    }).request("/api/projects/project_missing");

    expect(response.status).toBe(404);
    expect(outcomes).toEqual([
      expect.objectContaining({
        route: "/api/projects/:projectId",
        status: 404,
      }),
    ]);
    expect("unexpectedError" in outcomes[0]!).toBe(false);
  });

  // Error でない値は compose が onError に渡さず再送出するので、context.error も
  // context.res も 500 にならない。最終的な 500 はサーバ（@hono/node-server）が返す。
  it("notifies observeRequest with status 500 and the thrown value when a handler throws a non-Error value", async () => {
    const thrown = { reason: "not an Error" };
    const { outcomes, observeRequest } = observed();

    await expect(
      createTestApp(
        {
          ...unusedProjectDependencies(),
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          listProjects: () => Promise.reject(thrown),
        },
        { observeRequest },
      ).request("/api/projects"),
    ).rejects.toBe(thrown);
    expect(outcomes).toEqual([
      expect.objectContaining({
        route: "/api/projects",
        status: 500,
        unexpectedError: thrown,
      }),
    ]);
  });

  it("keeps the 500 Problem response when observeRequest throws", async () => {
    const response = await createTestApp(
      {
        ...unusedProjectDependencies(),
        listProjects: () => Promise.reject(new Error("use case failed")),
      },
      {
        observeRequest: () => {
          throw new Error("observer failed");
        },
      },
    ).request("/api/projects", {
      headers: { "X-Request-Id": "request_observer_failed" },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe(
      "request_observer_failed",
    );
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      requestId: "request_observer_failed",
    });
  });
});
