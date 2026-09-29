import { expect, test, type Page, type Route } from "@playwright/test";
import { startApi, type ApiProcess } from "./api-process.js";

test.describe.configure({ mode: "serial" });

const login = async (page: Page, returnTo = "/projects") => {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(
    (url) => `${url.pathname}${url.search}` === returnTo,
  );
};

const createProjectThroughUi = async (
  page: Page,
  name: string,
): Promise<string> => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "Create Project" }).click();
  await expect(page).toHaveURL(/\/projects\/new$/u);
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page).toHaveURL(/\/projects\/project_[0-9a-f-]+$/u);
  return page.url().split("/").at(-1) as string;
};

test("shows loading while the real Projects request is pending", async ({
  page,
}) => {
  let api: ApiProcess | undefined;
  let releaseRequest: (() => void) | undefined;
  let navigation: ReturnType<typeof page.goto> | undefined;
  const requestRelease = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });

  try {
    api = await startApi("success");
    await login(page);
    await page.route("**/api/projects", async (route) => {
      await requestRelease;
      await route.continue();
    });

    const requestObserved = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/projects",
    );
    navigation = page.goto("/projects");
    await requestObserved;

    const loading = page.getByText("読み込んでいます。", {
      exact: true,
    });
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute("aria-busy", "true");

    releaseRequest?.();
    await navigation;
    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  } finally {
    releaseRequest?.();
    await navigation?.catch(() => undefined);
    await api?.stop();
  }
});

test("shows deterministic Projects from the real API", async ({ page }) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("success");
    await login(page);

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  } finally {
    await api?.stop();
  }
});

test("shows the empty state from an empty API composition", async ({
  page,
}) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("empty");
    await login(page);

    await expect(page.getByText("Project はまだありません。")).toBeVisible();
  } finally {
    await api?.stop();
  }
});

test("shows a request id from a failing API composition", async ({ page }) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("error");
    await login(page);

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Request ID:");
  } finally {
    await api?.stop();
  }
});

test("recovers with Retry after the API becomes available", async ({
  page,
}) => {
  let api: ApiProcess | undefined;
  let failedProjectsRoute: ((route: Route) => Promise<void>) | undefined;

  try {
    await page.goto("/login?returnTo=%2Fprojects");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

    api = await startApi("success");
    failedProjectsRoute = async (route) => {
      await route.abort("failed");
    };
    await page.route("**/api/projects", failedProjectsRoute, { times: 1 });
    await login(page);
    await expect(page.getByRole("alert")).toBeVisible();

    await page.evaluate(() => {
      document.documentElement.dataset.e2eNavigationMarker = "retained";
    });
    await page.getByRole("button", { name: "再試行" }).click();

    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset.e2eNavigationMarker,
        ),
      )
      .toBe("retained");
  } finally {
    if (failedProjectsRoute) {
      await page
        .unroute("**/api/projects", failedProjectsRoute)
        .catch(() => undefined);
    }
    await api?.stop();
  }
});

test("creates a Project and keeps it visible from its detail and list views", async ({
  page,
}) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("success");
    await login(page);
    await createProjectThroughUi(page, "Browser Created");

    await expect(
      page.getByRole("heading", { name: "Browser Created" }),
    ).toBeVisible();
    await expect(page.getByText("Version: 1", { exact: true })).toBeVisible();
    await expect(page.getByText("active", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Projects に戻る" }).click();
    await expect(
      page.getByRole("heading", { name: "Browser Created" }),
    ).toBeVisible();

    // <Link> 遷移ではキャッシュに差し込んだ値を見ているので、サーバーで確定したことも読み直して確かめる。
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Browser Created" }),
    ).toBeVisible();
  } finally {
    await api?.stop();
  }
});

test("moves between the list and a detail without a full page load", async ({
  page,
}) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("success");
    await login(page);
    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.e2eNavigationMarker = "retained";
    });

    await page.getByRole("link", { name: "Alpha" }).click();
    await expect(page).toHaveURL(/\/projects\/project_alpha$/u);
    await page.getByRole("link", { name: "Projects に戻る" }).click();
    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset.e2eNavigationMarker,
        ),
      )
      .toBe("retained");
  } finally {
    await api?.stop();
  }
});

test("shows the newer Project first from the cached list after returning through the header", async ({
  page,
}) => {
  let api: ApiProcess | undefined;
  let releaseList: (() => void) | undefined;
  let heldListRoute: ((route: Route) => Promise<void>) | undefined;
  const projectHeadings = page.locator("main ul h2");

  try {
    api = await startApi("success");
    await login(page);
    await createProjectThroughUi(page, "Browser Older");

    // ヘッダーの Projects はクライアント遷移なので、一覧はこの document のキャッシュに載る。
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(projectHeadings).toHaveText(["Browser Older", "Alpha"]);
    await page.evaluate(() => {
      document.documentElement.dataset.e2eNavigationMarker = "retained";
    });

    // 「Create Project」は <Link> なので document を読み直さず、一覧のキャッシュを保ったまま作成画面へ移る。
    await page.getByRole("link", { name: "Create Project" }).click();
    await expect(page).toHaveURL(/\/projects\/new$/u);
    await page.getByLabel("Project name").fill("Browser Newer");
    await page.getByRole("button", { name: "Create Project" }).click();
    await expect(
      page.getByRole("heading", { name: "Browser Newer" }),
    ).toBeVisible();

    // 一覧の再取得を止めておき、キャッシュだけで新しい順に並ぶことを確かめる。
    const listRelease = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    heldListRoute = async (route) => {
      await listRelease;
      await route.continue();
    };
    await page.route("**/api/projects", heldListRoute);
    await page.getByRole("link", { name: "Projects", exact: true }).click();

    await expect(projectHeadings).toHaveText([
      "Browser Newer",
      "Browser Older",
      "Alpha",
    ]);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.dataset.e2eNavigationMarker,
        ),
      )
      .toBe("retained");
  } finally {
    releaseList?.();
    if (heldListRoute) {
      await page
        .unroute("**/api/projects", heldListRoute)
        .catch(() => undefined);
    }
    await api?.stop();
  }
});

