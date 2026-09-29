import assert from "node:assert/strict";
import console from "node:console";
import { createHash, randomBytes } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createDeadlineSignal,
  raceOperationAgainstSignal,
} from "./docker/abortable-operation.ts";
import {
  appendDistinctFailures,
  assertPortsCanRebind,
  combineFailures,
  createAsyncCommandRunner,
  createInterruptionGuard,
  createOwnedTestDatabase,
  createOwnedTestDatabaseName,
  discoverPublishedPort,
  finishOwnedRun,
  OwnedComposeRunInterrupted,
  tearDownComposeProject,
  type RunCompose,
  type RunOptions,
  type SignalTarget,
} from "./docker/compose-project.ts";
import { waitForJaegerTrace } from "./docker/jaeger-trace.ts";
import { createProductionImageVerification } from "./docker/production-image.ts";
import { createTerraformDockerVerification } from "./docker/terraform-verification.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const servicePorts = [
  { containerPort: 5432, service: "postgres" },
  { containerPort: 3000, service: "api" },
  { containerPort: 5173, service: "web" },
  { containerPort: 16686, service: "jaeger" },
];

export const waitForHttpReady = async ({
  fetchImpl,
  origin,
  signal,
  timeoutMs = 30_000,
}: {
  fetchImpl: typeof globalThis.fetch;
  origin: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  const deadlineSignal = createDeadlineSignal({ signal, timeoutMs });

  const throwTimeout = () => {
    throw new Error("Jaeger UI did not become ready after restart.");
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      if (deadlineSignal.cause() === "deadline") throwTimeout();
      try {
        const response = await raceOperationAgainstSignal(
          () =>
            fetchImpl(new URL("/", origin), {
              signal: deadlineSignal.signal,
            }),
          deadlineSignal.signal,
        );
        if (response.ok) return;
      } catch (error) {
        if (deadlineSignal.cause() === "workflow") {
          throw deadlineSignal.signal.reason;
        }
        if (deadlineSignal.cause() === "deadline") throwTimeout();
        if (signal?.aborted) throw error;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throwTimeout();
      await delay(Math.min(250, remainingMs), undefined, { signal });
    }
  } finally {
    deadlineSignal.dispose();
  }
};

const generatedProjectIdPattern =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/iu;

const randomNonZeroHex = (byteLength: number) => {
  let value: string;
  do {
    value = randomBytes(byteLength).toString("hex");
  } while (/^0+$/u.test(value));
  return value;
};

export const assertGeneratedProjectId = (projectId: string) => {
  if (!generatedProjectIdPattern.test(projectId)) {
    throw new Error("Created Project ID did not match generated format.");
  }
};

export const cookiePairFrom = (response: Response) => {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "login must set a session cookie");
  return setCookie.split(";", 1)[0] ?? "";
};

const queryAuthTablesThroughCompose = async (
  runCompose: RunCompose,
): Promise<unknown> => {
  const output = await runCompose(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "starter",
      "-d",
      "starter",
      "--tuples-only",
      "--no-align",
      "--command",
      `select json_build_object(
        'users', coalesce((select json_agg(row_to_json(users)) from users), '[]'::json),
        'userIdentities', coalesce((select json_agg(row_to_json(user_identities)) from user_identities), '[]'::json),
        'sessions', coalesce((select json_agg(row_to_json(sessions)) from sessions), '[]'::json)
      )::text`,
    ],
    { capture: true },
  );
  return JSON.parse(typeof output === "string" ? output : "");
};

// contracts はビルド済み dist から動的 import する。ここで使うのは parse だけで、
// 戻り値の形は呼び出しごとに読む側が確かめる。
type ContractSchema = { parse(value: unknown): Record<string, unknown> };

