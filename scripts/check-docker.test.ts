import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { clearTimeout, setImmediate, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";

import { runDockerVerification } from "./check-docker.ts";
import * as dockerVerification from "./check-docker.ts";

const withWatchdog = async <Result>(
  operation: Promise<Result>,
  timeoutMs = 100,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Test watchdog expired.")),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, watchdog]);
  } finally {
    clearTimeout(timer);
  }
};

test("tracks every published Compose service port", () => {
  assert.deepEqual(dockerVerification.servicePorts, [
    { containerPort: 5432, service: "postgres" },
    { containerPort: 3000, service: "api" },
    { containerPort: 5173, service: "web" },
    { containerPort: 16686, service: "jaeger" },
  ]);
});

test("Jaeger readiness deadline rejects a request that ignores its signal", async () => {
  await assert.rejects(
    withWatchdog(
      dockerVerification.waitForHttpReady({
        fetchImpl: async () => new Promise(() => undefined),
        origin: "http://127.0.0.1:16686",
        signal: new globalThis.AbortController().signal,
        timeoutMs: 5,
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Jaeger UI did not become ready after restart.",
      );
      return true;
    },
  );
});

test("workflow abort rejects a Jaeger readiness request that ignores its signal", async () => {
  const controller = new globalThis.AbortController();
  const workflowError = new Error("workflow interrupted");
  const abortTimer = setTimeout(() => controller.abort(workflowError), 5);

  try {
    await assert.rejects(
      withWatchdog(
        dockerVerification.waitForHttpReady({
          fetchImpl: async () => new Promise(() => undefined),
          origin: "http://127.0.0.1:16686",
          signal: controller.signal,
          timeoutMs: 1_000,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error, workflowError);
        return true;
      },
    );
  } finally {
    clearTimeout(abortTimer);
  }
});

test("Jaeger readiness removes its workflow abort listener after success", async () => {
  const controller = new globalThis.AbortController();
  let requestedSignal: AbortSignal | null | undefined;

  await dockerVerification.waitForHttpReady({
    fetchImpl: async (_input, init) => {
      requestedSignal = init?.signal;
      return new globalThis.Response(undefined, { status: 200 });
    },
    origin: "http://127.0.0.1:16686",
    signal: controller.signal,
    timeoutMs: 1_000,
  });

  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(requestedSignal?.aborted, false);
  controller.abort();
  assert.equal(requestedSignal?.aborted, false);
});

const waitFor = async (predicate: () => boolean) => {
  while (!predicate()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

type CommandCall = readonly string[];

const assertRemovesOwnedComposeImages = (calls: readonly CommandCall[]) => {
  const cleanup = calls.find(
    ([command, ...args]) =>
      command === "docker" && args.includes("down") && args.includes("-v"),
  );
  assert.ok(cleanup, "project-scoped Compose teardown must run");
  assert.ok(cleanup.includes("--rmi"));
  assert.ok(cleanup.includes("local"));
  assert.equal(
    calls.some(
      ([command, operation]) =>
        command === "docker" &&
        (operation === "image" || operation === "system"),
    ),
    false,
    "cleanup must not prune unrelated Docker resources",
  );
};

const verificationDefaults = {
  assertPortsCanRebind: async () => undefined,
  composeEnvironment: {},
  createTerraformDockerVerification: () => ({
    cleanup: async () => undefined,
    verify: async () => undefined,
  }),
  createProductionImageVerification: (options: {
    onApiPort?: (port: number) => void;
  }) => ({
    cleanup: async () => undefined,
    verify: async () => {
      (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
      return { apiPort: 55129 };
    },
  }),
  discoverPort: async () => {
    throw new Error("unexpected port discovery");
  },
  hostEnvironment: {},
  log: () => undefined,
  projectName: "hono-starter-kit-test-1234-a1b2c3d4e5f60708",
  reportFailure: () => undefined,
  testDatabaseName: "starter_test_0123456789abcdef",
  verifyAuthenticatedFlowThroughWeb: async () => undefined,
};

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new globalThis.Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });

const flowResponsesThroughLogout = ({
  cookieValue,
  logoutSetCookie,
}: {
  cookieValue: string;
  logoutSetCookie: string;
}) => {
  const alpha = {
    id: "project_alpha",
    name: "Alpha",
    status: "active",
    version: 1,
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  const created = {
    id: "project_123e4567-e89b-42d3-a456-426614174000",
    name: "Docker Created",
    status: "active",
    version: 1,
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const renamed = {
    ...created,
    name: "Docker Renamed",
    version: 2,
    updatedAt: "2026-08-08T00:01:00.000Z",
  };
  const archived = {
    ...renamed,
    status: "archived",
    version: 3,
    updatedAt: "2026-08-08T00:02:00.000Z",
  };
  const problem = (code: string) =>
    jsonResponse(409, {
      code,
      requestId: `request_${code.toLowerCase()}`,
      status: 409,
      title: "Conflict",
      type: "about:blank",
    });

  return [
    jsonResponse(401, { status: 401 }),
    new globalThis.Response(null, {
      headers: {
        Location: "/projects",
        "Set-Cookie": `session=${cookieValue}; Path=/; HttpOnly; SameSite=Lax`,
      },
      status: 303,
    }),
    jsonResponse(200, {
      user: {
        displayName: "Local Developer",
        email: "developer@starter.local",
        id: "user_local-developer",
        roles: ["projects:read", "projects:write"],
      },
    }),
    jsonResponse(200, { items: [alpha] }),
    jsonResponse(201, created, {
      Location: `/api/projects/${created.id}`,
      "X-Request-Id": "request-created-123",
    }),
    jsonResponse(200, created),
    jsonResponse(200, renamed),
    problem("PROJECT_VERSION_CONFLICT"),
    jsonResponse(200, renamed),
    jsonResponse(200, archived),
    problem("PROJECT_ARCHIVED"),
    jsonResponse(200, { items: [alpha, archived] }),
    new globalThis.Response(null, {
      headers: { "Set-Cookie": logoutSetCookie },
      status: 204,
    }),
    jsonResponse(401, { status: 401 }),
    jsonResponse(401, { status: 401 }),
  ];
};

const captureVerificationError = async (operation: () => Promise<unknown>) => {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("verification was expected to reject");
};

test("cookiePairFrom returns only the first login cookie pair and rejects a missing cookie", () => {
  assert.equal(
    dockerVerification.cookiePairFrom(
      new globalThis.Response(null, {
        headers: {
          "Set-Cookie": "session=opaque-secret; Path=/; HttpOnly; SameSite=Lax",
        },
      }),
    ),
    "session=opaque-secret",
  );
  assert.throws(
    () => dockerVerification.cookiePairFrom(new globalThis.Response(null)),
    /login must set a session cookie/u,
  );
});

for (const [attribute, setCookie, expectedMessage] of [
  [
    "HttpOnly",
    "session=LOGIN_HEADER_SECRET_5e884898; Path=/; SameSite=Lax",
    "login cookie must be HttpOnly",
  ],
  [
    "SameSite=Lax",
    "session=LOGIN_HEADER_SECRET_5e884898; Path=/; HttpOnly; SameSite=Strict",
    "login cookie must use SameSite=Lax",
  ],
]) {
  test(`malformed login ${attribute} error does not expose the session cookie`, async () => {
    const responses = [
      jsonResponse(401, { status: 401 }),
      new globalThis.Response(null, {
        headers: { Location: "/projects", "Set-Cookie": setCookie ?? "" },
        status: 303,
      }),
    ];
    const error = await captureVerificationError(() =>
      dockerVerification.verifyAuthenticatedFlowThroughWeb({
        fetchImpl: () => Promise.resolve(responses.shift()!),
        log: () => undefined,
        queryAuthTables: async () => {
          throw new Error("database must not be queried");
        },
        signal: new globalThis.AbortController().signal,
        webPort: 55173,
      }),
    );

    assert.equal(
      inspect(error, { depth: null }).includes("LOGIN_HEADER_SECRET_5e884898"),
      false,
      "verification error must redact the login session cookie",
    );
    assert.equal(error.message, expectedMessage);
  });
}

test("malformed logout clearing-cookie error does not expose the session cookie", async () => {
  const cookieValue = "LOGIN_LOGOUT_SECRET_9f86d081";
  const responses = flowResponsesThroughLogout({
    cookieValue,
    logoutSetCookie: `session=${cookieValue}; Path=/; HttpOnly; SameSite=Lax`,
  });
  const error = await captureVerificationError(() =>
    dockerVerification.verifyAuthenticatedFlowThroughWeb({
      fetchImpl: () => Promise.resolve(responses.shift()!),
      log: () => undefined,
      queryAuthTables: async () => ({
        sessions: [
          {
            id_hash:
              "ca9e3c87b59363682cb93aad006d86f69eb75c0dd1b1cbec88d388654d885ac0",
            revoked_at: null,
          },
        ],
        userIdentities: [],
        users: [],
      }),
      signal: new globalThis.AbortController().signal,
      webPort: 55173,
    }),
  );

  assert.equal(
    inspect(error, { depth: null }).includes(cookieValue),
    false,
    "verification error must redact the logout session cookie",
  );
  assert.equal(error.message, "logout must clear the session cookie");
});

test("authenticated flow sends its cookie and exact Origin, checks the database, logs out, and rejects the old cookie", async () => {
  const webOrigin = "http://127.0.0.1:55173";
  const cookiePair = "session=opaque-secret";
  const setCookie = `${cookiePair}; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax`;
  const alpha = {
    id: "project_alpha",
    name: "Alpha",
    status: "active",
    version: 1,
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  const created = {
    id: "project_123e4567-e89b-42d3-a456-426614174000",
    name: "Docker Created",
    status: "active",
    version: 1,
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const renamed = {
    ...created,
    name: "Docker Renamed",
    version: 2,
    updatedAt: "2026-08-08T00:01:00.000Z",
  };
  const archived = {
    ...renamed,
    status: "archived",
    version: 3,
    updatedAt: "2026-08-08T00:02:00.000Z",
  };
  const responses = [
    jsonResponse(401, { status: 401 }),
    new globalThis.Response(null, {
      headers: { Location: "/projects", "Set-Cookie": setCookie ?? "" },
      status: 303,
    }),
    jsonResponse(200, {
      user: {
        displayName: "Local Developer",
        email: "developer@starter.local",
        id: "user_local-developer",
        roles: ["projects:read", "projects:write"],
      },
    }),
    jsonResponse(200, { items: [alpha] }),
    jsonResponse(201, created, {
      Location: `/api/projects/${created.id}`,
      "X-Request-Id": "request-created-123",
    }),
    jsonResponse(200, created),
    jsonResponse(200, renamed),
    jsonResponse(409, {
      code: "PROJECT_VERSION_CONFLICT",
      detail: "stale",
      requestId: "request_stale",
      status: 409,
      title: "Project version conflict",
      type: "about:blank",
    }),
    jsonResponse(200, renamed),
    jsonResponse(200, archived),
    jsonResponse(409, {
      code: "PROJECT_ARCHIVED",
      detail: "archived",
      requestId: "request_archived",
      status: 409,
      title: "Project archived",
      type: "about:blank",
    }),
    jsonResponse(200, { items: [alpha, archived] }),
    new globalThis.Response(null, {
      headers: {
        "Set-Cookie": "session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
      },
      status: 204,
    }),
    jsonResponse(401, { status: 401 }),
    jsonResponse(401, { status: 401 }),
  ];
  const requests: { init: RequestInit; url: string }[] = [];
  const events: string[] = [];
  let traceEvidence: unknown;

  await dockerVerification.verifyAuthenticatedFlowThroughWeb({
    async fetchImpl(input, init = {}) {
      events.push("fetch");
      requests.push({ init, url: new URL(input as string | URL).href });
      const response = responses.shift();
      assert.ok(
        response,
        `unexpected request ${new URL(input as string | URL).href}`,
      );
      return response;
    },
    log: () => undefined,
    async onTraceEvidence(evidence) {
      events.push("trace");
      traceEvidence = evidence;
    },
    async queryAuthTables(details) {
      events.push("database");
      assert.deepEqual(details, {
        cookiePair,
        cookieValue: "opaque-secret",
        setCookie,
      });
      return {
        sessions: [
          { id_hash: "a".repeat(64), revoked_at: null },
          {
            id_hash:
              "2582fe28facec37f99e05f0b36a0301a74e1df2cccf932d9443c9e74840d654a",
            revoked_at: null,
          },
        ],
        userIdentities: [{ issuer: "urn:starter:dev" }],
        users: [{ id: "user_local-developer" }],
      };
    },
    signal: new globalThis.AbortController().signal,
    webPort: 55173,
  });

  assert.equal(responses.length, 0);
  assert.deepEqual(
    requests.map(({ init, url }) => [
      new URL(url).pathname,
      init.method ?? "GET",
    ]),
    [
      ["/api/projects", "GET"],
      ["/auth/login", "GET"],
      ["/api/me", "GET"],
      ["/api/projects", "GET"],
      ["/api/projects", "POST"],
      [`/api/projects/${created.id}`, "GET"],
      [`/api/projects/${created.id}`, "PATCH"],
      [`/api/projects/${created.id}`, "PATCH"],
      [`/api/projects/${created.id}`, "GET"],
      [`/api/projects/${created.id}/archive`, "POST"],
      [`/api/projects/${created.id}`, "PATCH"],
      ["/api/projects", "GET"],
      ["/auth/logout", "POST"],
      ["/api/me", "GET"],
      ["/api/projects", "GET"],
    ],
  );
  assert.equal(requests[1]?.init.redirect, "manual");
  assert.equal(new URL(requests[1].url).search, "?returnTo=/projects");

  const createHeaders = new globalThis.Headers(requests[4]?.init.headers);
  assert.equal(
    createHeaders.get("authorization"),
    "Bearer AUTH_PROBE_DO_NOT_EXPORT",
  );
  const traceparent = createHeaders.get("traceparent") ?? "";
  assert.match(traceparent, /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/u);
  const [, propagatedTraceId, propagatedParentSpanId] =
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/u.exec(traceparent) ?? [];
  assert.notEqual(propagatedTraceId, "0".repeat(32));
  assert.notEqual(propagatedParentSpanId, "0".repeat(16));
  assert.deepEqual(traceEvidence, {
    expectedServerSpanName: "POST /api/projects",
    expectedTraceId: propagatedTraceId,
    forbiddenValues: [
      setCookie,
      cookiePair,
      "opaque-secret",
      "Bearer AUTH_PROBE_DO_NOT_EXPORT",
      "Docker Created",
    ],
    requestId: "request-created-123",
  });

  for (const request of requests.slice(2)) {
    assert.equal(
      new globalThis.Headers(request.init.headers).get("cookie"),
      cookiePair,
    );
  }
  for (const index of [4, 6, 7, 9, 10, 12]) {
    assert.equal(
      new globalThis.Headers(requests[index]?.init.headers).get("origin"),
      webOrigin,
    );
  }
  assert.equal(events.indexOf("trace"), 5);
  assert.equal(events.indexOf("database"), 13);
});

test("trace evidence callback failures redact every forbidden probe", async () => {
  const cookieValue = "TRACE_CALLBACK_SECRET_6b51d431";
  const responses = flowResponsesThroughLogout({
    cookieValue,
    logoutSetCookie: "session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
  });

  const error = await captureVerificationError(() =>
    dockerVerification.verifyAuthenticatedFlowThroughWeb({
      fetchImpl: () => Promise.resolve(responses.shift()!),
      log: () => undefined,
      onTraceEvidence: (evidence: unknown) => {
        const { forbiddenValues } = evidence as { forbiddenValues: unknown[] };
        throw new Error(`trace lookup leaked ${forbiddenValues.join(" ")}`);
      },
      queryAuthTables: async () => {
        throw new Error("database must not be queried");
      },
      signal: new globalThis.AbortController().signal,
      webPort: 55173,
    }),
  );

  assert.equal(error.message, "Trace evidence verification failed.");
  const serializedError = inspect(error, { depth: null });
  for (const forbiddenValue of [
    cookieValue,
    "Bearer AUTH_PROBE_DO_NOT_EXPORT",
    "Docker Created",
  ]) {
    assert.equal(serializedError.includes(forbiddenValue), false);
  }
});

test("authenticated flow rejects raw cookie material found in auth tables", async () => {
  const created = {
    id: "project_123e4567-e89b-42d3-a456-426614174000",
    name: "Docker Created",
    status: "active",
    version: 1,
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const renamed = {
    ...created,
    name: "Docker Renamed",
    version: 2,
    updatedAt: "2026-08-08T00:01:00.000Z",
  };
  const archived = {
    ...renamed,
    status: "archived",
    version: 3,
    updatedAt: "2026-08-08T00:02:00.000Z",
  };
  const conflict = (code: string) =>
    jsonResponse(409, {
      code,
      requestId: `request_${code.toLowerCase()}`,
      status: 409,
      title: "Conflict",
      type: "about:blank",
    });
  const responses = [
    jsonResponse(401, { status: 401 }),
    new globalThis.Response(null, {
      headers: {
        Location: "/projects",
        "Set-Cookie": "session=leaked-secret; Path=/; HttpOnly; SameSite=Lax",
      },
      status: 303,
    }),
    jsonResponse(200, {
      user: {
        displayName: "Local Developer",
        email: "developer@starter.local",
        id: "user_local-developer",
        roles: ["projects:read", "projects:write"],
      },
    }),
    jsonResponse(200, {
      items: [
        {
          id: "project_alpha",
          name: "Alpha",
          status: "active",
          version: 1,
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      ],
    }),
    jsonResponse(201, created, {
      Location: `/api/projects/${created.id}`,
      "X-Request-Id": "request-created-123",
    }),
    jsonResponse(200, created),
    jsonResponse(200, renamed),
    conflict("PROJECT_VERSION_CONFLICT"),
    jsonResponse(200, renamed),
    jsonResponse(200, archived),
    conflict("PROJECT_ARCHIVED"),
    jsonResponse(200, { items: [archived] }),
  ];

  await assert.rejects(
    dockerVerification.verifyAuthenticatedFlowThroughWeb({
      fetchImpl: () => Promise.resolve(responses.shift()!),
      log: () => undefined,
      async queryAuthTables() {
        return {
          sessions: [
            {
              id_hash:
                "36469ac118c443d309c3c21e23a3676dd1d084ac2ccf94eec02e63e362ebd86f",
              provider_session_id: "leaked-secret",
              revoked_at: null,
            },
          ],
          userIdentities: [],
          users: [],
        };
      },
      signal: new globalThis.AbortController().signal,
      webPort: 55173,
    }),
    /raw session cookie material/u,
  );
});

test("generated Project ID verifier accepts only canonical project UUID IDs", () => {
  assert.doesNotThrow(() => {
    dockerVerification.assertGeneratedProjectId(
      "project_123e4567-e89b-42d3-a456-426614174000",
    );
  });

  for (const invalidProjectId of ["wrong-id", "project_not-a-uuid"]) {
    assert.throws(
      () => dockerVerification.assertGeneratedProjectId(invalidProjectId),
      /Created Project ID did not match generated format\./u,
    );
  }
});

test("a signal terminates the active child, drains duplicates, cleans once, then re-emits", async () => {
  const signalTarget = new EventEmitter();
  const calls: CommandCall[] = [];
  const terminatedWith: NodeJS.Signals[] = [];
  const reemitted: NodeJS.Signals[] = [];
  let rejectActive: ((reason?: unknown) => void) | undefined;
  const commandRunner = {
    run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      calls.push([command, ...args]);
      if (calls.length === 1) {
        return new Promise<string>((_resolve, reject) => {
          rejectActive = reject;
        });
      }
      return Promise.resolve("");
    },
    terminateActiveChild(signal: NodeJS.Signals) {
      terminatedWith.push(signal);
      rejectActive?.(new Error(`terminated by ${signal}`));
      return true;
    },
  };

  const verification = runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    reemitSignal(signal: NodeJS.Signals) {
      calls.push(["reemit", signal]);
      reemitted.push(signal);
    },
    signalTarget,
  });
  await waitFor(() => calls.length === 1);

  signalTarget.emit("SIGINT");
  signalTarget.emit("SIGTERM");
  await verification;

  assert.deepEqual(terminatedWith, ["SIGINT"]);
  assert.deepEqual(reemitted, ["SIGINT"]);
  assert.equal(
    calls.filter(
      ([command, ...args]) =>
        command === "docker" && args.includes("down") && args.includes("-v"),
    ).length,
    1,
  );
  assertRemovesOwnedComposeImages(calls);
  assert.ok(
    calls.findIndex(([command]) => command === "docker") <
      calls.findIndex(([command]) => command === "reemit"),
  );
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("verifies Terraform with the shared workflow before building the application and cleans it first", async () => {
  const events: unknown[][] = [];
  let productionOptions: Record<string, unknown> | undefined;
  let terraformOptions: Record<string, unknown> | undefined;
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      if (command === "docker" && args.at(-1) === "build") {
        events.push(["application Compose build"]);
      }
      if (command === "docker" && args.includes("down")) {
        events.push(["application Compose teardown"]);
      }
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    createProductionImageVerification: (options: Record<string, unknown>) => {
      productionOptions = options;
      return {
        async cleanup() {
          events.push(["production cleanup"]);
        },
        async verify() {
          (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
          return { apiPort: 55129 };
        },
      };
    },
    createTerraformDockerVerification: (options) => {
      terraformOptions = options;
      events.push(["terraform factory"]);
      return {
        async cleanup(...args: unknown[]) {
          events.push(["terraform cleanup", args]);
        },
        async verify() {
          events.push(["terraform verify"]);
        },
      };
    },
    discoverPort: (service: string) =>
      Promise.resolve(
        { api: 53000, jaeger: 56686, postgres: 55432, web: 55173 }[service] ??
          0,
      ),
    signalTarget: new EventEmitter(),
  });

  assert.deepEqual(events.slice(0, 3), [
    ["terraform factory"],
    ["terraform verify"],
    ["application Compose build"],
  ]);
  assert.equal(terraformOptions?.commandRunner, commandRunner);
  assert.equal(terraformOptions?.log, verificationDefaults.log);
  assert.equal(
    terraformOptions?.projectName,
    "hono-starter-kit-terraform-test-b340aa0e6cba2e96",
  );
  assert.equal(terraformOptions?.signal, productionOptions?.signal);
  assert.equal(
    (terraformOptions?.signal as AbortSignal | undefined)?.aborted,
    false,
  );
  const terraformCleanup = events.findIndex(
    ([event]) => event === "terraform cleanup",
  );
  assert.deepEqual(events[terraformCleanup], ["terraform cleanup", []]);
  assert.ok(
    terraformCleanup <
      events.findIndex(([event]) => event === "production cleanup"),
  );
  assert.ok(
    terraformCleanup <
      events.findIndex(([event]) => event === "application Compose teardown"),
  );
});

test("keeps the primary failure first when Terraform cleanup returns nested failures", async () => {
  const events: unknown[][] = [];
  const primaryFailure = new Error("production verification failed");
  const terraformCleanupFailure = new Error("Terraform cleanup failed");
  const signalTarget = new EventEmitter();

  await assert.rejects(
    runDockerVerification({
      ...verificationDefaults,
      commandRunner: {
        async run(
          command: string,
          args: readonly string[],
        ): Promise<string | { stdout: string; stderr: string }> {
          if (command === "docker" && args.includes("down")) {
            events.push(["application Compose teardown"]);
          }
          return "";
        },
        terminateActiveChild() {
          return false;
        },
      },
      createProductionImageVerification: (options) => ({
        async cleanup() {
          events.push(["production cleanup"]);
        },
        async verify() {
          (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
          throw primaryFailure;
        },
      }),
      createTerraformDockerVerification: () => ({
        async cleanup(...args: unknown[]) {
          events.push(["terraform cleanup", args]);
          throw new AggregateError(
            [primaryFailure, terraformCleanupFailure],
            "Terraform cleanup also saw the primary failure",
          );
        },
        async verify() {},
      }),
      discoverPort: (service: string) =>
        Promise.resolve(
          { api: 53000, jaeger: 56686, postgres: 55432, web: 55173 }[service] ??
            0,
        ),
      signalTarget,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primaryFailure, terraformCleanupFailure]);
      return true;
    },
  );

  const terraformCleanup = events.findIndex(
    ([event]) => event === "terraform cleanup",
  );
  assert.deepEqual(events[terraformCleanup], ["terraform cleanup", []]);
  assert.ok(
    terraformCleanup <
      events.findIndex(([event]) => event === "production cleanup"),
  );
  assert.ok(
    terraformCleanup <
      events.findIndex(([event]) => event === "application Compose teardown"),
  );
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("Terraform cleanup remains signal-independent and first during workflow interruption", async () => {
  const events: unknown[][] = [];
  const signalTarget = new EventEmitter();
  const reemitted: NodeJS.Signals[] = [];
  let terraformOptions: Record<string, unknown> | undefined;
  let productionStarted = false;
  const verification = runDockerVerification({
    ...verificationDefaults,
    commandRunner: {
      async run(
        command: string,
        args: readonly string[],
      ): Promise<string | { stdout: string; stderr: string }> {
        if (command === "docker" && args.includes("down")) {
          events.push(["application Compose teardown"]);
        }
        return "";
      },
      terminateActiveChild(signal: NodeJS.Signals) {
        events.push(["terminate", signal]);
        return false;
      },
    },
    createProductionImageVerification: (options) => ({
      async cleanup() {
        events.push(["production cleanup"]);
      },
      async verify() {
        productionStarted = true;
        (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
        const abortSignal = options.signal as AbortSignal;
        return new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            // signal.reason は呼び出し側が決める値。包み直すと理由が判別できなくなる。
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      },
    }),
    createTerraformDockerVerification: (options) => {
      terraformOptions = options;
      return {
        async cleanup(...args: unknown[]) {
          events.push([
            "terraform cleanup",
            args,
            (options.signal as AbortSignal).aborted,
          ]);
        },
        async verify() {},
      };
    },
    discoverPort: (service: string) =>
      Promise.resolve(
        { api: 53000, jaeger: 56686, postgres: 55432, web: 55173 }[service] ??
          0,
      ),
    reemitSignal: (signal) => reemitted.push(signal),
    signalTarget,
  });

  await withWatchdog(waitFor(() => productionStarted));
  signalTarget.emit("SIGTERM");
  signalTarget.emit("SIGINT");
  await verification;

  assert.equal(
    (terraformOptions?.signal as AbortSignal | undefined)?.aborted,
    true,
  );
  assert.deepEqual(
    events.filter(([event]) => event === "terraform cleanup"),
    [["terraform cleanup", [], true]],
  );
  const terraformCleanup = events.findIndex(
    ([event]) => event === "terraform cleanup",
  );
  assert.ok(
    terraformCleanup <
      events.findIndex(([event]) => event === "production cleanup"),
  );
  assert.ok(
    terraformCleanup <
      events.findIndex(([event]) => event === "application Compose teardown"),
  );
  assert.deepEqual(reemitted, ["SIGTERM"]);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("the first signal during Terraform internal cleanup waits for cleanup before re-emitting", async () => {
  const events: unknown[][] = [];
  const signalTarget = new EventEmitter();
  const terminatedWith: NodeJS.Signals[] = [];
  let resolveCleanupChild: ((value?: unknown) => void) | undefined;
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      events.push(["command", command, args]);
      if (args[0] === "terraform-internal-cleanup") {
        return new Promise<string>((resolve) => {
          resolveCleanupChild = resolve as (value?: unknown) => void;
        });
      }
      return "";
    },
    terminateActiveChild(signal: NodeJS.Signals) {
      terminatedWith.push(signal);
      return true;
    },
  };

  const verification = runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    createTerraformDockerVerification: (options) => ({
      async cleanup() {
        events.push(["outer Terraform cleanup"]);
      },
      async verify() {
        (options.onCleanupStart as (() => void) | undefined)?.();
        events.push(["Terraform cleanup start"]);
        await (
          options.commandRunner as {
            run(command: string, args: readonly string[]): Promise<unknown>;
          }
        ).run("docker", ["terraform-internal-cleanup"]);
        throw new Error("Terraform verification failed before cleanup");
      },
    }),
    reemitSignal(signal: NodeJS.Signals) {
      events.push(["reemit", signal]);
    },
    signalTarget,
  });

  await withWatchdog(waitFor(() => resolveCleanupChild !== undefined));
  signalTarget.emit("SIGINT");
  signalTarget.emit("SIGTERM");
  resolveCleanupChild?.();
  await verification;

  assert.deepEqual(terminatedWith, []);
  assert.equal(
    events.findIndex(([event]) => event === "Terraform cleanup start") <
      events.findIndex(([event]) => event === "outer Terraform cleanup"),
    true,
  );
  assert.equal(
    events.findIndex(([event]) => event === "outer Terraform cleanup") <
      events.findIndex(([event]) => event === "reemit"),
    true,
  );
  assert.deepEqual(events.at(-1), ["reemit", "SIGINT"]);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("passes the discovered Web port and abort signal to authenticated verification before cleanup", async () => {
  const signalTarget = new EventEmitter();
  const calls: CommandCall[] = [];
  const reemitted: NodeJS.Signals[] = [];
  let verificationSignal: AbortSignal | undefined;
  let verificationWebPort;
  let verificationStarted = false;
  let reboundPorts;
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      calls.push([command, ...args]);
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };
  const publishedPorts = {
    api: 53000,
    jaeger: 56686,
    postgres: 55432,
    web: 55173,
  };

  const verification = runDockerVerification({
    ...verificationDefaults,
    assertPortsCanRebind: async (ports) => {
      calls.push(["rebind"]);
      reboundPorts = { ...ports };
    },
    commandRunner,
    discoverPort: (service: string) =>
      Promise.resolve((publishedPorts as Record<string, number>)[service] ?? 0),
    reemitSignal(signal: NodeJS.Signals) {
      calls.push(["reemit", signal]);
      reemitted.push(signal);
    },
    signalTarget,
    verifyAuthenticatedFlowThroughWeb: (webPort, signal) => {
      verificationWebPort = webPort;
      verificationSignal = signal;
      verificationStarted = true;
      return new Promise(() => undefined);
    },
  });
  await waitFor(() => verificationStarted);

  assert.ok(
    calls.some((event) => event.includes("up") && event.includes("web")),
  );
  assert.equal(
    calls.some((event) => event.includes("down") && event.includes("-v")),
    false,
  );

  signalTarget.emit("SIGINT");
  const result = await Promise.race([
    verification.then(() => "completed"),
    delay(50, "timed-out"),
  ]);

  assert.equal(result, "completed");
  assert.equal(verificationWebPort, publishedPorts.web);
  assert.equal(verificationSignal?.aborted, true);
  assert.deepEqual(reboundPorts, {
    api: 53000,
    jaeger: 56686,
    postgres: 55432,
    web: 55173,
  });
  assert.deepEqual(reemitted, ["SIGINT"]);
  assert.equal(
    calls.filter((call) => call.includes("down") && call.includes("-v")).length,
    1,
  );
  const downIndex = calls.findIndex((event) => event.includes("down"));
  const rebindIndex = calls.findIndex(([event]) => event === "rebind");
  const reemitIndex = calls.findIndex(([event]) => event === "reemit");
  assert.ok(downIndex < rebindIndex);
  assert.ok(rebindIndex < reemitIndex);
});

test("reconfigures the API with the discovered Web Origin before authenticated verification", async () => {
  const events: unknown[] = [];
  const composeEnvironment = { API_PORT: "0", WEB_PORT: "0" };
  const publishedPorts = { api: 53000, postgres: 55432, web: 55173 };
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      events.push({
        args: [command, ...args],
        environment: { ...(options.environment as NodeJS.ProcessEnv) },
        type: "command",
      });
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    composeEnvironment,
    discoverPort: (service: string) =>
      Promise.resolve((publishedPorts as Record<string, number>)[service] ?? 0),
    signalTarget: new EventEmitter(),
    verifyAuthenticatedFlowThroughWeb: async () => {
      events.push({ type: "flow" });
    },
  });

  type RecordedEvent = { args?: string[]; type?: string };
  const recreateIndex = (events as RecordedEvent[]).findIndex(
    (event) =>
      event.type === "command" &&
      event.args?.includes("--force-recreate") === true &&
      event.args.at(-1) === "api",
  );
  const flowIndex = (events as RecordedEvent[]).findIndex(
    (event) => event.type === "flow",
  );
  assert.ok(recreateIndex >= 0);
  assert.ok(recreateIndex < flowIndex);
  const recreated = events[recreateIndex] as {
    environment: Record<string, string>;
  };
  assert.equal(recreated.environment.WEB_PORT, "55173");
  assert.equal(recreated.environment.API_PORT, "53000");
});

test("starts and discovers Jaeger before starting the API", async () => {
  const calls: CommandCall[] = [];
  const publishedPorts = {
    api: 53000,
    jaeger: 56686,
    postgres: 55432,
    web: 55173,
  };
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      calls.push([command, ...args]);
      if (args.includes("port")) {
        const service = args.at(-2) ?? "";
        return `127.0.0.1:${(publishedPorts as Record<string, number>)[service] ?? 0}`;
      }
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    discoverPort: undefined,

    signalTarget: new EventEmitter(),
  });

  const jaegerStartIndex = calls.findIndex(
    (args) => args.includes("up") && args.at(-1) === "jaeger",
  );
  const jaegerPortIndex = calls.findIndex(
    (args) => args.at(-2) === "jaeger" && args.at(-1) === "16686",
  );
  const apiStartIndex = calls.findIndex(
    (args) => args.includes("up") && args.at(-1) === "api",
  );

  assert.ok(jaegerStartIndex >= 0, "Jaeger must be started");
  assert.ok(jaegerPortIndex >= 0, "Jaeger UI port must be discovered");
  assert.deepEqual(
    calls[jaegerPortIndex],
    [
      "docker",
      "compose",
      "-p",
      "hono-starter-kit-test-1234-a1b2c3d4e5f60708",
      "--profile",
      "tools",
      "port",
      "jaeger",
      "16686",
    ],
    "Jaeger UI discovery must use docker compose port jaeger 16686",
  );
  assert.ok(jaegerStartIndex < apiStartIndex);
  assert.ok(jaegerPortIndex < apiStartIndex);
});

test("verifies trace evidence, keeps API healthy through a Jaeger outage, then restarts Jaeger", async () => {
  const events: unknown[][] = [];
  const expectedTraceId = "0123456789abcdef0123456789abcdef";
  const logs: string[] = [];
  let reboundPorts;
  let jaegerDiscoveries = 0;
  const publishedPorts = {
    api: 53000,
    jaeger: [56686, 57686],
    postgres: 55432,
    web: 55173,
  };
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      const event = [command, ...args];
      events.push(event);
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    assertPortsCanRebind: async (ports) => {
      reboundPorts = { ...ports };
    },
    commandRunner,
    discoverPort: async (service) => {
      const port =
        service === "jaeger"
          ? (publishedPorts.jaeger[jaegerDiscoveries++] ?? 0)
          : ((publishedPorts as unknown as Record<string, number>)[service] ??
            0);
      events.push(["discover", service, port]);
      return port;
    },
    async fetchImpl(input, init) {
      const url = new URL(input as string | URL);
      assert.equal(url.origin, "http://127.0.0.1:53000");
      assert.equal(url.pathname, "/healthz");
      assert.ok(init?.signal instanceof globalThis.AbortSignal);
      events.push(["health"]);
      return new globalThis.Response(null, { status: 200 });
    },
    log(message) {
      logs.push(message);
    },
    signalTarget: new EventEmitter(),
    async verifyAuthenticatedFlowThroughWeb(
      webPort,
      signal,
      queryAuthTables,
      onTraceEvidence,
    ) {
      assert.equal(webPort, publishedPorts.web);
      assert.ok(signal instanceof globalThis.AbortSignal);
      assert.equal(typeof queryAuthTables, "function");
      await onTraceEvidence({
        expectedServerSpanName: "POST /api/projects",
        expectedTraceId: "0123456789abcdef0123456789abcdef",
        forbiddenValues: ["RAW_SECRET", "Docker Created"],
        requestId: "request-123",
      });
      events.push(["remaining flow"]);
    },
    async waitForJaegerReady({ queryOrigin, signal }) {
      assert.equal(queryOrigin, "http://127.0.0.1:57686");
      assert.ok(signal instanceof globalThis.AbortSignal);
      events.push(["jaeger ready"]);
    },
    async waitForJaegerTrace(options) {
      assert.equal(options.expectedServerSpanName, "POST /api/projects");
      assert.equal(options.expectedTraceId, expectedTraceId);
      assert.equal(options.queryOrigin, "http://127.0.0.1:56686");
      assert.equal(options.requestId, "request-123");
      assert.equal(options.serviceName, "hono-starter-api");
      assert.deepEqual(options.forbiddenValues, [
        "RAW_SECRET",
        "Docker Created",
      ]);
      events.push(["trace"]);
      return { traceID: expectedTraceId };
    },
  });

  const indexOfEvent = (predicate: (event: unknown[]) => boolean) =>
    events.findIndex(predicate);
  const traceIndex = indexOfEvent(([event]) => event === "trace");
  const stopIndex = indexOfEvent(
    (event) => event.includes("stop") && event.at(-1) === "jaeger",
  );
  const healthIndex = indexOfEvent(([event]) => event === "health");
  const remainingFlowIndex = indexOfEvent(
    ([event]) => event === "remaining flow",
  );
  const restartIndex = indexOfEvent(
    (event) => event.includes("start") && event.at(-1) === "jaeger",
  );
  const readyIndex = indexOfEvent(([event]) => event === "jaeger ready");
  const downIndex = indexOfEvent(
    (event) => event.includes("down") && event.includes("-v"),
  );

  assert.ok(traceIndex < stopIndex);
  assert.ok(stopIndex < healthIndex);
  assert.ok(healthIndex < remainingFlowIndex);
  assert.ok(remainingFlowIndex < restartIndex);
  assert.ok(restartIndex < readyIndex);
  assert.ok(readyIndex < downIndex);
  assert.deepEqual(reboundPorts, {
    api: 53000,
    jaeger: 57686,
    jaegerBeforeRestart: 56686,
    postgres: 55432,
    productionApi: 55129,
    web: 55173,
  });
  assert.ok(
    logs.includes(
      `Validated Jaeger trace ${expectedTraceId} for Request ID request-123`,
    ),
  );
  assert.equal(
    logs.some((message) => message.includes("RAW_SECRET")),
    false,
  );
  assert.equal(
    logs.some((message) => message.includes("Docker Created")),
    false,
  );
});

test("a Jaeger restart failure still enters unconditional Compose teardown", async () => {
  const restartFailure = new Error("jaeger restart failed");
  const events: unknown[][] = [];
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      const event = [command, ...args];
      events.push(event);
      if (args.includes("start") && args.at(-1) === "jaeger") {
        throw restartFailure;
      }
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await assert.rejects(
    runDockerVerification({
      ...verificationDefaults,
      commandRunner,
      discoverPort: (service: string) =>
        Promise.resolve(
          { api: 53000, jaeger: 56686, postgres: 55432, web: 55173 }[service] ??
            0,
        ),
      fetchImpl: async () => new globalThis.Response(null, { status: 200 }),
      signalTarget: new EventEmitter(),
      async verifyAuthenticatedFlowThroughWeb(
        _webPort,
        _signal,
        _queryAuthTables,
        onTraceEvidence,
      ) {
        await onTraceEvidence({
          expectedServerSpanName: "POST /api/projects",
          expectedTraceId: "0123456789abcdef0123456789abcdef",
          forbiddenValues: [],
          requestId: "request-123",
        });
      },
      waitForJaegerReady: async () => {
        assert.fail("readiness must not run after restart failed");
      },
      waitForJaegerTrace: async () => ({
        traceID: "0123456789abcdef0123456789abcdef",
      }),
    }),
    (error) => error === restartFailure,
  );

  const restartIndex = events.findIndex(
    (event) => event.includes("start") && event.at(-1) === "jaeger",
  );
  const downIndex = events.findIndex(
    (event) => event.includes("down") && event.includes("-v"),
  );
  assert.ok(restartIndex >= 0);
  assert.ok(restartIndex < downIndex);
});

for (const [outcome, flowFailure] of [
  ["succeeds", undefined],
  ["fails", new Error("authenticated flow failed")],
]) {
  test(`cleans the isolated project and checks all four released ports when authenticated flow ${outcome}`, async () => {
    const calls: CommandCall[] = [];
    let reboundPorts;
    const publishedPorts = {
      api: 53000,
      jaeger: 56686,
      postgres: 55432,
      web: 55173,
    };
    const commandRunner = {
      async run(
        command: string,
        args: readonly string[],
      ): Promise<string | { stdout: string; stderr: string }> {
        calls.push([command, ...args]);
        return "";
      },
      terminateActiveChild() {
        return false;
      },
    };

    const verification = runDockerVerification({
      ...verificationDefaults,
      assertPortsCanRebind: async (ports) => {
        reboundPorts = { ...ports };
      },
      commandRunner,
      discoverPort: (service: string) =>
        Promise.resolve(
          (publishedPorts as Record<string, number>)[service] ?? 0,
        ),
      signalTarget: new EventEmitter(),
      verifyAuthenticatedFlowThroughWeb: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (flowFailure) throw flowFailure;
      },
    });

    if (flowFailure) {
      await assert.rejects(verification, (error) => error === flowFailure);
    } else {
      await verification;
    }

    assert.deepEqual(
      reboundPorts,
      flowFailure
        ? publishedPorts
        : { ...publishedPorts, productionApi: 55129 },
    );
    assert.equal(
      calls.filter(
        ([command, ...args]) =>
          command === "docker" && args.includes("down") && args.includes("-v"),
      ).length,
      1,
    );
    assertRemovesOwnedComposeImages(calls);
  });
}

test("records the PostgreSQL port immediately before a later database-test failure", async () => {
  const databaseTestFailure = new Error("database test failed");
  const events: unknown[][] = [];
  let reboundPorts;
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      events.push(["run", command, ...args]);
      if (args.includes("db-test")) throw databaseTestFailure;
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await assert.rejects(
    runDockerVerification({
      ...verificationDefaults,
      assertPortsCanRebind: async (ports) => {
        reboundPorts = { ...ports };
      },
      commandRunner,
      discoverPort: async (service) => {
        events.push(["discover", service]);
        assert.equal(service, "postgres");
        return 55432;
      },
      signalTarget: new EventEmitter(),
    }),
    (error) => error === databaseTestFailure,
  );

  assert.deepEqual(reboundPorts, { postgres: 55432 });
  assert.ok(
    events.findIndex(([event]) => event === "discover") <
      events.findIndex((event) => event.includes("db-test")),
  );
});

const ownedTestDatabaseCommand = [
  "docker",
  "compose",
  "-p",
  "hono-starter-kit-test-1234-a1b2c3d4e5f60708",
  "--profile",
  "tools",
  "exec",
  "-T",
  "postgres",
  "createdb",
  "-U",
  "starter",
  "starter_test_0123456789abcdef",
];

test("names the owned project with -p on every application compose command even without COMPOSE_PROJECT_NAME", async () => {
  const composeCalls: (readonly string[])[] = [];
  const commandRunner = {
    async run(command: string, args: readonly string[]) {
      if (command === "docker" && args[0] === "compose") {
        composeCalls.push(args);
      }
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    composeEnvironment: {},
    discoverPort: async () => 55432,
    signalTarget: new EventEmitter(),
  });

  assert.ok(composeCalls.some((args) => args.includes("down")));
  assert.ok(composeCalls.some((args) => args.includes("createdb")));
  assert.deepEqual(
    composeCalls.filter(
      (args) =>
        args[1] !== "-p" || args[2] !== verificationDefaults.projectName,
    ),
    [],
  );
});

test("refuses a project name that is not an owned check:docker project before running any command", async () => {
  for (const projectName of [
    "",
    "hono-starter-kit",
    "hono-starter-kit-dbtest-1-a1b2c3d4e5f60708",
  ]) {
    let commands = 0;
    await assert.rejects(
      runDockerVerification({
        ...verificationDefaults,
        commandRunner: {
          async run() {
            commands += 1;
            return "";
          },
          terminateActiveChild() {
            return false;
          },
        },
        projectName,
        signalTarget: new EventEmitter(),
      }),
      /Refusing to run Docker verification without an owned hono-starter-kit-test project name/u,
    );
    assert.equal(commands, 0);
  }
});

test("creates the owned test database before running db-test and no longer passes STARTER_DATABASE_TEST_GUARD", async () => {
  const calls: { args: readonly string[]; options: Record<string, unknown> }[] =
    [];
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      calls.push({ args: [command, ...args], options });
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    composeEnvironment: {
      COMPOSE_PROJECT_NAME: verificationDefaults.projectName,
    },
    discoverPort: async () => 55432,
    signalTarget: new EventEmitter(),
  });

  const createIndex = calls.findIndex(
    ({ args }) => inspect(args) === inspect(ownedTestDatabaseCommand),
  );
  const dbTestIndex = calls.findIndex(({ args }) => args.includes("db-test"));
  assert.ok(createIndex >= 0, "createdb must run for the owned test database");
  assert.ok(createIndex < dbTestIndex);
  assert.ok(
    calls.findIndex(
      ({ args }) => args.includes("up") && args.includes("postgres"),
    ) < createIndex,
  );
  const dbTestEnvironment = calls[dbTestIndex]?.options.environment as
    Record<string, string | undefined> | undefined;
  assert.equal(
    dbTestEnvironment?.STARTER_DATABASE_TEST_NAME,
    "starter_test_0123456789abcdef",
  );
  assert.equal(
    dbTestEnvironment?.COMPOSE_PROJECT_NAME,
    verificationDefaults.projectName,
  );
  assert.equal(
    "STARTER_DATABASE_TEST_GUARD" in (dbTestEnvironment ?? {}),
    false,
  );
});

