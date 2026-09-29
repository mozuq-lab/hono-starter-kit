import { ApiError } from "@starter/api-client";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  submitProjectArchive,
  submitProjectCreate,
  submitProjectUpdate,
} from "./project-mutations.js";
import { projectsDetailKey, projectsListKey } from "./projects-query.js";

const { archiveProject, createProject, getProject, updateProject } = vi.hoisted(
  () => ({
    archiveProject: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    updateProject: vi.fn(),
  }),
);

vi.mock("../../lib/api-client.js", () => ({
  projectsClient: { archiveProject, createProject, getProject, updateProject },
}));

const project = {
  id: "project_alpha",
  name: "Alpha",
  status: "active" as const,
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const serverConfirmed = {
  ...project,
  name: "Server Confirmed",
  status: "archived" as const,
  version: 2,
  updatedAt: "2026-08-06T01:00:00.000Z",
};

const problem = (code: string, status: number) =>
  new ApiError({
    type: `https://starter.local/problems/${code.toLowerCase()}`,
    title: code,
    status,
    code,
    requestId: `request_${code.toLowerCase()}`,
  });

const requestUrl = "https://app.example.test/projects/project_alpha";

let client: QueryClient;

const context = () => ({ client, requestUrl });

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(projectsDetailKey(project.id), project);
  client.setQueryData(projectsListKey, { items: [project] });
});