test("shows an optimistic Project rename before the PATCH response and confirms it in the list", async ({
  page,
}) => {
  let api: ApiProcess | undefined;
  let releasePatch: (() => void) | undefined;
  let patchRoute: ((route: Route) => Promise<void>) | undefined;
  let patchUrl: string | undefined;

  try {
    api = await startApi("empty");
    await login(page);
    const projectId = await createProjectThroughUi(page, "Browser Original");
    const patchRelease = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });

    patchRoute = async (route) => {
      await patchRelease;
      await route.continue();
    };
    patchUrl = `**/api/projects/${projectId}`;
    await page.route(patchUrl, patchRoute);

    const patchRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === `/api/projects/${projectId}`,
    );
    const patchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/projects/${projectId}`,
    );
    await page.getByLabel("Project name").fill("Browser Renamed");
    await page.getByRole("button", { name: "Save changes" }).click();
    await patchRequest;

    await expect(
      page.getByRole("heading", { name: "Browser Renamed" }),
    ).toBeVisible();

    releasePatch?.();
    expect((await patchResponse).status()).toBe(200);
    await expect(page.getByText("Version: 2", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Projects に戻る" }).click();
    await expect(
      page.getByRole("heading", { name: "Browser Renamed" }),
    ).toBeVisible();
  } finally {
    releasePatch?.();
    if (patchRoute && patchUrl) {
      await page.unroute(patchUrl, patchRoute).catch(() => undefined);
    }
    await api?.stop();
  }
});

test("archives a Project only after confirmation and preserves it in the list", async ({
  page,
}) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("empty");
    await login(page);
    await createProjectThroughUi(page, "Browser Archive");

    await page.getByRole("button", { name: "Archive Project" }).click();
    await expect(
      page.getByText("Archiving cannot be undone.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("active", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Archive Project" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Archive Project" }).click();
    await page.getByRole("button", { name: "Confirm archive" }).click();
    await expect(page.getByText("archived", { exact: true })).toBeVisible();
    await expect(page.getByText("Version: 2", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Project name")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Archive Project" }),
    ).toHaveCount(0);

    await page.getByRole("link", { name: "Projects に戻る" }).click();
    await expect(
      page.getByRole("heading", { name: "Browser Archive" }),
    ).toBeVisible();
  } finally {
    await api?.stop();
  }
});

test("rolls back a stale optimistic rename and refreshes the server winner", async ({
  page,
}) => {
  let api: ApiProcess | undefined;
  let releaseStalePatch: (() => void) | undefined;
  let stalePatchRoute: ((route: Route) => Promise<void>) | undefined;
  let stalePatchUrl: string | undefined;

  try {
    api = await startApi("empty");
    await login(page);
    const projectId = await createProjectThroughUi(page, "Browser Stale");
    await expect(page.getByText("Version: 1", { exact: true })).toBeVisible();

    const winnerResponse = await page.request.patch(
      `/api/projects/${projectId}`,
      {
        data: { name: "Server Winner", version: 1 },
        headers: { Origin: "http://127.0.0.1:5173" },
      },
    );
    expect(winnerResponse.status()).toBe(200);

    const stalePatchRelease = new Promise<void>((resolve) => {
      releaseStalePatch = resolve;
    });
    stalePatchRoute = async (route) => {
      await stalePatchRelease;
      await route.continue();
    };
    stalePatchUrl = `**/api/projects/${projectId}`;
    await page.route(stalePatchUrl, stalePatchRoute);

    const staleRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === `/api/projects/${projectId}`,
    );
    const staleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/projects/${projectId}`,
    );
    await page.getByLabel("Project name").fill("Stale UI");
    await page.getByRole("button", { name: "Save changes" }).click();
    await staleRequest;
    await expect(page.getByRole("heading", { name: "Stale UI" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`, "u"));

    releaseStalePatch?.();
    const conflictResponse = await staleResponse;
    expect(conflictResponse.status()).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      code: "PROJECT_VERSION_CONFLICT",
    });
    await expect(page.getByRole("alert")).toContainText(
      "Project was updated on the server.",
    );
    await expect(page.getByRole("heading", { name: "Stale UI" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("heading", { name: "Server Winner" }),
    ).toBeVisible();
    await expect(page.getByText("Version: 2", { exact: true })).toBeVisible();
  } finally {
    releaseStalePatch?.();
    if (stalePatchRoute && stalePatchUrl) {
      await page.unroute(stalePatchUrl, stalePatchRoute).catch(() => undefined);
    }
    await api?.stop();
  }
});

test("falls back to Projects after login when returnTo points to another origin", async ({
  page,
}) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("success");
    await page.goto("/login?returnTo=%2F%2Fevil.example");
    await page.getByRole("link", { name: "Sign in" }).click();

    await expect(page).toHaveURL("/projects");
    await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  } finally {
    await api?.stop();
  }
});

test("returns to a protected detail after login and protects it again after logout", async ({
  page,
}) => {
  let api: ApiProcess | undefined;

  try {
    api = await startApi("success");
    await page.goto("/projects/project_alpha");
    await expect(page).toHaveURL("/login?returnTo=%2Fprojects%2Fproject_alpha");

    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/projects/project_alpha");
    await expect(
      page.getByText("Local Developer", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");
    await page.goto("/projects");
    await expect(page).toHaveURL("/login?returnTo=%2Fprojects");
  } finally {
    await api?.stop();
  }
});
