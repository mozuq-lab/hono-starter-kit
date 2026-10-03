import { readFile } from "node:fs/promises";

// pnpm smoke:dev の検査本体。デプロイ済みの dev 環境で、ローカルの Vite プロキシでは見つからない
// CloudFront・ALB・キャッシュポリシーの食い違いを、HTTP と DNS だけで確かめる。

export type SecurityHeaders = Readonly<Record<string, string>>;

const edgeMain = new URL(
  "../infra/terraform/modules/edge/main.tf",
  import.meta.url,
);

const capture = (source: string, pattern: RegExp, label: string): string => {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) {
    throw new Error(
      `Cannot read ${label} from the edge response headers policy.`,
    );
  }
  return value;
};

// ヘッダーの値を二重に書かないよう、期待値は Terraform から読む。書式が変わって読めないときは
// 検査を黙って緩めず、検査を始める前に止める。
export const readExpectedSecurityHeaders = (
  terraformSource: string,
): SecurityHeaders => {
  const policy = capture(
    terraformSource,
    /resource\s+"aws_cloudfront_response_headers_policy"\s+"security"\s*\{([\s\S]*?)\n\}/u,
    "the security policy",
  );
  if (!/content_type_options\s*\{/u.test(policy)) {
    throw new Error(
      "Cannot read content_type_options from the edge response headers policy.",
    );
  }
  const maxAge = capture(
    policy,
    /access_control_max_age_sec\s*=\s*(\d+)/u,
    "access_control_max_age_sec",
  );
  const includeSubdomains =
    capture(
      policy,
      /include_subdomains\s*=\s*(true|false)/u,
      "include_subdomains",
    ) === "true";
  const preload =
    capture(policy, /preload\s*=\s*(true|false)/u, "preload") === "true";

  return {
    "content-security-policy": capture(
      policy,
      /content_security_policy\s*=\s*"([^"]+)"/u,
      "content_security_policy",
    ),
    "x-content-type-options": "nosniff",
    "x-frame-options": capture(
      policy,
      /frame_option\s*=\s*"([^"]+)"/u,
      "frame_option",
    ),
    "referrer-policy": capture(
      policy,
      /referrer_policy\s*=\s*"([^"]+)"/u,
      "referrer_policy",
    ),
    "strict-transport-security": [
      `max-age=${maxAge}`,
      ...(includeSubdomains ? ["includeSubDomains"] : []),
      ...(preload ? ["preload"] : []),
    ].join("; "),
  };
};

export const loadExpectedSecurityHeaders = async (): Promise<SecurityHeaders> =>
  readExpectedSecurityHeaders(await readFile(edgeMain, "utf8"));

export type SmokeResult = { name: string; ok: boolean; detail: string };
export type SmokeFetch = (url: string, init: RequestInit) => Promise<Response>;

// CloudFront からオリジンまでの往復の上限。返ってこない要求でも、その項目だけを FAIL にする。
const requestTimeoutMs = 10_000;

type Sent =
  { ok: true; response: Response; body: string } | { ok: false; error: string };

