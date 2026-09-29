import { describe, expect, it } from "vitest";
import { ApiError, UnexpectedApiResponseError } from "./errors.js";
import { createProjectsClient } from "./projects.js";

const project = {
  id: "project_alpha",
  name: "Alpha",
  status: "active" as const,
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("createProjectsClient", () => {
  it("posts a Project creation request and validates the returned DTO", async () => {
    let seenRequest: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = (_input, init) => {
      seenRequest = init;
      return Promise.resolve(jsonResponse(project, 201));
    };
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(client.createProject({ name: "Created" })).resolves.toEqual(
      project,
    );
    expect(seenRequest).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "Created" }),
    });
  });

  it("sends same-origin credentials on project requests", async () => {
    let seenRequest: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = (_input, init) => {
      seenRequest = init;
      return Promise.resolve(jsonResponse(project, 201));
    };
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await client.createProject({ name: "Created" });

    expect(seenRequest).toMatchObject({ credentials: "same-origin" });
  });

  it("patches a Project update request and validates the returned DTO", async () => {
    let seenRequest: RequestInit | undefined;
    let requestedUrl: string | undefined;
    let requestBody: Promise<string> | undefined;
    let requestMethod: string | undefined;
    let requestContentType: string | null | undefined;
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      requestBody = input instanceof Request ? input.clone().text() : undefined;
      requestMethod = input instanceof Request ? input.method : init?.method;
      requestContentType =
        input instanceof Request
          ? input.headers.get("Content-Type")
          : new Headers(init?.headers).get("Content-Type");
      seenRequest = init;
      return Promise.resolve(
        jsonResponse({ ...project, name: "Renamed", version: 2 }),
      );
    };
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(
      client.updateProject("project_alpha", { name: "Renamed", version: 1 }),
    ).resolves.toEqual({ ...project, name: "Renamed", version: 2 });
    expect(requestedUrl).toBe(
      "https://api.example.test/api/projects/project_alpha",
    );
    expect(requestMethod).toBe("PATCH");
    // 本文の型付けは hc に任せている。サーバは JSON の Content-Type が無い要求の本文を
    // 読まないので、これが落ちると更新は実行時に 400 になる。
    expect(requestContentType).toContain("application/json");
    const body = requestBody ?? seenRequest?.body;
    expect(typeof body).toBe("string");
    expect(body).toBe(JSON.stringify({ name: "Renamed", version: 1 }));
  });

  it("posts a versioned archive request and validates the returned DTO", async () => {
    let requestedUrl: string | undefined;
    let requestBody: Promise<string> | undefined;
    let requestMethod: string | undefined;
    let requestContentType: string | null | undefined;
    let seenRequest: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      requestBody = input instanceof Request ? input.clone().text() : undefined;
      requestMethod = input instanceof Request ? input.method : init?.method;
      requestContentType =
        input instanceof Request
          ? input.headers.get("Content-Type")
          : new Headers(init?.headers).get("Content-Type");
      seenRequest = init;
      return Promise.resolve(
        jsonResponse({ ...project, status: "archived", version: 2 }),
      );
    };
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(
      client.archiveProject("project_alpha", { version: 1 }),
    ).resolves.toEqual({ ...project, status: "archived", version: 2 });
    expect(requestedUrl).toBe(
      "https://api.example.test/api/projects/project_alpha/archive",
    );
    expect(requestMethod).toBe("POST");
    // 更新と同じ理由で、アーカイブも hc が付ける Content-Type に依存している。
    expect(requestContentType).toContain("application/json");
    const body = requestBody ?? seenRequest?.body;
    expect(typeof body).toBe("string");
    expect(body).toBe(JSON.stringify({ version: 1 }));
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [404, "PROJECT_NOT_FOUND"],
    [409, "PROJECT_ARCHIVED"],
    [409, "PROJECT_VERSION_CONFLICT"],
    [500, "INTERNAL_ERROR"],
  ])("normalizes an archive %i Problem", async (status, code) => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(
        jsonResponse(
          {
            type: "about:blank",
            title: "Problem",
            status,
            code,
            requestId: "request_archive_problem",
          },
          status,
        ),
      );
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(
      client.archiveProject("project_alpha", { version: 1 }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status,
      code,
      requestId: "request_archive_problem",
    });
  });

  it.each([
    [400, "VALIDATION_ERROR"],
    [404, "PROJECT_NOT_FOUND"],
    [409, "PROJECT_VERSION_CONFLICT"],
    [500, "INTERNAL_ERROR"],
  ])("normalizes an update %i Problem", async (status, code) => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(
        jsonResponse(
          {
            type: "about:blank",
            title: "Problem",
            status,
            code,
            requestId: "request_update_problem",
          },
          status,
        ),
      );
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(
      client.updateProject("project_alpha", { name: "Renamed", version: 1 }),
    ).rejects.toMatchObject({ name: "ApiError", status, code });
  });

  it("returns a runtime-validated Projects response", async () => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(jsonResponse({ items: [project] }));
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(client.listProjects()).resolves.toEqual({ items: [project] });
  });

  it("normalizes a valid non-success Problem", async () => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(
        jsonResponse(
          {
            type: "about:blank",
            title: "Internal Server Error",
            status: 500,
            code: "INTERNAL_ERROR",
            requestId: "request_test_123",
          },
          500,
        ),
      );
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(client.listProjects()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });

  it("gets a validated Project detail and forwards its AbortSignal", async () => {
    let requestedUrl: string | undefined;
    let seenSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      requestedUrl =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      seenSignal = init?.signal;
      return Promise.resolve(jsonResponse(project));
    };
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });
    const controller = new AbortController();

    await expect(
      client.getProject("project_alpha", { signal: controller.signal }),
    ).resolves.toEqual(project);

    expect(requestedUrl).toBe(
      "https://api.example.test/api/projects/project_alpha",
    );
    expect(seenSignal).toBe(controller.signal);
  });

  it("normalizes a Project 404 Problem to ApiError", async () => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(
        jsonResponse(
          {
            type: "about:blank",
            title: "Project not found",
            status: 404,
            code: "PROJECT_NOT_FOUND",
            requestId: "request_detail_404",
          },
          404,
        ),
      );
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(client.getProject("project_alpha")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("rejects a success body that does not match the contract", async () => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(jsonResponse({ items: [{ id: 1 }] }));
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });

    await expect(client.listProjects()).rejects.toBeInstanceOf(
      UnexpectedApiResponseError,
    );
  });

  it("forwards the AbortSignal to fetch", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof globalThis.fetch = (_input, init) => {
      seenSignal = init?.signal;
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = createProjectsClient({
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });
    const controller = new AbortController();

    await client.listProjects({ signal: controller.signal });

    expect(seenSignal).toBe(controller.signal);
  });
});