test("retries createdb while the postgres entrypoint is still initializing and treats already exists on a retry as success", async () => {
  const createdbFailures = [
    'createdb: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory',
    'createdb: error: database creation failed: ERROR:  database "starter_test_0123456789abcdef" already exists',
  ];
  const calls: (readonly string[])[] = [];
  const commandRunner = {
    async run(command: string, args: readonly string[]) {
      calls.push([command, ...args]);
      if (args.includes("starter_test_0123456789abcdef")) {
        const stderr = createdbFailures.shift();
        if (stderr !== undefined) {
          const error = new Error("docker exited with status 1");
          Object.defineProperty(error, "stderr", { value: stderr });
          throw error;
        }
      }
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    commandRunner,
    createdbRetryDelayMs: 0,
    discoverPort: async () => 55432,
    signalTarget: new EventEmitter(),
  });

  assert.equal(
    calls.filter((call) => inspect(call) === inspect(ownedTestDatabaseCommand))
      .length,
    2,
  );
  assert.ok(calls.some((call) => call.includes("db-test")));
});

test("the check:docker environment names an owned test database and no guard token", () => {
  const environment = dockerVerification.createDockerVerificationEnvironment({
    hostEnvironment: { PATH: "/usr/bin" },
    pid: 4321,
  });

  assert.match(
    environment.projectName,
    /^hono-starter-kit-test-4321-[a-f0-9]{16}$/u,
  );
  assert.match(environment.testDatabaseName, /^starter_test_[a-f0-9]{16}$/u);
  assert.equal(
    environment.projectName.endsWith(
      environment.testDatabaseName.slice("starter_test_".length),
    ),
    false,
    "the database name must not reuse the project random part",
  );
  assert.equal(
    environment.composeEnvironment.COMPOSE_PROJECT_NAME,
    environment.projectName,
  );
  assert.equal(
    environment.composeEnvironment.STARTER_DATABASE_TEST_NAME,
    environment.testDatabaseName,
  );
  assert.equal(
    "STARTER_DATABASE_TEST_GUARD" in environment.composeEnvironment,
    false,
  );
  assert.equal(environment.composeEnvironment.PATH, "/usr/bin");
});

