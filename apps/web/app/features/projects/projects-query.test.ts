import { QueryClient } from "@tanstack/react-query";
import type { ListProjectsResponse, ProjectDto } from "@starter/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  prependProjectToList,
  projectsDetailKey,
  projectsDetailQueryOptions,
  projectsListKey,
  projectsListQueryOptions,
  replaceProjectInList,
  storeProject,
} from "./projects-query.js";

describe("projectsListQueryOptions", () => {
  it("uses one stable key and forwards AbortSignal", async () => {
    const listProjects = vi
      .fn<(options?: { signal?: AbortSignal }) => Promise<{ items: never[] }>>()
      .mockResolvedValue({ items: [] });
    const options = projectsListQueryOptions(listProjects);
    const client = new QueryClient();

    await client.ensureQueryData(options);

    expect(options.queryKey).toEqual(["projects", "list"]);
    expect(listProjects.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("projectsDetailQueryOptions", () => {
  it("uses an ID-scoped key and forwards AbortSignal", async () => {
    const getProject = vi
      .fn<
        (
          projectId: string,
          options?: { signal?: AbortSignal },
        ) => Promise<{
          id: string;
          name: string;
          status: "active";
          version: number;
          updatedAt: string;
        }>
      >()
      .mockResolvedValue({
        id: "project_alpha",
        name: "Alpha",
        status: "active",
        version: 1,
        updatedAt: "2026-08-03T00:00:00.000Z",
      });
    const options = projectsDetailQueryOptions("project_alpha", getProject);
    const client = new QueryClient();

    expect(options.queryKey).toEqual(["projects", "detail", "project_alpha"]);
    await client.ensureQueryData(options);

    const abortSignalMatcher: unknown = expect.any(AbortSignal);
    expect(getProject).toHaveBeenCalledWith("project_alpha", {
      signal: abortSignalMatcher,
    });
  });
});

const listed = (id: string, name: string): ProjectDto => ({
  id,
  name,
  status: "active",
  version: 1,
  updatedAt: "2026-08-03T00:00:00.000Z",
});

// 一覧の並びはサーバが created_at の新しい順で決める。id 順とわざとずらした一覧で、
// クライアントが並べ替えていないことを確かめる。
const serverOrdered = [
  listed("project_zulu", "Zulu"),
  listed("project_alpha", "Alpha"),
  listed("project_mike", "Mike"),
];

describe("prependProjectToList", () => {
  it("prepends a created project to the cached list without reordering the rest", () => {
    const created = listed("project_created", "Created");

    expect(prependProjectToList({ items: serverOrdered }, created)).toEqual({
      items: [created, ...serverOrdered],
    });
  });

  it("does not duplicate a project that is already listed", () => {
    const created = { ...listed("project_alpha", "Alpha"), version: 2 };

    expect(prependProjectToList({ items: serverOrdered }, created)).toEqual({
      items: [
        created,
        listed("project_zulu", "Zulu"),
        listed("project_mike", "Mike"),
      ],
    });
  });

  it("leaves an absent list cache absent instead of inventing a partial list", () => {
    expect(
      prependProjectToList(undefined, listed("project_created", "Created")),
    ).toBeUndefined();
  });
});

describe("replaceProjectInList", () => {
  it("replaces an updated project in place and leaves the list unchanged when it is absent", () => {
    const renamed = { ...listed("project_alpha", "Renamed"), version: 2 };

    expect(replaceProjectInList({ items: serverOrdered }, renamed)).toEqual({
      items: [
        listed("project_zulu", "Zulu"),
        renamed,
        listed("project_mike", "Mike"),
      ],
    });
    expect(
      replaceProjectInList(
        { items: serverOrdered },
        listed("project_unlisted", "Unlisted"),
      ),
    ).toEqual({ items: serverOrdered });
  });

  it("leaves an absent list cache absent", () => {
    expect(
      replaceProjectInList(undefined, listed("project_alpha", "Alpha")),
    ).toBeUndefined();
  });
});

describe("storeProject", () => {
  it("replaces the confirmed detail and keeps the list order", async () => {
    const client = new QueryClient();
    client.setQueryData(
      projectsDetailKey("project_alpha"),
      listed("project_alpha", "Alpha"),
    );
    client.setQueryData(projectsListKey, { items: serverOrdered });

    const updated = {
      ...listed("project_alpha", "Server Confirmed"),
      version: 2,
      updatedAt: "2026-08-06T01:00:00.000Z",
    };
    await storeProject(client, updated, "replace");

    expect(client.getQueryData(projectsDetailKey("project_alpha"))).toEqual(
      updated,
    );
    expect(client.getQueryData(projectsListKey)).toEqual({
      items: [
        listed("project_zulu", "Zulu"),
        updated,
        listed("project_mike", "Mike"),
      ],
    });
  });

  it("stores a created project at the head of the list", async () => {
    const client = new QueryClient();
    client.setQueryData(projectsListKey, { items: serverOrdered });
    const created = listed("project_created", "Created");

    await storeProject(client, created, "prepend");

    expect(client.getQueryData(projectsDetailKey(created.id))).toEqual(created);
    expect(client.getQueryData(projectsListKey)).toEqual({
      items: [created, ...serverOrdered],
    });
  });

  it("stores detail without inventing a partial list when the list is absent", async () => {
    const client = new QueryClient();
    const confirmed = {
      id: "project_alpha",
      name: "Confirmed",
      status: "active" as const,
      version: 2,
      updatedAt: "2026-08-06T01:00:00.000Z",
    };

    await storeProject(client, confirmed, "replace");

    expect(client.getQueryData(projectsDetailKey(confirmed.id))).toEqual(
      confirmed,
    );
    expect(client.getQueryData(projectsListKey)).toBeUndefined();
  });

  it("cancels older detail and list requests before storing confirmed state", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const oldProject: ProjectDto = {
      id: "project_alpha",
      name: "Old",
      status: "active",
      version: 1,
      updatedAt: "2026-08-03T00:00:00.000Z",
    };
    const confirmed: ProjectDto = {
      ...oldProject,
      name: "Confirmed",
      version: 2,
      updatedAt: "2026-08-06T01:00:00.000Z",
    };
    const otherProject: ProjectDto = {
      ...oldProject,
      id: "project_zulu",
      name: "Zulu",
    };
    client.setQueryData(projectsDetailKey(oldProject.id), oldProject);
    client.setQueryData<ListProjectsResponse>(projectsListKey, {
      items: [oldProject, otherProject],
    });

    let detailSignal: AbortSignal | undefined;
    let listSignal: AbortSignal | undefined;
    let releaseDetail: (() => void) | undefined;
    let releaseList: (() => void) | undefined;
    let markDetailStarted: (() => void) | undefined;
    let markListStarted: (() => void) | undefined;
    const detailStarted = new Promise<void>((resolve) => {
      markDetailStarted = resolve;
    });
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const oldDetailRequest = client
      .fetchQuery({
        queryKey: projectsDetailKey(oldProject.id),
        queryFn: ({ signal }) =>
          new Promise<ProjectDto>((resolve, reject) => {
            detailSignal = signal;
            markDetailStarted?.();
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
            releaseDetail = () => resolve(oldProject);
          }),
      })
      .catch(() => undefined);
    const oldListRequest = client
      .fetchQuery({
        queryKey: projectsListKey,
        queryFn: ({ signal }) =>
          new Promise<ListProjectsResponse>((resolve, reject) => {
            listSignal = signal;
            markListStarted?.();
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
            releaseList = () => resolve({ items: [oldProject, otherProject] });
          }),
      })
      .catch(() => undefined);
    await Promise.all([detailStarted, listStarted]);

    await storeProject(client, confirmed, "replace");
    releaseDetail?.();
    releaseList?.();
    await Promise.all([oldDetailRequest, oldListRequest]);

    expect(detailSignal?.aborted).toBe(true);
    expect(listSignal?.aborted).toBe(true);
    expect(client.getQueryData(projectsDetailKey(oldProject.id))).toEqual(
      confirmed,
    );
    expect(client.getQueryData(projectsListKey)).toEqual({
      items: [confirmed, otherProject],
    });
  });
});