describe("submitProjectUpdate", () => {
  it("stores the server-confirmed Project on success", async () => {
    const updated = { ...project, name: "Renamed", version: 2 };
    updateProject.mockResolvedValue(updated);

    await expect(
      submitProjectUpdate(context(), project.id, {
        name: "Renamed",
        version: 1,
      }),
    ).resolves.toEqual({ confirmed: updated });
    expect(client.getQueryData(projectsDetailKey(project.id))).toEqual(updated);
  });

  it("replaces the updated Project in place in the cached list", async () => {
    const other = { ...project, id: "project_other", name: "Other" };
    client.setQueryData(projectsListKey, { items: [other, project] });
    const updated = { ...project, name: "Renamed", version: 2 };
    updateProject.mockResolvedValue(updated);

    await submitProjectUpdate(context(), project.id, {
      name: "Renamed",
      version: 1,
    });

    expect(client.getQueryData(projectsListKey)).toEqual({
      items: [other, updated],
    });
  });

  it("rejects a blank name with field errors instead of a forged Problem", async () => {
    await expect(
      submitProjectUpdate(context(), project.id, { name: "   ", version: 1 }),
    ).resolves.toEqual({
      rejected: { fieldErrors: { name: ["Project name is required."] } },
    });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it.each([["PROJECT_VERSION_CONFLICT"], ["PROJECT_ARCHIVED"]])(
    "refetches the server Project after %s so the cache stops contradicting the Problem",
    async (code) => {
      const conflict = problem(code, 409);
      updateProject.mockRejectedValue(conflict);
      getProject.mockResolvedValue(serverConfirmed);

      await expect(
        submitProjectUpdate(context(), project.id, {
          name: "Renamed",
          version: 1,
        }),
      ).resolves.toEqual({ rejected: { problem: conflict.problem } });
      expect(getProject).toHaveBeenCalledWith(project.id);
      expect(client.getQueryData(projectsDetailKey(project.id))).toEqual(
        serverConfirmed,
      );
      expect(client.getQueryData(projectsListKey)).toEqual({
        items: [serverConfirmed],
      });
    },
  );

  it("keeps the cache untouched for a server validation Problem", async () => {
    const validation = new ApiError({
      type: "https://starter.local/problems/validation-error",
      title: "Validation Error",
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_validation",
      fieldErrors: { name: ["Project name is required."] },
    });
    updateProject.mockRejectedValue(validation);

    await expect(
      submitProjectUpdate(context(), project.id, {
        name: "Renamed",
        version: 1,
      }),
    ).resolves.toEqual({
      rejected: {
        fieldErrors: { name: ["Project name is required."] },
        problem: validation.problem,
      },
    });
    expect(getProject).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected Problem for the route error boundary", async () => {
    const internal = problem("INTERNAL_ERROR", 500);
    updateProject.mockRejectedValue(internal);

    await expect(
      submitProjectUpdate(context(), project.id, {
        name: "Renamed",
        version: 1,
      }),
    ).rejects.toBe(internal);
  });

  it("redirects an expired session to login with the current path", async () => {
    updateProject.mockRejectedValue(problem("UNAUTHENTICATED", 401));

    const result = await submitProjectUpdate(context(), project.id, {
      name: "Renamed",
      version: 1,
    }).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe(
      "/login?returnTo=%2Fprojects%2Fproject_alpha",
    );
  });
});

describe("submitProjectArchive", () => {
  it("stores the archived Project on success", async () => {
    archiveProject.mockResolvedValue(serverConfirmed);

    await expect(
      submitProjectArchive(context(), project.id, { version: 1 }),
    ).resolves.toEqual({ confirmed: serverConfirmed });
    expect(client.getQueryData(projectsDetailKey(project.id))).toEqual(
      serverConfirmed,
    );
  });

  it("replaces the archived Project in place in the cached list", async () => {
    const other = { ...project, id: "project_other", name: "Other" };
    client.setQueryData(projectsListKey, { items: [other, project] });
    archiveProject.mockResolvedValue(serverConfirmed);

    await submitProjectArchive(context(), project.id, { version: 1 });

    expect(client.getQueryData(projectsListKey)).toEqual({
      items: [other, serverConfirmed],
    });
  });

  it("rejects a non-numeric version before calling the API", async () => {
    await expect(
      submitProjectArchive(context(), project.id, { version: Number("x") }),
    ).resolves.toEqual({
      rejected: {
        fieldErrors: {
          version: ["Invalid input: expected number, received NaN"],
        },
      },
    });
    expect(archiveProject).not.toHaveBeenCalled();
  });

  it.each([["PROJECT_VERSION_CONFLICT"], ["PROJECT_ARCHIVED"]])(
    "refetches the server Project after %s",
    async (code) => {
      const conflict = problem(code, 409);
      archiveProject.mockRejectedValue(conflict);
      getProject.mockResolvedValue(serverConfirmed);

      await expect(
        submitProjectArchive(context(), project.id, { version: 1 }),
      ).resolves.toEqual({ rejected: { problem: conflict.problem } });
      expect(client.getQueryData(projectsDetailKey(project.id))).toEqual(
        serverConfirmed,
      );
    },
  );

  it("replaces the refetched Project in place instead of moving it to the head", async () => {
    const newer = { ...project, id: "project_zulu", name: "Newer" };
    client.setQueryData(projectsListKey, { items: [newer, project] });
    archiveProject.mockRejectedValue(problem("PROJECT_VERSION_CONFLICT", 409));
    getProject.mockResolvedValue(serverConfirmed);

    await submitProjectArchive(context(), project.id, { version: 1 });

    expect(client.getQueryData(projectsListKey)).toEqual({
      items: [newer, serverConfirmed],
    });
  });
});

describe("submitProjectCreate", () => {
  it("prepends a created Project to the cached list", async () => {
    const created = { ...project, id: "project_created", name: "Created" };
    const older = { ...project, id: "project_zulu", name: "Zulu" };
    client.setQueryData(projectsListKey, { items: [older, project] });
    createProject.mockResolvedValue(created);

    await submitProjectCreate(context(), { name: "Created" });

    expect(client.getQueryData(projectsListKey)).toEqual({
      items: [created, older, project],
    });
  });

  it("stores a created Project without inventing a list entry", async () => {
    const created = { ...project, id: "project_created", name: "Created" };
    createProject.mockResolvedValue(created);
    const fresh = new QueryClient();

    await expect(
      submitProjectCreate({ client: fresh, requestUrl }, { name: "Created" }),
    ).resolves.toEqual({ confirmed: created });
    expect(fresh.getQueryData(projectsDetailKey(created.id))).toEqual(created);
    expect(fresh.getQueryData(projectsListKey)).toBeUndefined();
  });

  it("clears the injected client, not a module singleton, when the session expires", async () => {
    const fresh = new QueryClient();
    fresh.setQueryData(projectsDetailKey(project.id), project);
    createProject.mockRejectedValue(
      new ApiError({
        type: "https://starter.local/problems/unauthenticated",
        title: "Unauthenticated",
        status: 401,
        code: "UNAUTHENTICATED",
        requestId: "request_create_unauthenticated",
      }),
    );

    await expect(
      submitProjectCreate({ client: fresh, requestUrl }, { name: "Created" }),
    ).rejects.toBeInstanceOf(Response);
    expect(fresh.getQueryCache().getAll()).toHaveLength(0);
  });

  it("rejects a blank name before calling the API", async () => {
    await expect(
      submitProjectCreate(context(), { name: "   " }),
    ).resolves.toEqual({
      rejected: { fieldErrors: { name: ["Project name is required."] } },
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("returns the server validation Problem alongside its field errors", async () => {
    const validation = new ApiError({
      type: "https://starter.local/problems/validation-error",
      title: "Validation Error",
      status: 400,
      code: "VALIDATION_ERROR",
      requestId: "request_create_invalid",
      fieldErrors: { name: ["Project name is required."] },
    });
    createProject.mockRejectedValue(validation);

    await expect(
      submitProjectCreate(context(), { name: "Created" }),
    ).resolves.toEqual({
      rejected: {
        fieldErrors: { name: ["Project name is required."] },
        problem: validation.problem,
      },
    });
  });

  it("redirects an expired session to login", async () => {
    createProject.mockRejectedValue(problem("UNAUTHENTICATED", 401));

    const result = await submitProjectCreate(
      { client, requestUrl: "https://app.example.test/projects/new" },
      { name: "Created" },
    ).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/login?returnTo=%2Fprojects%2Fnew",
    );
  });
});