export const verifyAuthenticatedFlowThroughWeb = async ({
  fetchImpl = globalThis.fetch,
  log,
  onTraceEvidence = () => Promise.resolve(),
  queryAuthTables,
  signal,
  webPort,
}: {
  fetchImpl?: typeof globalThis.fetch;
  log: (message: string) => void;
  onTraceEvidence?: (evidence: unknown) => Promise<void>;
  queryAuthTables: (context: {
    cookiePair: string;
    cookieValue: string;
    setCookie: string;
  }) => Promise<unknown>;
  signal?: AbortSignal | undefined;
  webPort: number;
}) => {
  const contractsUrl = pathToFileURL(
    `${repositoryRoot}/packages/contracts/dist/index.js`,
  );
  const {
    listProjectsResponseSchema,
    meResponseSchema,
    problemSchema,
    projectDtoSchema,
  } = (await import(contractsUrl.href)) as {
    listProjectsResponseSchema: ContractSchema;
    meResponseSchema: ContractSchema;
    problemSchema: ContractSchema;
    projectDtoSchema: ContractSchema;
  };
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const fetchThroughWeb = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${webOrigin}${path}`, {
      ...init,
      ...(signal === undefined ? {} : { signal }),
    });
  const parseJson = (response: Response): Promise<unknown> => response.json();
  const expectProject = async (response: Response, status: number) => {
    assert.equal(response.status, status);
    return projectDtoSchema.parse(await parseJson(response));
  };
  const expectProblem = async (
    response: Response,
    status: number,
    code: string,
  ) => {
    assert.equal(response.status, status);
    const problem = problemSchema.parse(await parseJson(response));
    assert.equal(problem.code, code);
    assert.equal(problem.status, status);
    return problem;
  };

  const unauthenticatedProjects = await fetchThroughWeb("/api/projects");
  assert.equal(unauthenticatedProjects.status, 401);
  log("Rejected unauthenticated Projects request through Web");

  const loginResponse = await fetchThroughWeb(
    "/auth/login?returnTo=/projects",
    { redirect: "manual" },
  );
  assert.equal(loginResponse.status, 303);
  assert.equal(loginResponse.headers.get("location"), "/projects");
  const setCookie = loginResponse.headers.get("set-cookie");
  assert.ok(
    /(?:^|;)\s*HttpOnly(?:;|$)/iu.test(setCookie ?? ""),
    "login cookie must be HttpOnly",
  );
  assert.ok(
    /(?:^|;)\s*SameSite=Lax(?:;|$)/iu.test(setCookie ?? ""),
    "login cookie must use SameSite=Lax",
  );
  const cookiePair = cookiePairFrom(loginResponse);
  const separatorIndex = cookiePair.indexOf("=");
  assert.ok(separatorIndex > 0, "login cookie must contain a name and value");
  const cookieValue = cookiePair.slice(separatorIndex + 1);
  assert.notEqual(cookieValue, "", "login cookie value must not be empty");
  log("Established Dev login through Web with HttpOnly SameSite cookie");

  const authenticatedRequest = (path: string, init: RequestInit = {}) => {
    const headers = new globalThis.Headers(init.headers);
    headers.set("Cookie", cookiePair);
    if (init.method === "POST" || init.method === "PATCH") {
      headers.set("Origin", webOrigin);
    }
    return fetchThroughWeb(path, { ...init, headers });
  };

  const meResponse = await authenticatedRequest("/api/me");
  assert.equal(meResponse.status, 200);
  const me = meResponseSchema.parse(await parseJson(meResponse));
  assert.deepEqual(
    {
      displayName: (me.user as Record<string, unknown>).displayName,
      email: (me.user as Record<string, unknown>).email,
      roles: (me.user as Record<string, unknown>).roles,
    },
    {
      displayName: "Local Developer",
      email: "developer@starter.local",
      roles: ["projects:read", "projects:write"],
    },
  );

  const initialListResponse = await authenticatedRequest("/api/projects");
  assert.equal(initialListResponse.status, 200);
  const initialList = listProjectsResponseSchema.parse(
    await parseJson(initialListResponse),
  );
  const alpha = (initialList.items as { id: string }[]).find(
    (project) => project.id === "project_alpha",
  );
  assert.deepEqual(alpha, {
    id: "project_alpha",
    name: "Alpha",
    status: "active",
    version: 1,
    updatedAt: "2026-08-03T00:00:00.000Z",
  });

  const expectedTraceId = randomNonZeroHex(16);
  const parentSpanId = randomNonZeroHex(8);
  const createdResponse = await authenticatedRequest("/api/projects", {
    body: JSON.stringify({ name: "Docker Created" }),
    headers: {
      Authorization: "Bearer AUTH_PROBE_DO_NOT_EXPORT",
      "Content-Type": "application/json",
      traceparent: `00-${expectedTraceId}-${parentSpanId}-01`,
    },
    method: "POST",
  });
  const created = await expectProject(createdResponse, 201);
  const requestId = createdResponse.headers.get("x-request-id");
  assert.ok(requestId, "create response must include X-Request-Id");
  assertGeneratedProjectId(created.id as string);
  assert.equal(
    createdResponse.headers.get("location"),
    `/api/projects/${encodeURIComponent(created.id as string)}`,
  );
  assert.equal(created.name, "Docker Created");
  assert.equal(created.status, "active");
  assert.equal(created.version, 1);

  try {
    await onTraceEvidence({
      // SERVER span の名前は observer が渡した route で決まる。上の作成要求がこの route に当たる。
      expectedServerSpanName: "POST /api/projects",
      expectedTraceId,
      forbiddenValues: [
        setCookie,
        cookiePair,
        cookieValue,
        "Bearer AUTH_PROBE_DO_NOT_EXPORT",
        "Docker Created",
      ],
      requestId,
    });
  } catch {
    throw new Error("Trace evidence verification failed.");
  }

  const createdPath = `/api/projects/${encodeURIComponent(created.id as string)}`;
  const fetchedCreated = await expectProject(
    await authenticatedRequest(createdPath),
    200,
  );
  assert.deepEqual(fetchedCreated, created);

  const renamed = await expectProject(
    await authenticatedRequest(createdPath, {
      body: JSON.stringify({ name: "Docker Renamed", version: 1 }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }),
    200,
  );
  assert.equal(renamed.name, "Docker Renamed");
  assert.equal(renamed.status, "active");
  assert.equal(renamed.version, 2);

  await expectProblem(
    await authenticatedRequest(createdPath, {
      body: JSON.stringify({ name: "Stale Write", version: 1 }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }),
    409,
    "PROJECT_VERSION_CONFLICT",
  );

  const afterStaleWrite = await expectProject(
    await authenticatedRequest(createdPath),
    200,
  );
  assert.deepEqual(afterStaleWrite, renamed);

  const archived = await expectProject(
    await authenticatedRequest(`${createdPath}/archive`, {
      body: JSON.stringify({ version: 2 }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
    200,
  );
  assert.equal(archived.name, "Docker Renamed");
  assert.equal(archived.status, "archived");
  assert.equal(archived.version, 3);

  await expectProblem(
    await authenticatedRequest(createdPath, {
      body: JSON.stringify({ name: "After Archive", version: 3 }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }),
    409,
    "PROJECT_ARCHIVED",
  );

  const finalListResponse = await authenticatedRequest("/api/projects");
  assert.equal(finalListResponse.status, 200);
  const finalList = listProjectsResponseSchema.parse(
    await parseJson(finalListResponse),
  );
  const archivedProject = (finalList.items as { id: string }[]).find(
    (project) => project.id === created.id,
  );
  assert.deepEqual(archivedProject, archived);
  log(
    `Validated authenticated Projects CRUD through Web on 127.0.0.1:${webPort}`,
  );

  const authTables = await queryAuthTables({
    cookiePair,
    cookieValue,
    setCookie: setCookie ?? "",
  });
  const expectedIdHash = createHash("sha256")
    .update(cookieValue, "utf8")
    .digest("hex");
  // psql が返す JSON。読む項目だけを形として与える。
  const tables = authTables as {
    sessions: { id_hash: string; revoked_at: unknown }[];
  };
  const storedSession = tables.sessions.find(
    (session) => session.id_hash === expectedIdHash,
  );
  assert.ok(storedSession, "database must contain the login session hash");
  assert.equal(storedSession.revoked_at, null);
  assert.match(storedSession.id_hash, /^[0-9a-f]{64}$/u);
  const serializedAuthTables = JSON.stringify(authTables);
  assert.equal(
    serializedAuthTables.includes(setCookie ?? ""),
    false,
    "auth tables must not contain the full Set-Cookie header",
  );
  assert.equal(
    serializedAuthTables.includes(cookieValue),
    false,
    "auth tables must not contain raw session cookie material",
  );
  log("Validated active PostgreSQL session hash without raw cookie material");

  const logoutResponse = await authenticatedRequest("/auth/logout", {
    method: "POST",
  });
  assert.equal(logoutResponse.status, 204);
  const clearCookie = logoutResponse.headers.get("set-cookie");
  assert.ok(
    /(?:^|;)\s*Max-Age=0(?:;|$)/iu.test(clearCookie ?? ""),
    "logout must clear the session cookie",
  );

  for (const path of ["/api/me", "/api/projects"]) {
    const oldCookieResponse = await authenticatedRequest(path);
    assert.equal(oldCookieResponse.status, 401);
  }
  log("Validated logout and old-cookie rejection through Web");
};

const failureLabel = "Docker verification and cleanup";
const ownedProjectPattern = /^hono-starter-kit-test-[1-9][0-9]*-[a-f0-9]{16}$/u;

export const runDockerVerification = async ({
  assertPortsCanRebind: assertPorts = (ports: Record<string, number>) =>
    assertPortsCanRebind(ports, log),
  commandRunner = createAsyncCommandRunner(),
  composeEnvironment,
  createdbRetryDelayMs,
  createProductionImageVerification:
    createProductionVerification = createProductionImageVerification,
  createTerraformDockerVerification:
    createTerraformVerification = createTerraformDockerVerification,
  discoverPort,
  fetchImpl = globalThis.fetch,
  hostEnvironment = process.env,
  log = (message: string) => {
    console.log(message);
  },
  projectName,
  reemitSignal = (signal: NodeJS.Signals) => process.kill(process.pid, signal),
  reportFailure = (failure: unknown) => {
    console.error(failure);
  },
  signalTarget = process,
  testDatabaseName,
  verifyAuthenticatedFlowThroughWeb: verifyAuthenticatedFlow = (
    webPort: number,
    signal: AbortSignal | undefined,
    queryAuthTables: Parameters<
      typeof verifyAuthenticatedFlowThroughWeb
    >[0]["queryAuthTables"],
    onTraceEvidence: (evidence: unknown) => Promise<void>,
  ) =>
    verifyAuthenticatedFlowThroughWeb({
      log,
      onTraceEvidence,
      queryAuthTables,
      signal,
      webPort,
    }),
  waitForJaegerReady: waitForReady = ({
    queryOrigin,
    signal,
  }: {
    queryOrigin: string;
    signal?: AbortSignal | undefined;
  }) => waitForHttpReady({ fetchImpl, origin: queryOrigin, signal }),
  waitForJaegerTrace: waitForTrace = waitForJaegerTrace,
}: {
  assertPortsCanRebind?: (ports: Record<string, number>) => Promise<void>;
  commandRunner?: ReturnType<typeof createAsyncCommandRunner>;
  composeEnvironment?: NodeJS.ProcessEnv | undefined;
  createdbRetryDelayMs?: number;
  createProductionImageVerification?: typeof createProductionImageVerification;
  createTerraformDockerVerification?: typeof createTerraformDockerVerification;
  // undefined を明示して既定の探索へ戻す呼び出しがあるので、省略と undefined の両方を受ける。
  discoverPort?:
    | ((
        service: string,
        containerPort: number,
        runCompose: RunCompose,
      ) => Promise<number>)
    | undefined;
  fetchImpl?: typeof globalThis.fetch;
  hostEnvironment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  projectName: string;
  reemitSignal?: (signal: NodeJS.Signals) => void;
  reportFailure?: (failure: unknown) => void;
  signalTarget?: SignalTarget;
  /** db-test が接続する、所有する postgres の中に作る DB。guard はこの名前以外を拒否する。 */
  testDatabaseName: string;
  verifyAuthenticatedFlowThroughWeb?: (
    webPort: number,
    signal: AbortSignal | undefined,
    queryAuthTables: Parameters<
      typeof verifyAuthenticatedFlowThroughWeb
    >[0]["queryAuthTables"],
    onTraceEvidence: (evidence: unknown) => Promise<void>,
  ) => Promise<void>;
  waitForJaegerReady?: (options: {
    queryOrigin: string;
    signal?: AbortSignal | undefined;
  }) => Promise<void>;
  waitForJaegerTrace?: typeof waitForJaegerTrace;
}) => {
  // 片付けは down -v --rmi local を project 名だけを頼りに実行する。既定の project（開発用の
  // スタック）に向かないよう、所有する形の名前でなければ何も始めない。
  if (!ownedProjectPattern.test(projectName)) {
    throw new Error(
      "Refusing to run Docker verification without an owned hono-starter-kit-test project name.",
    );
  }
  const ports: Record<string, number> = {};
  // -p と合わせて環境変数でも project を示す。db-test の STARTER_DATABASE_TEST_PROJECT は
  // compose.yaml の ${COMPOSE_PROJECT_NAME} から作られる。
  const ownedComposeEnvironment: NodeJS.ProcessEnv = {
    ...composeEnvironment,
    COMPOSE_PROJECT_NAME: projectName,
    STARTER_DATABASE_TEST_NAME: testDatabaseName,
  };
  const createdServices = new Set<string>();
  const failures: unknown[] = [];
  let jaegerStopped = false;
  let productionVerification:
    ReturnType<typeof createProductionImageVerification> | undefined;
  let terraformVerification:
    ReturnType<typeof createTerraformDockerVerification> | undefined;
  const interruption = createInterruptionGuard({ commandRunner, signalTarget });

  const runRaw = (
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ) => commandRunner.run(command, args, options);
  const runComposeRaw = (args: readonly string[], options?: RunOptions) =>
    runRaw(
      "docker",
      ["compose", "-p", projectName, "--profile", "tools", ...args],
      {
        ...options,
        environment: ownedComposeEnvironment,
      },
    );
  const runWorkflow = async (
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ) => {
    interruption.throwIfInterrupted();
    const output = await runRaw(command, args, {
      ...options,
      signal: interruption.signal,
    });
    interruption.throwIfInterrupted();
    return output;
  };
  const runComposeWorkflow = (args: readonly string[], options?: RunOptions) =>
    runWorkflow(
      "docker",
      ["compose", "-p", projectName, "--profile", "tools", ...args],
      {
        ...options,
        environment: ownedComposeEnvironment,
      },
    );
  const findPort = (
    service: string,
    containerPort: number,
    runCompose: RunCompose,
  ) =>
    discoverPort === undefined
      ? discoverPublishedPort({ containerPort, log, runCompose, service })
      : discoverPort(service, containerPort, runCompose);

  log(`Using isolated Compose project ${projectName}`);

  try {
    try {
      terraformVerification = createTerraformVerification({
        commandRunner,
        log,
        onCleanupStart: () => {
          interruption.startCleanup();
        },
        projectName: `hono-starter-kit-terraform-test-${createHash("sha256")
          .update(projectName)
          .digest("hex")
          .slice(0, 16)}`,
        signal: interruption.signal,
      });
      await terraformVerification.verify();

      await runWorkflow("pnpm", ["--filter", "@starter/contracts", "build"], {
        environment: hostEnvironment,
      });
      await runComposeWorkflow(["build"]);

      createdServices.add("postgres");
      await runComposeWorkflow(["up", "-d", "--wait", "postgres"]);
      ports.postgres = await findPort("postgres", 5432, runComposeWorkflow);

      await runComposeWorkflow(["run", "--rm", "--no-deps", "deps"]);
      await createOwnedTestDatabase({
        databaseName: testDatabaseName,
        log,
        ...(createdbRetryDelayMs === undefined
          ? {}
          : { retryDelayMs: createdbRetryDelayMs }),
        runCompose: runComposeWorkflow,
        signal: interruption.signal,
      });
      await runComposeWorkflow(["run", "--rm", "--no-deps", "db-test"]);
      // db-test は専用の DB で動き、api と web が使う starter DB には触れない。
      // その starter DB の schema と seed は、ここで用意する。
      await runComposeWorkflow(["run", "--rm", "--no-deps", "migrate"]);
      await runComposeWorkflow(["run", "--rm", "--no-deps", "seed"]);

      createdServices.add("jaeger");
      await runComposeWorkflow(["up", "-d", "--wait", "--no-deps", "jaeger"]);
      ports.jaeger = await findPort("jaeger", 16686, runComposeWorkflow);

      createdServices.add("api");
      await runComposeWorkflow(["up", "-d", "--wait", "--no-deps", "api"]);
      ports.api = await findPort("api", 3000, runComposeWorkflow);

      createdServices.add("web");
      await runComposeWorkflow(["up", "-d", "--wait", "--no-deps", "web"]);
      ports.web = await findPort("web", 5173, runComposeWorkflow);
      ownedComposeEnvironment.API_PORT = String(ports.api);
      ownedComposeEnvironment.WEB_PORT = String(ports.web);
      await runComposeWorkflow([
        "up",
        "-d",
        "--wait",
        "--no-deps",
        "--force-recreate",
        "api",
      ]);
      log(`Configured API Origin for Web on 127.0.0.1:${ports.web}`);
      let authenticatedFlowFailure;
      try {
        await Promise.race([
          verifyAuthenticatedFlow(
            ports.web,
            interruption.signal,
            () => queryAuthTablesThroughCompose(runComposeWorkflow),
            async (evidence: unknown) => {
              const {
                expectedServerSpanName,
                expectedTraceId,
                forbiddenValues,
                requestId,
              } = evidence as {
                expectedServerSpanName: string;
                expectedTraceId: string;
                forbiddenValues: readonly unknown[];
                requestId: string;
              };
              const trace = await waitForTrace({
                expectedServerSpanName,
                expectedTraceId,
                fetchImpl,
                forbiddenValues,
                queryOrigin: `http://127.0.0.1:${ports.jaeger}`,
                requestId,
                serviceName: "hono-starter-api",
                signal: interruption.signal,
              });
              log(
                `Validated Jaeger trace ${String(trace.traceID)} for Request ID ${requestId}`,
              );

              await runComposeWorkflow(["stop", "jaeger"]);
              jaegerStopped = true;
              const healthResponse = await fetchImpl(
                `http://127.0.0.1:${ports.api}/healthz`,
                { signal: interruption.signal },
              );
              assert.equal(
                healthResponse.status,
                200,
                "API health must return 200 while Jaeger is stopped",
              );
            },
          ),
          interruption.interruption.then((signal) => {
            throw new OwnedComposeRunInterrupted(signal);
          }),
        ]);
      } catch (error) {
        authenticatedFlowFailure = error;
      }

      if (jaegerStopped && interruption.receivedSignal() === undefined) {
        try {
          ports.jaegerBeforeRestart = ports.jaeger;
          delete ports.jaeger;
          await runComposeWorkflow(["start", "jaeger"]);
          ports.jaeger = await findPort("jaeger", 16686, runComposeWorkflow);
          await waitForReady({
            queryOrigin: `http://127.0.0.1:${ports.jaeger}`,
            signal: interruption.signal,
          });
          jaegerStopped = false;
        } catch (restartFailure) {
          throw combineFailures(
            [authenticatedFlowFailure, restartFailure].filter(
              (failure) => failure !== undefined,
            ),
            failureLabel,
          );
        }
      }
      if (authenticatedFlowFailure !== undefined) {
        // 元の失敗をそのまま伝える。包み直すと呼び出し側の判定が崩れる。
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw authenticatedFlowFailure;
      }

      await runComposeWorkflow([
        "exec",
        "-T",
        "postgres",
        "createdb",
        "-U",
        "starter",
        "starter_image",
      ]);
      await runComposeWorkflow([
        "exec",
        "-T",
        "postgres",
        "createdb",
        "-U",
        "starter",
        "starter_unmigrated",
      ]);
      log("Created owned production image verification databases");

      productionVerification = createProductionVerification({
        commandRunner,
        fetchImpl,
        log,
        onApiPort: (apiPort) => {
          ports.productionApi = apiPort;
        },
        onTraceEvidence: async (evidence: unknown) => {
          const {
            expectedServerSpanName,
            expectedTraceId,
            forbiddenValues,
            requestId,
          } = evidence as {
            expectedServerSpanName: string;
            expectedTraceId: string;
            forbiddenValues: readonly unknown[];
            requestId: string;
          };
          const trace = await waitForTrace({
            expectedServerSpanName,
            expectedTraceId,
            fetchImpl,
            forbiddenValues,
            queryOrigin: `http://127.0.0.1:${ports.jaeger}`,
            requestId,
            serviceName: "hono-starter-api",
            signal: interruption.signal,
          });
          log(
            `Validated production OIDC trace ${String(trace.traceID)} for Request ID ${requestId}`,
          );
        },
        projectName,
        signal: interruption.signal,
      });
      const productionResult = (await productionVerification.verify()) as {
        apiPort: number;
      };
      assert.equal(
        productionResult.apiPort,
        ports.productionApi,
        "Production image verification must return its published API port",
      );
    } catch (error) {
      if (interruption.receivedSignal() === undefined) failures.push(error);
    } finally {
      interruption.startCleanup();

      if (terraformVerification !== undefined) {
        try {
          await terraformVerification.cleanup();
        } catch (error) {
          appendDistinctFailures(failures, error);
        }
      }

      if (productionVerification !== undefined) {
        try {
          await productionVerification.cleanup();
        } catch (error) {
          appendDistinctFailures(failures, error);
        }
      }

      for (const { containerPort, service } of servicePorts) {
        if (!createdServices.has(service) || ports[service] !== undefined) {
          continue;
        }
        try {
          ports[service] = await findPort(
            service,
            containerPort,
            runComposeRaw,
          );
        } catch (error) {
          log(
            `Unable to discover ${service} port before cleanup: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      await tearDownComposeProject({
        assertPortsCanRebind: assertPorts,
        failures,
        log,
        ports,
        projectName,
        removeLocalImages: true,
        runCompose: runComposeRaw,
      });
    }
  } finally {
    interruption.dispose();
  }

  finishOwnedRun({
    failures,
    label: failureLabel,
    receivedSignal: interruption.receivedSignal(),
    reemitSignal,
    reportFailure,
  });
};

// project 名と DB 名の乱数は別々に取る。片方が分かっても、もう片方を推測できないようにする。
export const createDockerVerificationEnvironment = ({
  hostEnvironment,
  pid,
}: {
  hostEnvironment: NodeJS.ProcessEnv;
  pid: number;
}) => {
  const projectName = `hono-starter-kit-test-${pid}-${randomBytes(8).toString("hex")}`;
  const testDatabaseName = createOwnedTestDatabaseName();
  const composeEnvironment: NodeJS.ProcessEnv = {
    ...hostEnvironment,
    API_PORT: "0",
    COMPOSE_PROJECT_NAME: projectName,
    JAEGER_UI_PORT: "0",
    POSTGRES_PORT: "0",
    STARTER_DATABASE_TEST_NAME: testDatabaseName,
    WEB_PORT: "0",
  };
  return { composeEnvironment, projectName, testDatabaseName };
};

const main = async () => {
  await runDockerVerification(
    createDockerVerificationEnvironment({
      hostEnvironment: process.env,
      pid: process.pid,
    }),
  );
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