test("best-effort discovers a created service port before cleanup when up --wait fails", async () => {
  const startupFailure = new Error("postgres wait failed");
  const events: unknown[][] = [];
  let reboundPorts;
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
    ): Promise<string | { stdout: string; stderr: string }> {
      events.push(["run", command, ...args]);
      if (args.includes("up") && args.includes("postgres"))
        throw startupFailure;
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await assert.rejects(
    runDockerVerification({
      ...verificationDefaults,
      assertPortsCanRebind: async (ports) => {
        events.push(["rebind"]);
        reboundPorts = { ...ports };
      },
      commandRunner,
      discoverPort: async (service) => {
        events.push(["discover", service]);
        return 55432;
      },
      signalTarget: new EventEmitter(),
    }),
    (error) => error === startupFailure,
  );

  assert.deepEqual(reboundPorts, { postgres: 55432 });
  const discoverIndex = events.findIndex(([event]) => event === "discover");
  const downIndex = events.findIndex(
    (event) => event.includes("down") && event.includes("-v"),
  );
  assert.ok(discoverIndex >= 0);
  assert.ok(discoverIndex < downIndex);
  assert.ok(downIndex < events.findIndex(([event]) => event === "rebind"));
});

test("creates the production databases, verifies the image, cleans it before Compose teardown, and rebinds its port", async () => {
  const events: unknown[][] = [];
  const commandCalls: {
    args: readonly string[];
    options?: Record<string, unknown>;
  }[] = [];
  let factoryOptions: Record<string, unknown> | undefined;
  let productionTraceOptions;
  let reboundPorts;
  const publishedPorts = {
    api: 53000,
    jaeger: 56686,
    postgres: 55432,
    web: 55173,
  };
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      events.push(["command", command, ...args]);
      commandCalls.push({ args: [command, ...args], options });
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await runDockerVerification({
    ...verificationDefaults,
    assertPortsCanRebind: async (ports) => {
      reboundPorts = { ...ports };
      events.push(["rebind"]);
    },
    commandRunner,
    createProductionImageVerification(options) {
      factoryOptions = options;
      return {
        async verify() {
          events.push(["production verify"]);
          (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
          await (
            options.onTraceEvidence as (evidence: unknown) => Promise<void>
          )({
            expectedServerSpanName: "GET /auth/callback",
            expectedTraceId: "production-trace-id",
            forbiddenValues: ["production-secret-probe"],
            requestId: "production-request-id",
          });
          return { apiPort: 55129 };
        },
        async cleanup() {
          events.push(["production cleanup"]);
        },
      };
    },
    discoverPort: (service: string) =>
      Promise.resolve((publishedPorts as Record<string, number>)[service] ?? 0),
    signalTarget: new EventEmitter(),
    waitForJaegerTrace: async (options) => {
      productionTraceOptions = options;
      return { traceID: options.expectedTraceId };
    },
  });

  const commands = events
    .filter(([type]) => type === "command")
    .map(([, ...command]) => command);
  const createImageDatabase = [
    "docker",
    "compose",
    "-p",
    "hono-starter-kit-test-1234-a1b2c3d4e5f60708",
    "--profile",
    "tools",
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "starter",
    "starter_image",
  ];
  const createUnmigratedDatabase = [
    "docker",
    "compose",
    "-p",
    "hono-starter-kit-test-1234-a1b2c3d4e5f60708",
    "--profile",
    "tools",
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "starter",
    "starter_unmigrated",
  ];
  assert.ok(
    commands.some(
      (command) => inspect(command) === inspect(createImageDatabase),
    ),
  );
  assert.ok(
    commands.some(
      (command) => inspect(command) === inspect(createUnmigratedDatabase),
    ),
  );
  const productionVerifyIndex = events.findIndex(
    ([event]) => event === "production verify",
  );
  for (const databaseName of ["starter_image", "starter_unmigrated"]) {
    assert.ok(
      events.findIndex((event) => event.includes(databaseName)) <
        productionVerifyIndex,
    );
  }
  const productionCleanupIndex = events.findIndex(
    ([event]) => event === "production cleanup",
  );
  const composeDownIndex = events.findIndex((event) => event.includes("down"));
  assert.ok(productionVerifyIndex < productionCleanupIndex);
  assert.ok(productionCleanupIndex < composeDownIndex);
  assert.ok(
    composeDownIndex < events.findIndex(([event]) => event === "rebind"),
  );
  assert.deepEqual(reboundPorts, {
    ...publishedPorts,
    productionApi: 55129,
  });
  assert.equal(factoryOptions?.commandRunner, commandRunner);
  assert.equal(factoryOptions?.projectName, verificationDefaults.projectName);
  assert.ok(factoryOptions?.signal instanceof globalThis.AbortSignal);
  assert.deepEqual(productionTraceOptions, {
    expectedServerSpanName: "GET /auth/callback",
    expectedTraceId: "production-trace-id",
    fetchImpl: globalThis.fetch,
    forbiddenValues: ["production-secret-probe"],
    queryOrigin: "http://127.0.0.1:56686",
    requestId: "production-request-id",
    serviceName: "hono-starter-api",
    signal: factoryOptions?.signal,
  });
  const composeDownCallIndex = commandCalls.findIndex(({ args }) =>
    args.includes("down"),
  );
  assert.ok(composeDownCallIndex > 0);
  assert.equal(
    commandCalls
      .slice(0, composeDownCallIndex)
      .every(({ options }) => options?.signal === factoryOptions?.signal),
    true,
    "every normal pre-cleanup command must receive the workflow signal",
  );
  assert.equal(
    commandCalls
      .slice(composeDownCallIndex)
      .every(({ options }) => options?.signal === undefined),
    true,
    "cleanup commands must remain signal-independent",
  );
});

test("combines production verification, production cleanup, and Compose cleanup failures", async () => {
  const productionFailure = new Error("production verification failed");
  const productionCleanupFailure = new Error("production cleanup failed");
  const composeCleanupFailure = new Error("Compose cleanup failed");
  const commandRunner = {
    async run(_command: string, args: readonly string[]) {
      if (args.includes("down")) throw composeCleanupFailure;
      return "";
    },
    terminateActiveChild() {
      return false;
    },
  };

  await assert.rejects(
    runDockerVerification({
      ...verificationDefaults,
      commandRunner,
      createProductionImageVerification: (options) => ({
        async verify() {
          (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
          throw productionFailure;
        },
        async cleanup() {
          throw productionCleanupFailure;
        },
      }),
      discoverPort: (service: string) =>
        Promise.resolve(
          { api: 53000, jaeger: 56686, postgres: 55432, web: 55173 }[service] ??
            0,
        ),
      signalTarget: new EventEmitter(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [
        productionFailure,
        productionCleanupFailure,
        composeCleanupFailure,
      ]);
      assert.ok(error.errors.includes(productionFailure));
      return true;
    },
  );
});

test("rebinds a production API port discovered before verification failure", async () => {
  const productionFailure = new Error("production failed after port discovery");
  let reboundPorts;

  await assert.rejects(
    runDockerVerification({
      ...verificationDefaults,
      assertPortsCanRebind: async (ports) => {
        reboundPorts = { ...ports };
      },
      commandRunner: {
        async run() {
          return "";
        },
        terminateActiveChild() {
          return false;
        },
      },
      createProductionImageVerification: (options) => ({
        async verify() {
          (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
          throw productionFailure;
        },
        async cleanup() {},
      }),
      discoverPort: (service: string) =>
        Promise.resolve(
          { api: 53000, jaeger: 56686, postgres: 55432, web: 55173 }[service] ??
            0,
        ),
      signalTarget: new EventEmitter(),
    }),
    (error) => error === productionFailure,
  );

  assert.deepEqual(reboundPorts, {
    api: 53000,
    jaeger: 56686,
    postgres: 55432,
    productionApi: 55129,
    web: 55173,
  });
});

test("rebinds a production API port discovered before interruption and cleans before re-emitting", async () => {
  const signalTarget = new EventEmitter();
  const events: unknown[][] = [];
  let productionStarted = false;
  let reboundPorts;
  const verification = runDockerVerification({
    ...verificationDefaults,
    assertPortsCanRebind: async (ports) => {
      reboundPorts = { ...ports };
      events.push(["rebind"]);
    },
    commandRunner: {
      async run(_command: string, args: readonly string[]) {
        events.push(["command", ...args]);
        return "";
      },
      terminateActiveChild() {
        return false;
      },
    },
    createProductionImageVerification: (options) => ({
      async verify() {
        productionStarted = true;
        (options.onApiPort as ((port: number) => void) | undefined)?.(55129);
        const abortSignal = options.signal as AbortSignal;
        return new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            // signal.reason は呼び出し側が決める値。包み直すと理由が判別できなくなる。
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      },
      async cleanup() {
        events.push(["production cleanup"]);
      },
    }),
    discoverPort: (service: string) =>
      Promise.resolve(
        { api: 53000, jaeger: 56686, postgres: 55432, web: 55173 }[service] ??
          0,
      ),
    reemitSignal(signal: NodeJS.Signals) {
      events.push(["reemit", signal]);
    },
    signalTarget,
  });
  await waitFor(() => productionStarted);

  signalTarget.emit("SIGTERM");
  await verification;

  assert.deepEqual(reboundPorts, {
    api: 53000,
    jaeger: 56686,
    postgres: 55432,
    productionApi: 55129,
    web: 55173,
  });
  const cleanupIndex = events.findIndex(
    ([event]) => event === "production cleanup",
  );
  const downIndex = events.findIndex((event) => event.includes("down"));
  const rebindIndex = events.findIndex(([event]) => event === "rebind");
  const reemitIndex = events.findIndex(([event]) => event === "reemit");
  assert.ok(cleanupIndex < downIndex);
  assert.ok(downIndex < rebindIndex);
  assert.ok(rebindIndex < reemitIndex);
});