const send = async (
  fetchImpl: SmokeFetch,
  url: string,
  init: Pick<RequestInit, "body" | "headers" | "method"> = {},
): Promise<Sent> => {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return { ok: true, response, body: await response.text() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const result = (name: string, problems: readonly string[]): SmokeResult =>
  problems.length === 0
    ? { name, ok: true, detail: "ok" }
    : { name, ok: false, detail: problems.join("; ") };

const contentType = (sent: Extract<Sent, { ok: true }>) =>
  sent.response.headers.get("content-type") ?? "no content-type";

const parseProblem = (body: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

// Hono の Problem が返れば、要求は CloudFront と ALB を通ってアプリまで届いている。CloudFront や
// ALB の拒否は HTML や固定応答なので、content-type と code で区別できる。
const problemIssues = (
  label: string,
  sent: Sent,
  status: number,
  code: string,
): string[] => {
  if (!sent.ok) return [`${label}: request failed: ${sent.error}`];
  const issues: string[] = [];
  if (sent.response.status !== status) {
    issues.push(
      `${label}: expected ${String(status)}, got ${String(sent.response.status)}`,
    );
  }
  if (!contentType(sent).startsWith("application/problem+json")) {
    issues.push(
      `${label}: expected application/problem+json, got ${contentType(sent)}`,
    );
  } else if (parseProblem(sent.body)?.code !== code) {
    issues.push(`${label}: expected Problem code ${code}`);
  }
  return issues;
};

const checkDeepLink = (root: Sent, deepLink: Sent): SmokeResult => {
  const issues: string[] = [];
  for (const [label, sent] of [
    ["/", root],
    ["/projects/example", deepLink],
  ] as const) {
    if (!sent.ok) {
      issues.push(`${label}: request failed: ${sent.error}`);
      continue;
    }
    if (sent.response.status !== 200) {
      issues.push(
        `${label}: expected 200, got ${String(sent.response.status)}`,
      );
    }
    if (!contentType(sent).startsWith("text/html")) {
      issues.push(`${label}: expected text/html, got ${contentType(sent)}`);
    }
  }
  if (
    issues.length === 0 &&
    root.ok &&
    deepLink.ok &&
    root.body !== deepLink.body
  ) {
    issues.push("/projects/example did not return the same document as /");
  }
  return result("SPA deep link returns index.html", issues);
};

// S3 は OAC に ListBucket を許していないので、存在しない key には 403 を返す見込み。
// 403 と 404 のどちらでも、index.html への fallback でなければよい。
const checkMissingAssets = (
  indexBody: string | undefined,
  assets: readonly (readonly [string, Sent])[],
): SmokeResult => {
  const issues: string[] = [];
  for (const [path, sent] of assets) {
    if (!sent.ok) {
      issues.push(`${path}: request failed: ${sent.error}`);
      continue;
    }
    if (sent.response.status !== 403 && sent.response.status !== 404) {
      issues.push(
        `${path}: expected 403 or 404, got ${String(sent.response.status)}`,
      );
    }
    if (indexBody !== undefined && sent.body === indexBody) {
      issues.push(`${path}: returned index.html`);
    }
  }
  return result("Missing assets do not fall back to index.html", issues);
};

const checkLoginRedirect = (origin: string, sent: Sent): SmokeResult => {
  const name = "/auth/login redirects to the identity provider";
  if (!sent.ok) return result(name, [`request failed: ${sent.error}`]);
  const issues: string[] = [];
  if (sent.response.status !== 303) {
    issues.push(`expected 303, got ${String(sent.response.status)}`);
  }
  // Location は state を含むので表示しない。https で、アプリとは別の origin であることだけを見る。
  const location = sent.response.headers.get("location");
  let target: URL | undefined;
  try {
    target = location === null ? undefined : new URL(location);
  } catch {
    target = undefined;
  }
  if (target?.protocol !== "https:" || target.origin === origin) {
    issues.push("Location must be an https URL on the identity provider");
  }
  return result(name, issues);
};

const checkSessionCaching = (first: Sent, second: Sent): SmokeResult => {
  const issues = [
    ...problemIssues("first /api/me", first, 401, "UNAUTHENTICATED"),
    ...problemIssues("second /api/me", second, 401, "UNAUTHENTICATED"),
  ];
  const requestIds: unknown[] = [];
  for (const [label, sent] of [
    ["first /api/me", first],
    ["second /api/me", second],
  ] as const) {
    if (!sent.ok) continue;
    if (
      !(sent.response.headers.get("cache-control") ?? "").includes("no-store")
    ) {
      issues.push(`${label}: Cache-Control must include no-store`);
    }
    if ((sent.response.headers.get("x-cache") ?? "").includes("Hit")) {
      issues.push(`${label}: served from the CloudFront cache`);
    }
    requestIds.push(parseProblem(sent.body)?.requestId);
  }
  // キャッシュされた応答なら 2 回とも同じ requestId になる。別々ならどちらもオリジンまで届いている。
  if (
    requestIds.length === 2 &&
    (typeof requestIds[0] !== "string" ||
      typeof requestIds[1] !== "string" ||
      requestIds[0] === requestIds[1])
  ) {
    issues.push("the two responses must carry different requestId values");
  }
  return result("/api/me is not cached across sessions", issues);
};

const checkSecurityHeaders = (
  name: string,
  sent: Sent,
  expectedHeaders: SecurityHeaders,
): SmokeResult => {
  if (!sent.ok) return result(name, [`request failed: ${sent.error}`]);
  const issues = Object.entries(expectedHeaders).flatMap(
    ([header, expected]) => {
      const actual = sent.response.headers.get(header);
      return actual === expected
        ? []
        : [
            `${header}: expected "${expected}", got ${actual === null ? "nothing" : `"${actual}"`}`,
          ];
    },
  );
  return result(name, issues);
};

export const runHttpChecks = async ({
  origin,
  fetchImpl,
  expectedHeaders,
  randomId,
}: {
  origin: string;
  fetchImpl: SmokeFetch;
  expectedHeaders: SecurityHeaders;
  randomId: string;
}): Promise<SmokeResult[]> => {
  const url = (path: string) => new URL(path, origin).href;
  const root = await send(fetchImpl, url("/"));
  const deepLink = await send(fetchImpl, url("/projects/example"));
  const assets: (readonly [string, Sent])[] = [];
  for (const path of [
    `/assets/smoke-${randomId}.js`,
    `/smoke-${randomId}.png`,
  ]) {
    assets.push([path, await send(fetchImpl, url(path))] as const);
  }
  const login = await send(fetchImpl, url("/auth/login"));
  const withOrigin = { origin, "content-type": "application/json" };
  const post = await send(fetchImpl, url("/api/projects"), {
    method: "POST",
    headers: withOrigin,
    body: "{}",
  });
  const patch = await send(fetchImpl, url("/api/projects/smoke"), {
    method: "PATCH",
    headers: withOrigin,
    body: "{}",
  });
  const remove = await send(fetchImpl, url("/auth/smoke"), {
    method: "DELETE",
    headers: { origin },
  });
  const firstMe = await send(fetchImpl, url("/api/me"), {
    headers: { cookie: `__Host-session=smoke-a-${randomId}` },
  });
  const secondMe = await send(fetchImpl, url("/api/me"), {
    headers: { cookie: `__Host-session=smoke-b-${randomId}` },
  });

  return [
    checkDeepLink(root, deepLink),
    checkMissingAssets(
      root.ok && root.response.status === 200 ? root.body : undefined,
      assets,
    ),
    checkLoginRedirect(origin, login),
    result("POST, PATCH and DELETE reach the API", [
      ...problemIssues("POST /api/projects", post, 401, "UNAUTHENTICATED"),
      ...problemIssues(
        "PATCH /api/projects/smoke",
        patch,
        401,
        "UNAUTHENTICATED",
      ),
      ...problemIssues("DELETE /auth/smoke", remove, 404, "NOT_FOUND"),
    ]),
    checkSessionCaching(firstMe, secondMe),
    checkSecurityHeaders(
      "SPA responses carry the security headers",
      deepLink,
      expectedHeaders,
    ),
    checkSecurityHeaders(
      "API responses carry the security headers",
      firstMe,
      expectedHeaders,
    ),
  ];
};
