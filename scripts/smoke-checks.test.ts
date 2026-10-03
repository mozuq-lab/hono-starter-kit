import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  checkAlbIsPrivate,
  createAddressResolver,
  isPrivateAddress,
  readExpectedSecurityHeaders,
  runHttpChecks,
  type SmokeResult,
} from "./smoke-checks.ts";
import {
  createFakeFetch,
  createHealthyRoutes,
  problemResponse,
  testHeaders,
  testOrigin,
  type RecordedCall,
  type Routes,
} from "./smoke-test-support.ts";

const edgeMain = new URL(
  "../infra/terraform/modules/edge/main.tf",
  import.meta.url,
);

test("reads the five security headers from the edge response headers policy", async () => {
  const headers = readExpectedSecurityHeaders(await readFile(edgeMain, "utf8"));

  assert.deepEqual(Object.keys(headers).sort(), [
    "content-security-policy",
    "referrer-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
  ]);
  assert.match(headers["content-security-policy"]!, /^default-src 'none';/u);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(
    headers["strict-transport-security"],
    "max-age=31536000; includeSubDomains",
  );
});

test("adds preload to HSTS only when the policy enables it", async () => {
  const source = (await readFile(edgeMain, "utf8")).replace(
    /preload\s*=\s*false/u,
    "preload = true",
  );

  assert.equal(
    readExpectedSecurityHeaders(source)["strict-transport-security"],
    "max-age=31536000; includeSubDomains; preload",
  );
});

test("refuses to guess when the policy can no longer be read", async () => {
  const source = (await readFile(edgeMain, "utf8")).replace(
    /frame_option\s*=\s*"DENY"/u,
    "",
  );

  assert.throws(() => readExpectedSecurityHeaders(source), /frame_option/u);
});

const runAgainst = (overrides: Routes = {}, calls: RecordedCall[] = []) =>
  runHttpChecks({
    origin: testOrigin,
    fetchImpl: createFakeFetch(
      { ...createHealthyRoutes(), ...overrides },
      calls,
    ),
    expectedHeaders: testHeaders,
    randomId: "test-id",
  });

const resultNamed = (results: SmokeResult[], name: string) => {
  const result = results.find((candidate) => candidate.name === name);
  assert.notEqual(result, undefined, `missing result: ${name}`);
  return result!;
};

const failedNames = (results: SmokeResult[]) =>
  results.filter((result) => !result.ok).map((result) => result.name);

test("a healthy environment passes every HTTP check", async () => {
  const results = await runAgainst();

  assert.deepEqual(
    results.map((result) => result.name),
    [
      "SPA deep link returns index.html",
      "Missing assets do not fall back to index.html",
      "/auth/login redirects to the identity provider",
      "POST, PATCH and DELETE reach the API",
      "API responses are not cached across sessions",
      "SPA responses carry the security headers",
      "API responses carry the security headers",
    ],
  );
  assert.deepEqual(failedNames(results), []);
});

test("a deep link that is not the same index.html fails", async () => {
  const results = await runAgainst({
    "GET /projects/example": () =>
      new Response("<!doctype html><title>Other</title>", {
        status: 200,
        headers: { "content-type": "text/html", ...testHeaders },
      }),
  });

  assert.deepEqual(failedNames(results), ["SPA deep link returns index.html"]);
});

