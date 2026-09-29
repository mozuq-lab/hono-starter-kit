// @vitest-environment jsdom

import { ApiError, UnexpectedApiResponseError } from "@starter/api-client";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSessionExpired,
  isTransientFailure,
  queryClient,
  redirectToLogin,
  sessionNavigation,
} from "./query-client.js";

const unauthenticated = new ApiError({
  type: "https://starter.local/problems/unauthenticated",
  title: "Unauthenticated",
  status: 401,
  code: "UNAUTHENTICATED",
  requestId: "request_unauthenticated",
});

const internalError = new ApiError({
  type: "https://starter.local/problems/internal-server-error",
  title: "Internal Server Error",
  status: 500,
  code: "INTERNAL_ERROR",
  requestId: "request_internal",
});

const failQuery = (key: string, error: Error) =>
  queryClient
    .fetchQuery({ queryKey: [key], queryFn: () => Promise.reject(error) })
    .catch(() => undefined);

const catchThrown = (run: () => void): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

const spyOnFullPageNavigation = () =>
  vi.spyOn(sessionNavigation, "assign").mockImplementation(() => undefined);

beforeEach(() => {
  queryClient.clear();
  window.history.pushState({}, "", "/projects/project_alpha");
});

afterEach(() => {
  queryClient.clear();
});

describe("isSessionExpired", () => {
  it("matches only a 401 ApiError", () => {
    expect(isSessionExpired(unauthenticated)).toBe(true);
    expect(isSessionExpired(internalError)).toBe(false);
    expect(isSessionExpired(new Error("network unavailable"))).toBe(false);
  });
});

describe("isTransientFailure", () => {
  it.each([
    ["a network failure", new TypeError("Failed to fetch"), true],
    ["a non-Problem 502", new UnexpectedApiResponseError(502), true],
    ["a schema-mismatch 200", new UnexpectedApiResponseError(200), false],
    ["a non-Problem 4xx", new UnexpectedApiResponseError(400), false],
    ["a Problem 500", internalError, false],
    ["a Problem 401", unauthenticated, false],
  ])("treats %s as transient: %s", (_description, error, expected) => {
    expect(isTransientFailure(error)).toBe(expected);
  });
});

describe("redirectToLogin", () => {
  it("throws a router redirect and drops the expired session cache without a full page load", () => {
    const assign = spyOnFullPageNavigation();
    queryClient.setQueryData(["projects"], { items: ["cached"] });

    const result = catchThrown(() =>
      redirectToLogin("https://app.example.test/projects/project_alpha?tab=1"),
    );

    expect(result).toBeInstanceOf(Response);
    expect(result).toMatchObject({ status: 302 });
    expect((result as Response).headers.get("Location")).toBe(
      "/login?returnTo=%2Fprojects%2Fproject_alpha%3Ftab%3D1",
    );
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("session expiry detected outside the router", () => {
  it("sends a 401 from a background query to login and clears the cache", async () => {
    const assign = spyOnFullPageNavigation();
    queryClient.setQueryData(["projects"], { items: ["cached"] });

    await failQuery("background", unauthenticated);

    expect(assign).toHaveBeenCalledWith(
      "/login?returnTo=%2Fprojects%2Fproject_alpha",
    );
    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
  });

  it("ignores errors that are not an expired session", async () => {
    const assign = spyOnFullPageNavigation();

    await failQuery("server-error", internalError);
    await failQuery("offline", new Error("network unavailable"));

    expect(assign).not.toHaveBeenCalled();
  });

  it("keeps detecting session expiry after a loader redirect already handled one", async () => {
    const assign = spyOnFullPageNavigation();

    // 1. loader 経由の 401。ソフト遷移なのでモジュール状態は生き残る。
    expect(
      catchThrown(() =>
        redirectToLogin("https://app.example.test/projects/project_alpha"),
      ),
    ).toBeInstanceOf(Response);
    expect(assign).not.toHaveBeenCalled();

    // 2. 同じタブで後から起きた本物の 401 も握り潰さない。
    await failQuery("later-background", unauthenticated);

    expect(assign).toHaveBeenCalledWith(
      "/login?returnTo=%2Fprojects%2Fproject_alpha",
    );
  });

  it("keeps detecting session expiry after an earlier background 401", async () => {
    const assign = spyOnFullPageNavigation();

    await failQuery("first", unauthenticated);
    await failQuery("second", unauthenticated);

    expect(assign).toHaveBeenCalledTimes(2);
  });

  // 期限切れで clear() すると、マウント中の observer が消えたクエリを取り直して
  // 同じ 401 を繰り返す—という懸念に対する回帰テスト。clear() は observer へ更新を
  // 通知しないため再取得は走らない。将来 clear の使い方や依存の挙動が変わって
  // 連鎖が生まれたら、ここで落ちる。
  it("clears the cache on session expiry without a follow-up 401 refetch", async () => {
    const assign = spyOnFullPageNavigation();
    const queryFn = vi.fn(() => Promise.reject(unauthenticated));
    const observer = new QueryObserver(queryClient, {
      queryKey: ["projects"],
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      await vi.waitFor(() => {
        expect(assign).toHaveBeenCalled();
      });
      const attemptsAtRedirect = queryFn.mock.calls.length;
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(queryFn).toHaveBeenCalledTimes(attemptsAtRedirect);
    } finally {
      unsubscribe();
    }
  });

  it("collapses 401s raised in the same tick into a single navigation", async () => {
    const assign = spyOnFullPageNavigation();

    await Promise.all([
      failQuery("burst-one", unauthenticated),
      failQuery("burst-two", unauthenticated),
    ]);

    expect(assign).toHaveBeenCalledOnce();
  });
});
