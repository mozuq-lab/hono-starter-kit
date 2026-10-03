import type { SecurityHeaders, SmokeFetch } from "./smoke-checks.ts";

// smoke test の単体テストが使う、健全な dev 環境を模した応答。各テストは 1 つの経路だけを
// 差し替えて、その項目が FAIL になることを確かめる。

export type Routes = Record<string, () => Response>;
export type RecordedCall = { url: string; init: RequestInit };

export const testOrigin = "https://d111111abcdef8.cloudfront.net";
export const testHeaders: SecurityHeaders = {
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

const indexHtml = "<!doctype html><title>Hono Starter Kit</title>";

const html = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html", ...testHeaders },
  });

const s3Denied = () =>
  new Response("<Error><Code>AccessDenied</Code></Error>", {
    status: 403,
    headers: { "content-type": "application/xml" },
  });

export const problemResponse = (
  status: number,
  code: string,
  requestId: string,
  headers: Record<string, string> = {},
) =>
  new Response(
    JSON.stringify({
      type: "https://starter.local/problems/x",
      title: "x",
      status,
      code,
      requestId,
    }),
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        "x-cache": "Miss from cloudfront",
        ...testHeaders,
        ...headers,
      },
    },
  );

export const createHealthyRoutes = (): Routes => {
  let meRequests = 0;
  let authRequests = 0;
  return {
    "GET /": () => html(200, indexHtml),
    "GET /projects/example": () => html(200, indexHtml),
    "GET /assets/smoke-test-id.js": s3Denied,
    "GET /smoke-test-id.png": s3Denied,
    "GET /auth/login": () =>
      new Response(null, {
        status: 303,
        headers: {
          location:
            "https://starter-dev.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize?client_id=x",
        },
      }),
    "POST /api/projects": () =>
      problemResponse(401, "UNAUTHENTICATED", "request-post"),
    "PATCH /api/projects/smoke": () =>
      problemResponse(401, "UNAUTHENTICATED", "request-patch"),
    "DELETE /auth/smoke": () =>
      problemResponse(404, "NOT_FOUND", "request-delete"),
    "GET /auth/smoke-test-id": () => {
      authRequests += 1;
      return problemResponse(
        404,
        "NOT_FOUND",
        `request-auth-${String(authRequests)}`,
      );
    },
    "GET /api/me": () => {
      meRequests += 1;
      return problemResponse(
        401,
        "UNAUTHENTICATED",
        `request-me-${String(meRequests)}`,
      );
    },
  };
};

export const createFakeFetch =
  (routes: Routes, calls: RecordedCall[] = []): SmokeFetch =>
  (url, init) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    const route = routes[key];
    if (route === undefined) {
      return Promise.reject(new Error(`Unexpected request: ${key}`));
    }
    return Promise.resolve(route());
  };