test("a missing asset served as index.html fails, and a 404 passes", async () => {
  const fallback = await runAgainst({
    "GET /assets/smoke-test-id.js": () =>
      new Response("<!doctype html><title>Hono Starter Kit</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  assert.deepEqual(failedNames(fallback), [
    "Missing assets do not fall back to index.html",
  ]);

  const notFound = await runAgainst({
    "GET /smoke-test-id.png": () => new Response("Not Found", { status: 404 }),
  });
  assert.deepEqual(failedNames(notFound), []);
});

test("a login redirect that stays on the application origin fails", async () => {
  const results = await runAgainst({
    "GET /auth/login": () =>
      new Response(null, {
        status: 303,
        headers: { location: `${testOrigin}/login` },
      }),
  });

  assert.deepEqual(failedNames(results), [
    "/auth/login redirects to the identity provider",
  ]);
});

test("an unsafe method rejected by CloudFront with an HTML page fails without crashing", async () => {
  const results = await runAgainst({
    "PATCH /api/projects/smoke": () =>
      new Response("<html>403 ERROR</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
  });

  const result = resultNamed(results, "POST, PATCH and DELETE reach the API");
  assert.equal(result.ok, false);
  assert.match(result.detail, /PATCH/u);
});

test("/api/me answered twice with the same requestId is reported as cached", async () => {
  const results = await runAgainst({
    "GET /api/me": () =>
      problemResponse(401, "UNAUTHENTICATED", "request-cached"),
  });

  const result = resultNamed(
    results,
    "API responses are not cached across sessions",
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /requestId/u);
});

test("a cacheable API 404 answered twice with the same requestId is reported as cached", async () => {
  // CloudFront は 401 をキャッシュしないので、/api/me だけではキャッシュする policy を見逃す。
  const results = await runAgainst({
    "GET /auth/smoke-test-id": () =>
      problemResponse(404, "NOT_FOUND", "request-auth-cached"),
  });

  const result = resultNamed(
    results,
    "API responses are not cached across sessions",
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /\/auth\/smoke-test-id/u);
});

test("/api/me served from the CloudFront cache or without no-store fails", async () => {
  let served = 0;
  const hit = await runAgainst({
    "GET /api/me": () => {
      served += 1;
      return problemResponse(
        401,
        "UNAUTHENTICATED",
        `request-${String(served)}`,
        { "x-cache": "Hit from cloudfront" },
      );
    },
  });
  assert.deepEqual(failedNames(hit), [
    "API responses are not cached across sessions",
  ]);

  const cacheable = await runAgainst({
    "GET /api/me": () => {
      served += 1;
      return problemResponse(
        401,
        "UNAUTHENTICATED",
        `request-${String(served)}`,
        { "cache-control": "private, max-age=60" },
      );
    },
  });
  assert.deepEqual(failedNames(cacheable), [
    "API responses are not cached across sessions",
  ]);
});

test("/api/me without a requestId fails instead of crashing", async () => {
  const results = await runAgainst({
    "GET /api/me": () =>
      new Response("<html>401</html>", {
        status: 401,
        headers: { "content-type": "text/html", ...testHeaders },
      }),
  });

  assert.equal(
    resultNamed(results, "API responses are not cached across sessions").ok,
    false,
  );
});

test("a missing security header fails only the check for that response", async () => {
  const results = await runAgainst({
    "GET /projects/example": () =>
      new Response("<!doctype html><title>Hono Starter Kit</title>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "strict-transport-security":
            testHeaders["strict-transport-security"]!,
        },
      }),
  });

  const result = resultNamed(
    results,
    "SPA responses carry the security headers",
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /x-frame-options/u);
  assert.equal(
    resultNamed(results, "API responses carry the security headers").ok,
    true,
  );
});

const deepLinkWithHsts = (hsts: string) => ({
  "GET /projects/example": () =>
    new Response("<!doctype html><title>Hono Starter Kit</title>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "x-frame-options": testHeaders["x-frame-options"]!,
        "strict-transport-security": hsts,
      },
    }),
});

test("HSTS matches by directive, ignoring order, case and spacing", async () => {
  for (const hsts of [
    "max-age=31536000;includeSubDomains",
    "includeSubDomains; max-age=31536000",
    "max-age=31536000; INCLUDESUBDOMAINS",
  ]) {
    const results = await runAgainst(deepLinkWithHsts(hsts));
    assert.equal(
      resultNamed(results, "SPA responses carry the security headers").ok,
      true,
      hsts,
    );
  }
});

test("HSTS with a different max-age or a missing directive fails", async () => {
  for (const hsts of ["max-age=300; includeSubDomains", "max-age=31536000"]) {
    const results = await runAgainst(deepLinkWithHsts(hsts));
    assert.equal(
      resultNamed(results, "SPA responses carry the security headers").ok,
      false,
      hsts,
    );
  }
});

test("a request that fails fails its own check and the others still run", async () => {
  const results = await runAgainst({
    "GET /auth/login": () => {
      throw new Error("connect ETIMEDOUT");
    },
  });

  assert.deepEqual(failedNames(results), [
    "/auth/login redirects to the identity provider",
  ]);
  assert.match(
    resultNamed(results, "/auth/login redirects to the identity provider")
      .detail,
    /ETIMEDOUT/u,
  );
});

test("a connection failure reports the underlying cause, not only 'fetch failed'", async () => {
  const results = await runAgainst({
    "GET /auth/login": () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(
          new Error("getaddrinfo ENOTFOUND d111111abcdef8.cloudfront.net"),
          { code: "ENOTFOUND" },
        ),
      });
    },
  });

  assert.match(
    resultNamed(results, "/auth/login redirects to the identity provider")
      .detail,
    /fetch failed \(ENOTFOUND\)/u,
  );
});

test("requests send Origin on unsafe methods, distinct cookies to /api/me, and never follow redirects", async () => {
  const calls: RecordedCall[] = [];
  await runAgainst({}, calls);

  for (const call of calls) {
    assert.equal(call.init.redirect, "manual");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  const unsafe = calls.filter((call) =>
    ["POST", "PATCH", "DELETE"].includes(call.init.method ?? "GET"),
  );
  assert.equal(unsafe.length, 3);
  for (const call of unsafe) {
    assert.equal(new Headers(call.init.headers).get("origin"), testOrigin);
  }
  for (const pathname of ["/api/me", "/auth/smoke-test-id"]) {
    const cookies = calls
      .filter((call) => new URL(call.url).pathname === pathname)
      .map((call) => new Headers(call.init.headers).get("cookie"));
    assert.equal(cookies.length, 2, pathname);
    assert.notEqual(cookies[0], cookies[1], pathname);
  }
});

test("classifies private and public addresses", () => {
  for (const address of [
    "10.0.1.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "fd12::1",
    "fc00::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of [
    "172.15.0.1",
    "172.32.0.1",
    "8.8.8.8",
    "52.95.1.1",
    "2001:db8::1",
    "fe80::1",
    "not-an-address",
  ]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

const alb = "internal-dev.ap-northeast-1.elb.amazonaws.com";

test("an ALB name that resolves only to private addresses passes", async () => {
  const check = await checkAlbIsPrivate({
    albDnsName: alb,
    resolveAddresses: () => Promise.resolve(["10.0.1.5", "10.0.2.7"]),
  });

  assert.equal(check.name, "ALB is not reachable from the Internet");
  assert.equal(check.ok, true);
});

test("a public address, no address, or a failed lookup fails the ALB check", async () => {
  const mixed = await checkAlbIsPrivate({
    albDnsName: alb,
    resolveAddresses: () => Promise.resolve(["10.0.1.5", "52.95.1.1"]),
  });
  assert.equal(mixed.ok, false);
  assert.match(mixed.detail, /52\.95\.1\.1/u);

  const empty = await checkAlbIsPrivate({
    albDnsName: alb,
    resolveAddresses: () => Promise.resolve([]),
  });
  assert.equal(empty.ok, false);

  const failed = await checkAlbIsPrivate({
    albDnsName: alb,
    resolveAddresses: () => Promise.reject(new Error("queryA ESERVFAIL")),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /ESERVFAIL/u);
});

const dnsError = (code: string) =>
  Object.assign(new Error(`query ${code}`), { code });

test("a missing record family counts as no addresses, but other DNS errors propagate", async () => {
  const ipv4Only = createAddressResolver({
    resolve4: () => Promise.resolve(["10.0.1.5"]),
    resolve6: () => Promise.reject(dnsError("ENODATA")),
  });
  assert.deepEqual(await ipv4Only(alb), ["10.0.1.5"]);

  const broken = createAddressResolver({
    resolve4: () => Promise.reject(dnsError("ESERVFAIL")),
    resolve6: () => Promise.resolve([]),
  });
  await assert.rejects(broken(alb), /ESERVFAIL/u);
});
