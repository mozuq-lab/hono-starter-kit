import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { clearTimeout, setTimeout } from "node:timers";
import { inspect, promisify } from "node:util";

import type { RuntimeSnapshot } from "../schemas.ts";
import test from "node:test";

import * as productionImage from "./production-image.ts";
import {
  createRuntimeSnapshotScript,
  inspectRuntimeImage,
  parseRuntimeSnapshot,
  runtimeSnapshotScript,
  validateRuntimeSnapshot,
} from "./runtime-image-inspection.ts";

const execFile = promisify(execFileCallback);

const projectName = "hono-starter-kit-test-4321-a1b2c3d4e5f60708";
const imageTag = `${projectName}-api:verify`;
const apiContainerName = `${projectName}-api-image`;
const databaseContainerName = `${projectName}-api-postgres-tls`;
const oneShotContainerNames = Object.freeze({
  migration: `${projectName}-api-migrate`,
  runtimeInspection: `${projectName}-api-runtime-inspection`,
  devAuth: `${projectName}-api-fail-dev-auth`,
  httpIssuer: `${projectName}-api-fail-http-issuer`,
  testEnvironment: `${projectName}-api-fail-test-environment`,
  unmigrated: `${projectName}-api-fail-unmigrated`,
  tlsHostname: `${projectName}-api-fail-tls-hostname`,
  missingDatabaseUrl: `${projectName}-api-fail-missing-database-url`,
});
const exactContainerNames = [
  apiContainerName,
  databaseContainerName,
  ...Object.values(oneShotContainerNames),
];
const networkName = `${projectName}_default`;
const databaseCaCertificatePath = "/tmp/hono-starter-postgres-tls-owned/ca.pem";
const containerDatabaseCaCertificatePath = "/run/postgres-ca/ca.pem";
const fixtureDatabasePasswordProbe = "unit-database-password-probe";
const expectedRdsCaSha256 = (
  await readFile(
    new URL("../../docker/certs/global-bundle.pem.sha256", import.meta.url),
    "utf8",
  )
)
  .trim()
  .split(/\s+/u)[0];
const productionAppOrigin = "https://d111111abcdef8.cloudfront.net";
const apiPort = 55129;
const fixtureIssuer = "https://host.docker.internal:44771";
const fixtureCaCertificatePath =
  "/tmp/hono-starter-oidc-tls-owned/ca-certificate.pem";
const fixtureTokenProbe = "unit-token-probe";
const fixturePasswordProbe = "unit-password-probe";
const fixtureStateProbe = "s".repeat(43);
const fixtureNonceProbe = "n".repeat(43);
const fixtureVerifierProbe = "v".repeat(43);
const fixtureCodeProbe = "unit-code-probe";
const fixtureSessionCookie = `__Host-session=${"c".repeat(43)}`;
const fixtureTransactionCookie = `__Secure-oidc-transaction=${Buffer.from(
  JSON.stringify({ nonce: fixtureNonceProbe, verifier: fixtureVerifierProbe }),
).toString("base64url")}`;
const testEnvironmentRejection =
  "API startup failed: NODE_ENV=test requires development-only fixtures that are excluded from the production runtime bundle";
const runtimeDependencyNames = [
  "@aws-sdk/client-secrets-manager",
  "@opentelemetry/api",
  "@opentelemetry/core",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/instrumentation-pg",
  "@opentelemetry/sdk-node",
  "pg",
];
const {
  createProductionImageVerification: createProductionImageVerificationImpl,
  createProductionOidcFixtureEnvironment,
  requestCallbackThroughLocalOrigin,
} = productionImage;

test("the production Dockerfile force-builds API project references before the runtime bundle", async () => {
  const dockerfile = await readFile(
    new URL("../../docker/api.Dockerfile", import.meta.url),
    "utf8",
  );

  assert.match(
    dockerfile,
    /RUN pnpm exec tsc -b --force apps\/api-node && node scripts\/build-api-runtime\.ts/u,
  );
});

test("the production Dockerfile copies only scripts that exist in the repository", async () => {
  // scripts/ の改名は pnpm check では Dockerfile に届かない。COPY 元の実在を
  // ここで固定し、Docker ビルドまで待たずに取りこぼしを検出する。
  const dockerfile = await readFile(
    new URL("../../docker/api.Dockerfile", import.meta.url),
    "utf8",
  );
  const copiedScripts = [
    ...dockerfile.matchAll(/^COPY (scripts\/\S+) /gmu),
  ].map(([, source]) => source);

  assert.ok(
    copiedScripts.length > 0,
    "expected the Dockerfile to COPY a scripts/ file",
  );
  for (const source of copiedScripts) {
    const sourceStat = await stat(new URL(`../../${source}`, import.meta.url));
    assert.ok(
      sourceStat.isFile(),
      `${source} is copied by the Dockerfile but does not exist`,
    );
  }
});

test("the runtime snapshot script runs standalone with only Node built-ins", async (t) => {
  // コンテナには zod も scripts/schemas.ts もない。関数を toString() で持ち込む以上、
  // ホスト側モジュールの値を閉包で参照していればここで ReferenceError になる。
  // RDS CA のプローブはフィクスチャの証明書を実際に書き換えるため、比較用のホスト内
  // 実行には別のフィクスチャを使い、appRoot（macOS では realpath も別）を正規化する。
  const normalize = async (snapshot: unknown, appRoot: string) => {
    let text = JSON.stringify(snapshot);
    for (const root of new Set([appRoot, await realpath(appRoot)])) {
      text = text.replaceAll(root, "<appRoot>");
    }
    return JSON.parse(text) as unknown;
  };
  const standaloneRoot = await createRuntimeFilesystem(t);
  const inProcessRoot = await createRuntimeFilesystem(t);

  const { stdout } = await execFile(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      createRuntimeSnapshotScript({ appRoot: standaloneRoot }),
    ],
    { encoding: "utf8" },
  );

  assert.deepEqual(
    await normalize(parseRuntimeSnapshot(stdout), standaloneRoot),
    await normalize(
      await inspectRuntimeImage({ appRoot: inProcessRoot }),
      inProcessRoot,
    ),
  );
});

test("serializes an explicit process binding for the runtime snapshot", () => {
  assert.match(runtimeSnapshotScript, /import process from "node:process";/u);
});

test("the callback transport uses the proxy origin-form target and internal Host", async (t) => {
  let requestUrl;
  let requestHost;
  const server = createServer((request, response) => {
    requestUrl = request.url;
    requestHost = request.headers.host;
    assert.equal(request.headers.cookie, fixtureTransactionCookie);
    response.statusCode = 303;
    response.setHeader("Location", "/projects");
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const callbackUrl = new URL(
    `${productionAppOrigin}/auth/callback?code=code&state=state`,
  );

  const response = await requestCallbackThroughLocalOrigin({
    callbackUrl,
    headers: new globalThis.Headers({ Cookie: fixtureTransactionCookie }),
    origin: `http://127.0.0.1:${address.port}`,
    signal: new globalThis.AbortController().signal,
  });

  assert.equal(requestUrl, "/auth/callback?code=code&state=state");
  assert.equal(requestHost, `127.0.0.1:${address.port}`);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/projects");
});

const createOidcFixtureEnvironment = () =>
  Promise.resolve({
    authorize: (authorizationUrl: URL) => {
      const callback = new URL(`${productionAppOrigin}/auth/callback`);
      callback.searchParams.set("code", fixtureCodeProbe);
      callback.searchParams.set(
        "state",
        authorizationUrl.searchParams.get("state") ?? "missing-state",
      );
      return Promise.resolve(callback);
    },
    caCertificatePath: fixtureCaCertificatePath,
    cleanup: () => Promise.resolve(undefined),
    clientId: "fixture-public-client",
    issuer: fixtureIssuer,
    logoutEndpoint: `${fixtureIssuer}/logout`,
    passwordProbe: fixturePasswordProbe,
    tokenProbe: fixtureTokenProbe,
  });

const createDatabaseTlsEnvironment = () =>
  Promise.resolve(
    Object.freeze({
      caCertificatePath: databaseCaCertificatePath,
      cleanup: () => Promise.resolve(undefined),
      host: "postgres-tls",
      mismatchHost: "postgres-tls-mismatch",
      password: fixtureDatabasePasswordProbe,
      port: "5432",
      user: "starter",
    }),
  );

const structuredDatabaseArguments = ({
  database = "starter_image",
  host = "postgres-tls",
  password = fixtureDatabasePasswordProbe,
} = {}) => [
  "--volume",
  `${databaseCaCertificatePath}:${containerDatabaseCaCertificatePath}:ro`,
  "-e",
  `PGHOST=${host}`,
  "-e",
  "PGPORT=5432",
  "-e",
  `PGDATABASE=${database}`,
  "-e",
  "PGUSER=starter",
  "-e",
  `PGPASSWORD=${password}`,
  "-e",
  `PGSSLROOTCERT=${containerDatabaseCaCertificatePath}`,
];

const redactStructuredDatabasePassword = (args: readonly unknown[]) =>
  args.map((argument) => {
    if (typeof argument !== "string") return argument;
    if (argument.startsWith("PGPASSWORD=")) return "PGPASSWORD=[REDACTED]";
    if (argument.startsWith("DATABASE_URL=")) {
      return "DATABASE_URL=[REDACTED]";
    }
    return argument.replaceAll(fixtureDatabasePasswordProbe, "[REDACTED]");
  });

const assertStructuredDatabaseCommand = (
  actual: readonly unknown[],
  expected: readonly unknown[],
) => {
  assert.deepEqual(
    redactStructuredDatabasePassword(actual),
    redactStructuredDatabasePassword(expected),
  );
};

test("structured database command assertion diagnostics redact the password canary", () => {
  assert.throws(
    () =>
      assertStructuredDatabaseCommand(
        [
          `PGPASSWORD=${fixtureDatabasePasswordProbe}`,
          `DATABASE_URL=postgresql://starter:${fixtureDatabasePasswordProbe}@postgres-tls:5432/starter_image`,
          `UNEXPECTED_DATABASE_ARGUMENT=prefix-${fixtureDatabasePasswordProbe}-suffix`,
          "PGHOST=postgres-tls",
        ],
        [
          "PGPASSWORD=different-password",
          "DATABASE_URL=postgresql://starter:different-password@postgres-tls:5432/starter_image",
          "UNEXPECTED_DATABASE_ARGUMENT=prefix-different-password-suffix",
          "PGHOST=unexpected-host",
        ],
      ),
    (error) => {
      const diagnostic = inspect(error);
      assert.equal(diagnostic.includes(fixtureDatabasePasswordProbe), false);
      assert.equal(diagnostic.includes("DATABASE_URL=postgresql://"), false);
      assert.equal(diagnostic.includes("PGHOST=postgres-tls"), true);
      assert.equal(diagnostic.includes("PGHOST=unexpected-host"), true);
      return true;
    },
  );
});

type VerificationImplOptions = Parameters<
  typeof createProductionImageVerificationImpl
>[0];

const createProductionImageVerification = (
  options: Omit<Partial<VerificationImplOptions>, "commandRunner"> & {
    callbackRequests?: { callbackUrl: URL | string; origin: string }[];
    commandRunner: VerificationImplOptions["commandRunner"];
    projectName: string;
  },
) => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return createProductionImageVerificationImpl({
    createDatabaseTlsEnvironment,
    createOidcFixtureEnvironment,
    requestCallback:
      options.requestCallback ??
      (({ callbackUrl, headers, origin, signal }) => {
        options.callbackRequests?.push({ callbackUrl, origin });
        const target = new URL(callbackUrl);
        return fetchImpl(`${origin}${target.pathname}${target.search}`, {
          headers,
          redirect: "manual",
          ...(signal === undefined ? {} : { signal }),
        });
      }),
    ...options,
  });
};

const exactRuntimeManifest = () => ({
  dependencies: Object.fromEntries(
    runtimeDependencyNames.map((name) => [name, "catalog:"]),
  ),
  name: "@starter/api-runtime-dependencies",
  private: true,
  type: "module",
});

const validRuntimeSnapshot = (): Snapshot => ({
  appRoot: "/app",
  appEntries: [
    "api.mjs",
    "certs",
    "migrate.mjs",
    "migrations",
    "node_modules",
    "package.json",
  ],
  dependencyProblems: [],
  installedPackages: runtimeDependencyNames.map((name) => ({
    name,
    path: `/app/node_modules/${name}`,
  })),
  packageManifest: exactRuntimeManifest(),
  rdsCa: {
    appendErrorCode: "EACCES",
    chmodErrorCode: "EPERM",
    directory: {
      gid: 0,
      mode: 0o755,
      path: "/app/certs",
      uid: 0,
    },
    gid: 0,
    inspector: {
      gid: 1000,
      uid: 1000,
    },
    mode: 0o444,
    path: "/app/certs/global-bundle.pem",
    replaceErrorCode: "EACCES",
    sha256: expectedRdsCaSha256 ?? "",
    uid: 0,
    unlinkErrorCode: "EACCES",
  },
  repositoryEntries: [
    { path: "/app/api.mjs", type: "file" },
    { path: "/app/certs", type: "directory" },
    { path: "/app/certs/global-bundle.pem", type: "file" },
    { path: "/app/migrate.mjs", type: "file" },
    { path: "/app/migrations", type: "directory" },
    { path: "/app/migrations/0001_initial.sql", type: "file" },
    { path: "/app/package.json", type: "file" },
  ],
});

// スキーマが定める形をそのまま使う。テストの固定値から推論すると型が狭くなりすぎる。
type Snapshot = RuntimeSnapshot;

const withImageRdsCaMetadata = (snapshot: Snapshot): Snapshot => ({
  ...snapshot,
  rdsCa: {
    ...validRuntimeSnapshot().rdsCa,
    path: path.join(snapshot.appRoot, "certs", "global-bundle.pem"),
    directory: {
      ...validRuntimeSnapshot().rdsCa.directory,
      path: path.join(snapshot.appRoot, "certs"),
    },
  },
});

const writeFixturePackage = async (directory: string, manifest: unknown) => {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "index.js"), "module.exports = {};\n"),
    writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    ),
  ]);
};

type RuntimeFilesystemContext = {
  appRoot: string;
  writeRootManifest: (manifest: unknown) => Promise<void>;
  writePackage: (directory: string, manifest: unknown) => Promise<void>;
};

const createRuntimeFilesystem = async (
  t: { after(fn: () => unknown): void },
  configure: (context: RuntimeFilesystemContext) => Promise<void> = () =>
    Promise.resolve(),
) => {
  const appRoot = await mkdtemp(
    path.join(tmpdir(), "hono-starter-runtime-inspection-"),
  );
  t.after(() => rm(appRoot, { force: true, recursive: true }));
  await Promise.all([
    mkdir(path.join(appRoot, "certs"), { recursive: true }),
    mkdir(path.join(appRoot, "migrations"), { recursive: true }),
    mkdir(path.join(appRoot, "node_modules"), { recursive: true }),
    writeFile(path.join(appRoot, "api.mjs"), "export {};\n"),
    writeFile(path.join(appRoot, "migrate.mjs"), "export {};\n"),
    writeFile(
      path.join(appRoot, "package.json"),
      `${JSON.stringify(exactRuntimeManifest(), undefined, 2)}\n`,
    ),
  ]);
  await writeFile(
    path.join(appRoot, "migrations", "0001_initial.sql"),
    "select 1;\n",
  );
  await writeFile(
    path.join(appRoot, "certs", "global-bundle.pem"),
    await readFile(
      new URL("../../docker/certs/global-bundle.pem", import.meta.url),
    ),
    { mode: 0o644 },
  );
  await chmod(path.join(appRoot, "certs", "global-bundle.pem"), 0o444);
  await Promise.all(
    runtimeDependencyNames.map((name) =>
      writeFixturePackage(path.join(appRoot, "node_modules", name), {
        main: "index.js",
        name,
        version: "1.0.0",
      }),
    ),
  );
  await configure({
    appRoot,
    writeRootManifest: (manifest: unknown) =>
      writeFile(
        path.join(appRoot, "package.json"),
        `${JSON.stringify(manifest, undefined, 2)}\n`,
      ),
    writePackage: (relativePath, manifest) =>
      writeFixturePackage(path.join(appRoot, relativePath), manifest),
  });
  return appRoot;
};

const processFailure = (
  stderr: string,
  message = "docker exited with status 1",
  stdout = "",
  exitStatus: number | null = 1,
) => {
  const error = new Error(message);
  Object.defineProperties(error, {
    exitStatus: { value: exitStatus },
    stderr: { value: stderr },
    stdout: { value: stdout },
  });
  return error;
};

type FetchCall = { init: RequestInit; url: URL };

const successfulOidcFetch = () => {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetchImpl: async (
      input: Parameters<typeof globalThis.fetch>[0],
      init: RequestInit = {},
    ) => {
      const url = new URL(input as string | URL);
      calls.push({ init, url });
      if (url.pathname === "/healthz") {
        return globalThis.Response.json({ status: "ok" });
      }
      if (url.pathname === "/auth/login") {
        return new globalThis.Response(null, {
          headers: {
            Location: `${fixtureIssuer}/authorize?state=${fixtureStateProbe}`,
            "Set-Cookie": `${fixtureTransactionCookie}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax`,
            "X-Request-Id": "request-login",
          },
          status: 303,
        });
      }
      if (url.pathname === "/auth/callback") {
        return new globalThis.Response(null, {
          headers: {
            Location: "/projects",
            "Set-Cookie": `${fixtureSessionCookie}; Path=/; HttpOnly; Secure; SameSite=Lax`,
            "X-Request-Id": "request-callback",
          },
          status: 303,
        });
      }
      if (url.pathname === "/api/me") {
        return globalThis.Response.json({
          user: {
            displayName: "OIDC Image User",
            email: "oidc-image@example.com",
            id: "user_oidc-image",
            roles: [],
          },
        });
      }
      if (url.pathname === "/auth/provider-logout") {
        const location = new URL(`${fixtureIssuer}/logout`);
        location.searchParams.set("client_id", "fixture-public-client");
        location.searchParams.set("logout_uri", `${productionAppOrigin}/login`);
        return new globalThis.Response(null, {
          headers: { Location: location.toString() },
          status: 303,
        });
      }
      throw new Error(`unexpected fetch path ${url.pathname}`);
    },
  };
};

type RunnerCall = { args: readonly string[]; options: Record<string, unknown> };

const createSuccessfulRunner = (overrides: Record<string, unknown> = {}) => {
  const calls: RunnerCall[] = [];
  const runner: {
    calls: RunnerCall[];
    run(
      command: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ): Promise<string | { stdout: string; stderr: string }>;
    [key: string]: unknown;
  } = {
    calls,
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      calls.push({ args: [command, ...args], options });
      if (args[0] === "container" && args[1] === "inspect") {
        if (args[2] === apiContainerName) return "[]";
        throw processFailure(
          `Error response from daemon: No such container: ${args[2]}`,
        );
      }
      if (args[0] === "port") return `127.0.0.1:${apiPort}`;
      if (args[0] === "exec") return "1000";
      if (args.includes("--eval"))
        return JSON.stringify(
          overrides.runtimeSnapshot ?? validRuntimeSnapshot(),
        );
      if (args.some((argument) => argument.startsWith("find /app"))) {
        return "api.mjs\nmigrate.mjs\nmigrations\nnode_modules\npackage.json";
      }
      if (args.some((argument) => argument.startsWith("for path in")))
        return "";
      if (
        args.includes("NODE_ENV=production") &&
        args.includes("AUTH_PROVIDER=dev")
      ) {
        throw processFailure(
          "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production\n",
        );
      }
      if (args.includes("OIDC_ISSUER=http://issuer.example")) {
        throw processFailure(
          "API startup failed: OIDC requires HTTPS in production\n",
        );
      }
      if (args.includes("NODE_ENV=test")) {
        throw processFailure(`${testEnvironmentRejection}\n`);
      }
      if (args.includes("PGDATABASE=starter_unmigrated")) {
        throw processFailure(
          'API startup failed: Database migrations are not initialized. Run "pnpm db:migrate".\n',
        );
      }
      if (args.includes("PGHOST=postgres-tls-mismatch")) {
        throw processFailure(
          "API startup failed: Unable to connect to PostgreSQL. Check database availability and configuration.\n",
        );
      }
      if (
        args.includes("node") &&
        args.includes("/app/migrate.mjs") &&
        !args.includes("PGDATABASE=starter_image")
      ) {
        throw processFailure("DATABASE_URL is required in production\n");
      }
      return "";
    },
    ...overrides,
  };
  return runner;
};

const createAcknowledgmentWindowRunner = ({
  failureAt,
  preexistingContainer = false,
  preexistingImage = false,
}: {
  failureAt?: "build" | "detachedRun" | "migration";
  preexistingContainer?: boolean;
  preexistingImage?: boolean;
} = {}) => {
  const calls: RunnerCall[] = [];
  const failures = {
    build: new Error("build response lost after image creation"),
    detachedRun: new Error(
      "detached-run response lost after container creation",
    ),
    migration: new Error("migration failed before detached run"),
  };
  const state = {
    containerExists: preexistingContainer,
    imageExists: preexistingImage,
  };
  return {
    calls,
    failures,
    state,
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      calls.push({ args: [command, ...args], options });
      if (args[0] === "image" && args[1] === "ls") {
        return state.imageExists ? "sha256:existing-image" : "";
      }
      if (args[0] === "container" && args[1] === "ls") {
        return state.containerExists ? "existing-container-id" : "";
      }
      if (args[0] === "image" && args[1] === "inspect") {
        if (state.imageExists) return "[]";
        throw processFailure(
          `Error response from daemon: No such image: ${imageTag}`,
        );
      }
      if (args[0] === "container" && args[1] === "inspect") {
        if (state.containerExists) return "[]";
        throw processFailure(
          `Error response from daemon: No such container: ${apiContainerName}`,
        );
      }
      if (args[0] === "build") {
        if (preexistingImage || preexistingContainer) {
          throw new Error("build must not run with a pre-existing exact name");
        }
        state.imageExists = true;
        if (failureAt === "build") throw failures.build;
        return "";
      }
      if (args[0] === "run" && args.includes("--detach")) {
        state.containerExists = true;
        if (failureAt === "detachedRun") throw failures.detachedRun;
        return "container-id";
      }
      if (args[0] === "run" && args.includes("/app/migrate.mjs")) {
        if (failureAt === "migration") throw failures.migration;
        return "";
      }
      if (args[0] === "port") {
        if (!state.containerExists) {
          throw processFailure(
            `Error response from daemon: No such container: ${apiContainerName}`,
          );
        }
        const output = `127.0.0.1:${apiPort}`;
        return options.captureStderr
          ? Object.freeze({ stderr: "", stdout: output })
          : output;
      }
      if (args[0] === "rm") {
        if (!state.containerExists) {
          throw processFailure(
            `Error response from daemon: No such container: ${apiContainerName}`,
          );
        }
        state.containerExists = false;
        return apiContainerName;
      }
      if (args[0] === "image" && args[1] === "rm") {
        if (!state.imageExists) {
          throw processFailure(
            `Error response from daemon: No such image: ${imageTag}`,
          );
        }
        state.imageExists = false;
        return imageTag;
      }
      return "";
    },
  };
};

const createOneShotWindowRunner = ({
  controller,
  failureAt,
  interruptAt,
}: {
  failureAt?: string | undefined;
  interruptAt?: string | undefined;
  controller?: AbortController | undefined;
} = {}) => {
  const calls: RunnerCall[] = [];
  const containers = new Set<string>();
  let imageExists = false;
  const failures = Object.fromEntries(
    ["migration", "runtimeInspection", "devAuth"].map((stage) => [
      stage,
      new Error(`${stage} response lost after container creation`),
    ]),
  );
  const interruptions = Object.fromEntries(
    ["migration", "runtimeInspection", "devAuth"].map((stage) => [
      stage,
      new Error(`${stage} workflow interruption`),
    ]),
  );
  const stageByName = new Map<string, string>([
    [oneShotContainerNames.migration, "migration"],
    [oneShotContainerNames.runtimeInspection, "runtimeInspection"],
    [oneShotContainerNames.devAuth, "devAuth"],
  ]);

  return {
    calls,
    containers,
    failures,
    interruptions,
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      calls.push({ args: [command, ...args], options });
      if (args[0] === "image" && args[1] === "ls") return "";
      if (args[0] === "container" && args[1] === "ls") return "";
      if (args[0] === "container" && args[1] === "inspect") {
        const name = args[2] ?? "";
        if (containers.has(name)) return "[]";
        throw processFailure(
          `Error response from daemon: No such container: ${name}`,
        );
      }
      if (args[0] === "build") {
        imageExists = true;
        return "";
      }
      if (args[0] === "run") {
        const nameIndex = args.indexOf("--name");
        const name = nameIndex === -1 ? undefined : args[nameIndex + 1];
        if (name !== undefined) containers.add(name);
        const stage = name === undefined ? undefined : stageByName.get(name);
        if (stage !== undefined && stage === failureAt) {
          // 用意した失敗をそのまま投げる。包み直すと呼び出し側の同一性判定が崩れる。
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw failures[stage];
        }
        if (stage !== undefined && stage === interruptAt) {
          const interruption = interruptions[stage];
          controller?.abort(interruption);
          throw processFailure("docker command interrupted");
        }
        if (args.includes("--detach")) return "container-id";
        if (name !== undefined) containers.delete(name);
        if (args.includes("--eval")) {
          return JSON.stringify(validRuntimeSnapshot());
        }
        if (stage === "devAuth") {
          throw processFailure(
            "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production\n",
          );
        }
        if (args.includes("OIDC_ISSUER=http://issuer.example")) {
          throw processFailure(
            "API startup failed: OIDC requires HTTPS in production\n",
          );
        }
        if (args.includes("NODE_ENV=test")) {
          throw processFailure(`${testEnvironmentRejection}\n`);
        }
        if (args.includes("PGDATABASE=starter_unmigrated")) {
          throw processFailure(
            'API startup failed: Database migrations are not initialized. Run "pnpm db:migrate".\n',
          );
        }
        if (args.includes("PGHOST=postgres-tls-mismatch")) {
          throw processFailure(
            "API startup failed: Unable to connect to PostgreSQL. Check database availability and configuration.\n",
          );
        }
        if (
          args.includes("/app/migrate.mjs") &&
          !args.includes("PGDATABASE=starter_image")
        ) {
          throw processFailure("DATABASE_URL is required in production\n");
        }
        return "";
      }
      if (args[0] === "port") return `127.0.0.1:${apiPort}`;
      if (args[0] === "exec") return "1000";
      if (args[0] === "logs") {
        return Object.freeze({ stderr: "", stdout: "" });
      }
      if (args[0] === "rm") {
        containers.delete(args.at(-1) ?? "");
        return "";
      }
      if (args[0] === "image" && args[1] === "rm") {
        imageExists = false;
        return "";
      }
      return "";
    },
    state() {
      return { imageExists };
    },
  };
};

const exactCommands = {
  preflightImage: [
    "docker",
    "image",
    "ls",
    "--quiet",
    "--no-trunc",
    "--filter",
    `reference=${imageTag}`,
  ],
  preflightContainer: [
    "docker",
    "container",
    "ls",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `name=^/${apiContainerName}$`,
  ],
  build: [
    "docker",
    "build",
    "--tag",
    imageTag,
    "--file",
    "docker/api.Dockerfile",
    ".",
  ],
  migrate: [
    "docker",
    "run",
    "--rm",
    "--name",
    oneShotContainerNames.migration,
    "--network",
    networkName,
    ...structuredDatabaseArguments(),
    imageTag,
    "node",
    "/app/migrate.mjs",
  ],
  start: [
    "docker",
    "run",
    "--detach",
    "--name",
    apiContainerName,
    "--network",
    networkName,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--volume",
    `${fixtureCaCertificatePath}:/run/oidc-ca/ca-certificate.pem:ro`,
    ...structuredDatabaseArguments(),
    "-e",
    "NODE_ENV=production",
    "-e",
    "AUTH_PROVIDER=oidc",
    "-e",
    "MIGRATIONS_DIRECTORY=/app/migrations",
    "-e",
    `APP_ORIGIN=${productionAppOrigin}`,
    "-e",
    `OIDC_ISSUER=${fixtureIssuer}`,
    "-e",
    "OIDC_CLIENT_ID=fixture-public-client",
    "-e",
    `OIDC_LOGOUT_ENDPOINT=${fixtureIssuer}/logout`,
    "-e",
    "NODE_EXTRA_CA_CERTS=/run/oidc-ca/ca-certificate.pem",
    "-e",
    "OTEL_TRACES_EXPORTER=otlp",
    "-e",
    "OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318",
    "-e",
    "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    "--publish",
    "127.0.0.1::3000",
    imageTag,
  ],
};

const resourceRemovalCommands = (commandRunner: { calls: RunnerCall[] }) =>
  commandRunner.calls
    .map(({ args }) => args)
    .filter(
      (args) => args[1] === "rm" || (args[1] === "image" && args[2] === "rm"),
    );

test("the owned HTTPS fixture authorizes through its trusted local TLS endpoint", async () => {
  const environment = await createProductionOidcFixtureEnvironment();
  try {
    const authorization = new URL("/authorize", environment.issuer);
    authorization.search = new globalThis.URLSearchParams({
      client_id: environment.clientId,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      nonce: "nonce",
      redirect_uri: `${productionAppOrigin}/auth/callback`,
      response_type: "code",
      scope: "openid profile email",
      state: "state",
    }).toString();

    const callback = await environment.authorize(authorization);

    assert.equal(
      callback.origin + callback.pathname,
      `${productionAppOrigin}/auth/callback`,
    );
    assert.equal(callback.searchParams.get("state"), "state");
    assert.ok(callback.searchParams.get("code"));
  } finally {
    await environment.cleanup();
  }
});

test("the owned PostgreSQL fixture serves TLS only for the reviewed network hostname and cleans exact resources", async () => {
  assert.equal(
    typeof productionImage.createProductionDatabaseTlsEnvironment,
    "function",
    "production image verification must provide the owned PostgreSQL TLS fixture",
  );
  const calls: RunnerCall[] = [];
  const controller = new globalThis.AbortController();
  const commandRunner = {
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      calls.push({ args: [command, ...args], options });
      if (args[0] === "run") return "database-container-id";
      if (args[0] === "exec")
        return "postgres-tls:5432 - accepting connections";
      if (args[0] === "container" && args[1] === "inspect") return "[]";
      if (args[0] === "rm") return databaseContainerName;
      return "";
    },
  };
  const environment =
    await productionImage.createProductionDatabaseTlsEnvironment({
      commandRunner,
      databaseContainerName,
      networkName,
      signal: controller.signal,
    });
  const tlsDirectory = path.dirname(environment.caCertificatePath);

  try {
    assert.deepEqual(
      {
        host: environment.host,
        mismatchHost: environment.mismatchHost,
        port: environment.port,
        user: environment.user,
      },
      {
        host: "postgres-tls",
        mismatchHost: "postgres-tls-mismatch",
        port: "5432",
        user: "starter",
      },
    );
    assert.equal(
      /^database-password-[A-Za-z0-9_-]+$/u.test(environment.password),
      true,
      "generated database password must use the expected safe format",
    );
    assert.equal((await stat(environment.caCertificatePath)).isFile(), true);
    const serverCertificate = new X509Certificate(
      await readFile(path.join(tlsDirectory, "server-certificate.pem")),
    );
    assert.equal(serverCertificate.subjectAltName, "DNS:postgres-tls");

    const start = calls
      .map(({ args }) => args)
      .find((args) => args[1] === "run");
    assert.ok(start, "the fixture must start its exact PostgreSQL container");
    for (const requiredArgument of [
      "--detach",
      "--name",
      databaseContainerName,
      "--network",
      networkName,
      "--network-alias",
      "postgres-tls",
      "postgres-tls-mismatch",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid",
      "postgres:17-alpine",
    ]) {
      assert.ok(start.includes(requiredArgument));
    }
    assert.equal(start.includes("--publish"), false);
    assert.match(
      start.at(-1) ?? "",
      /exec \/usr\/local\/bin\/docker-entrypoint\.sh postgres .*ssl=on .*ssl_cert_file=.*ssl_key_file=.*ssl_ca_file=/u,
    );
  } finally {
    controller.abort(new Error("simulated PostgreSQL fixture interruption"));
    await environment.cleanup();
  }

  await assert.rejects(stat(tlsDirectory), { code: "ENOENT" });
  assert.deepEqual(
    calls.map(({ args }) => args).filter((args) => args[1] === "rm"),
    [["docker", "rm", "--force", databaseContainerName]],
  );
  const cleanupCalls = calls.filter(
    ({ args }) =>
      args[1] === "rm" || (args[1] === "container" && args[2] === "inspect"),
  );
  assert.equal(
    cleanupCalls.every(({ options }) => options.signal === undefined),
    true,
  );
});

test("starts the API image in production OIDC mode with an owned HTTPS fixture", async () => {
  const commandRunner = createSuccessfulRunner();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: successfulOidcFetch().fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await verification.verify();
  const start = commandRunner.calls
    .map(({ args }) => args)
    .find((args) => args.includes("--detach"));
  assert.ok(start, "production image must start a detached API container");
  for (const argument of [
    "--add-host",
    "host.docker.internal:host-gateway",
    "NODE_ENV=production",
    "AUTH_PROVIDER=oidc",
    `APP_ORIGIN=${productionAppOrigin}`,
    `OIDC_ISSUER=${fixtureIssuer}`,
    "OIDC_CLIENT_ID=fixture-public-client",
    `OIDC_LOGOUT_ENDPOINT=${fixtureIssuer}/logout`,
    "NODE_EXTRA_CA_CERTS=/run/oidc-ca/ca-certificate.pem",
    `${fixtureCaCertificatePath}:/run/oidc-ca/ca-certificate.pem:ro`,
    `${databaseCaCertificatePath}:${containerDatabaseCaCertificatePath}:ro`,
    "PGHOST=postgres-tls",
    "PGPORT=5432",
    "PGDATABASE=starter_image",
    "PGUSER=starter",
    `PGSSLROOTCERT=${containerDatabaseCaCertificatePath}`,
  ]) {
    assert.ok(start.includes(argument), `missing Docker argument ${argument}`);
  }
  assert.equal(
    start.includes(`PGPASSWORD=${fixtureDatabasePasswordProbe}`),
    true,
    "production image must receive the fixture database password",
  );
  assert.equal(
    start.some((argument) => argument.startsWith("OIDC_CLIENT_SECRET=")),
    false,
    "production image acceptance must stay on the public-client OIDC path that the bundled Cognito stack uses",
  );
  assert.equal(
    start.some((argument) => argument.startsWith("DATABASE_URL=")),
    false,
  );
});

test("completes OIDC callback and sends every runtime auth probe to trace redaction evidence", async () => {
  const commandRunner = createSuccessfulRunner();
  const http = successfulOidcFetch();
  const callbackRequests: { callbackUrl: URL | string; origin: string }[] = [];
  const traceEvidence: unknown[] = [];
  const verification = createProductionImageVerification({
    callbackRequests,
    commandRunner,
    fetchImpl: http.fetchImpl,
    log: () => undefined,
    onTraceEvidence: (evidence) => {
      traceEvidence.push(evidence);
      return Promise.resolve();
    },
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await verification.verify();

  assert.equal(callbackRequests.length, 1);
  assert.equal(
    new URL(callbackRequests[0]!.callbackUrl).origin,
    productionAppOrigin,
  );
  assert.equal(callbackRequests[0]!.origin, `http://127.0.0.1:${apiPort}`);

  assert.deepEqual(
    http.calls.map(({ url }) => `${url.pathname}${url.search}`),
    [
      "/healthz",
      "/auth/login?returnTo=%2Fprojects",
      `/auth/callback?code=${fixtureCodeProbe}&state=${fixtureStateProbe}`,
      "/api/me",
      "/auth/provider-logout",
    ],
  );
  const callbackCall = http.calls[2];
  assert.equal(
    (callbackCall?.init.headers as Headers).get("Cookie"),
    fixtureTransactionCookie,
  );
  assert.match(
    (callbackCall?.init.headers as Headers).get("traceparent") ?? "",
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u,
  );
  assert.equal(traceEvidence.length, 1);
  for (const [label, forbiddenValue] of [
    ["state", fixtureStateProbe],
    ["nonce", fixtureNonceProbe],
    ["verifier", fixtureVerifierProbe],
    ["code", fixtureCodeProbe],
    ["OIDC token", fixtureTokenProbe],
    ["OIDC password", fixturePasswordProbe],
    ["transaction cookie", fixtureTransactionCookie],
    ["session cookie", fixtureSessionCookie],
    ["database password", fixtureDatabasePasswordProbe],
  ] as const) {
    assert.ok(
      (
        traceEvidence[0] as { forbiddenValues: unknown[] }
      ).forbiddenValues.includes(forbiddenValue),
      `missing ${label} trace redaction probe`,
    );
  }
  assert.equal(
    (traceEvidence[0] as { requestId: unknown }).requestId,
    "request-callback",
  );
  assert.equal(
    (traceEvidence[0] as { expectedServerSpanName: unknown })
      .expectedServerSpanName,
    "GET /auth/callback",
  );
});

test("cleans the owned OIDC fixture after an intentional verification failure", async () => {
  let cleanupCalls = 0;
  let databaseCleanupCalls = 0;
  const commandRunner = createSuccessfulRunner();
  const verification = createProductionImageVerificationImpl({
    commandRunner,
    createDatabaseTlsEnvironment: async () => ({
      ...(await createDatabaseTlsEnvironment()),
      cleanup: async () => {
        databaseCleanupCalls += 1;
      },
    }),
    createOidcFixtureEnvironment: async () => ({
      ...(await createOidcFixtureEnvironment()),
      cleanup: async () => {
        cleanupCalls += 1;
      },
    }),
    fetchImpl: async () => {
      throw new Error("intentional health failure");
    },
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(verification.verify());
  assert.equal(cleanupCalls, 1);
  assert.equal(databaseCleanupCalls, 1);
  assert.deepEqual(resourceRemovalCommands(commandRunner), [
    ["docker", "rm", "--force", apiContainerName],
    ["docker", "image", "rm", imageTag],
  ]);
});

test("captures successful migration channels and rejects database password output safely", async (t) => {
  for (const channel of ["stdout", "stderr"]) {
    await t.test(channel, async () => {
      const commandRunner = createSuccessfulRunner();
      const successfulRun = commandRunner.run.bind(commandRunner);
      let migrationOptions: Record<string, unknown> | undefined;
      commandRunner.run = async (command, args, options = {}) => {
        if (
          args.includes("/app/migrate.mjs") &&
          args.includes("PGDATABASE=starter_image")
        ) {
          commandRunner.calls.push({ args: [command, ...args], options });
          migrationOptions = options;
          return Object.freeze({
            stderr: "",
            stdout: "",
            [channel]: `unsafe ${fixtureDatabasePasswordProbe}`,
          });
        }
        return successfulRun(command, args, options);
      };
      const verification = createProductionImageVerification({
        commandRunner,
        fetchImpl: successfulOidcFetch().fetchImpl,
        log: () => undefined,
        projectName,
        signal: new globalThis.AbortController().signal,
      });

      await assert.rejects(verification.verify(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          inspect(error, { depth: null }).includes(
            fixtureDatabasePasswordProbe,
          ),
          false,
        );
        assert.equal(
          error.message,
          "Production image database migration output contained forbidden database material.",
        );
        return true;
      });
      assert.equal(migrationOptions?.capture, true);
      assert.equal(migrationOptions?.captureStderr, true);
    });
  }
});

test("replaces a password-bearing migration failure with a safe error", async () => {
  const commandRunner = createSuccessfulRunner();
  const successfulRun = commandRunner.run.bind(commandRunner);
  let migrationOptions: Record<string, unknown> | undefined;
  commandRunner.run = async (command, args, options = {}) => {
    if (
      args.includes("/app/migrate.mjs") &&
      args.includes("PGDATABASE=starter_image")
    ) {
      commandRunner.calls.push({ args: [command, ...args], options });
      migrationOptions = options;
      throw processFailure(
        `unsafe stderr ${fixtureDatabasePasswordProbe}`,
        "docker exited with status 1",
        `unsafe stdout ${fixtureDatabasePasswordProbe}`,
      );
    }
    return successfulRun(command, args, options);
  };
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: successfulOidcFetch().fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(verification.verify(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(
      inspect(error, { depth: null }).includes(fixtureDatabasePasswordProbe),
      false,
    );
    assert.equal(error.message, "Production image database migration failed.");
    return true;
  });
  assert.equal(migrationOptions?.capture, true);
  assert.equal(migrationOptions?.captureStderr, true);
});

test("builds once and verifies the production image golden path and fail-closed processes in order", async () => {
  const commandRunner = createSuccessfulRunner();
  const http = successfulOidcFetch();
  const signal = new globalThis.AbortController().signal;
  const publishedPorts: unknown[] = [];
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: http.fetchImpl,
    log: () => undefined,
    onApiPort: (port) => publishedPorts.push(port),
    projectName,
    signal,
  });

  assert.deepEqual(await verification.verify(), { apiPort });
  assert.deepEqual(await verification.verify(), { apiPort });
  assert.deepEqual(publishedPorts, [apiPort]);

  const commands = commandRunner.calls.map(({ args }) => args);
  assert.equal(commands.filter((command) => command[1] === "build").length, 1);
  assert.deepEqual(commands[0], exactCommands.preflightImage);
  assert.deepEqual(commands[1], exactCommands.preflightContainer);
  // 事前照会は所有コンテナ名ごとに 1 回走るため、以降の並びは build を起点に数える。
  const buildIndex = commands.findIndex((command) => command[1] === "build");
  assert.equal(buildIndex, exactContainerNames.length + 1);
  assert.deepEqual(commands[buildIndex], exactCommands.build);
  assertStructuredDatabaseCommand(
    commands[buildIndex + 1] ?? [],
    exactCommands.migrate,
  );
  assertStructuredDatabaseCommand(
    commands[buildIndex + 2] ?? [],
    exactCommands.start,
  );
  assert.deepEqual(commands[buildIndex + 3], [
    "docker",
    "port",
    apiContainerName,
    "3000/tcp",
  ]);
  assert.deepEqual(commands[buildIndex + 4], [
    "docker",
    "exec",
    apiContainerName,
    "id",
    "-u",
  ]);
  assert.deepEqual(commands[buildIndex + 5], [
    "docker",
    "exec",
    apiContainerName,
    "id",
    "-g",
  ]);

  const authIndex = commands.findIndex(
    (command) =>
      command.includes("NODE_ENV=production") &&
      command.includes("AUTH_PROVIDER=dev"),
  );
  const httpIssuerIndex = commands.findIndex((command) =>
    command.includes("OIDC_ISSUER=http://issuer.example"),
  );
  const testEnvironmentIndex = commands.findIndex((command) =>
    command.includes("NODE_ENV=test"),
  );
  const unmigratedIndex = commands.findIndex((command) =>
    command.includes("PGDATABASE=starter_unmigrated"),
  );
  const tlsHostnameIndex = commands.findIndex((command) =>
    command.includes("PGHOST=postgres-tls-mismatch"),
  );
  const missingDatabaseIndex = commands.findIndex(
    (command) =>
      command.includes("/app/migrate.mjs") &&
      !command.includes("PGDATABASE=starter_image"),
  );
  assert.ok(authIndex > buildIndex + 4);
  assert.ok(httpIssuerIndex > authIndex);
  assert.ok(testEnvironmentIndex > httpIssuerIndex);
  assert.ok(unmigratedIndex > testEnvironmentIndex);
  assert.ok(tlsHostnameIndex > unmigratedIndex);
  assert.ok(missingDatabaseIndex > tlsHostnameIndex);
  assert.deepEqual(commands[testEnvironmentIndex], [
    "docker",
    "run",
    "--rm",
    "--name",
    oneShotContainerNames.testEnvironment,
    "--network",
    "none",
    "-e",
    "NODE_ENV=test",
    imageTag,
  ]);

  assert.deepEqual(
    http.calls.map(({ url }) => url.pathname),
    [
      "/healthz",
      "/auth/login",
      "/auth/callback",
      "/api/me",
      "/auth/provider-logout",
    ],
  );
  const [healthCall, ...authenticatedCalls] = http.calls;
  assert.ok(healthCall?.init.signal instanceof globalThis.AbortSignal);
  assert.notEqual(healthCall?.init.signal, signal);
  for (const { init } of authenticatedCalls) {
    assert.equal(init.signal, signal);
  }
  for (const { url } of http.calls) {
    assert.equal(url.origin, `http://127.0.0.1:${apiPort}`);
  }
  const callbackRequest = http.calls.find(
    ({ url }) => url.pathname === "/auth/callback",
  );
  assert.equal(
    (callbackRequest?.init.headers as Headers).get("Cookie"),
    fixtureTransactionCookie,
  );
  const providerLogoutRequest = http.calls.find(
    ({ url }) => url.pathname === "/auth/provider-logout",
  );
  assert.equal(providerLogoutRequest?.init.redirect, "manual");

  await verification.cleanup();
  await verification.cleanup();
  assert.deepEqual(resourceRemovalCommands(commandRunner), [
    ["docker", "rm", "--force", apiContainerName],
    ["docker", "image", "rm", imageTag],
  ]);
});

test("reports stable runtime RDS CA ownership and mutation probe results", async () => {
  const messages: string[] = [];
  const verification = createProductionImageVerification({
    commandRunner: createSuccessfulRunner(),
    fetchImpl: successfulOidcFetch().fetchImpl,
    log: (message) => messages.push(message),
    projectName,
  });

  await verification.verify();

  assert.deepEqual(
    messages.filter((message) =>
      message.startsWith("Validated production image RDS CA "),
    ),
    [
      'Validated production image RDS CA {"appendErrorCode":"EACCES","chmodErrorCode":"EPERM","directory":{"gid":0,"mode":"0755","uid":0},"file":{"gid":0,"mode":"0444","uid":0},"inspector":{"gid":1000,"uid":1000},"replaceErrorCode":"EACCES","unlinkErrorCode":"EACCES"}',
    ],
  );
});

test("preflights, names, and reconciles every exact owned one-shot container", async () => {
  const commandRunner = createSuccessfulRunner();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: successfulOidcFetch().fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await verification.verify();
  await verification.cleanup();

  const preflightNames = commandRunner.calls
    .map(({ args }) => args)
    .filter((args) => args[1] === "container" && args[2] === "ls")
    .map((args) => args.at(-1));
  assert.deepEqual(
    preflightNames,
    exactContainerNames.map((name) => `name=^/${name}$`),
  );

  const oneShotRunNames = commandRunner.calls
    .map(({ args }) => args)
    .filter(
      (args) =>
        args[1] === "run" && args.includes("--rm") && args.includes("--name"),
    )
    .map((args) => args[args.indexOf("--name") + 1]);
  assert.deepEqual(oneShotRunNames, Object.values(oneShotContainerNames));

  const reconciledNames = commandRunner.calls
    .map(({ args }) => args)
    .filter((args) => args[1] === "container" && args[2] === "inspect")
    .map((args) => args[3]);
  assert.deepEqual(reconciledNames, [
    apiContainerName,
    ...Object.values(oneShotContainerNames),
  ]);

  const removedNames = commandRunner.calls
    .map(({ args }) => args)
    .filter((args) => args[1] === "rm" && args[2] === "--force")
    .map((args) => args[3]);
  assert.deepEqual(removedNames, [apiContainerName]);
  assert.equal(
    [...preflightNames, ...oneShotRunNames, ...reconciledNames, ...removedNames]
      .filter((value) => value !== undefined)
      .every((value) => value.includes(projectName) && !value.includes("*")),
    true,
  );
});

test("publishes the API port before a later UID failure and then cleans exact resources", async () => {
  const uidFailure = new Error("UID check failed after port discovery");
  const commandRunner = createSuccessfulRunner({
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      (this.calls as RunnerCall[]).push({
        args: [command, ...args],
        options,
      });
      if (
        args[0] === "container" &&
        args[1] === "inspect" &&
        args[2] !== apiContainerName
      ) {
        throw processFailure(
          `Error response from daemon: No such container: ${args[2]}`,
        );
      }
      if (args[0] === "port") return `127.0.0.1:${apiPort}`;
      if (args[0] === "exec") throw uidFailure;
      return "";
    },
  });
  const publishedPorts: unknown[] = [];
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: () => assert.fail("fetch must not run"),
    log: () => undefined,
    onApiPort: (port) => publishedPorts.push(port),
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(verification.verify(), (error) => error === uidFailure);
  assert.deepEqual(publishedPorts, [apiPort]);
  assert.deepEqual(resourceRemovalCommands(commandRunner), [
    ["docker", "rm", "--force", apiContainerName],
    ["docker", "image", "rm", imageTag],
  ]);
});

test("cleans an exact image created before the build acknowledgment is lost", async () => {
  const commandRunner = createAcknowledgmentWindowRunner({
    failureAt: "build",
  });
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: () => assert.fail("fetch must not run"),
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    (error) => error === commandRunner.failures.build,
  );
  assert.equal(commandRunner.state.imageExists, false);
  assert.deepEqual(
    commandRunner.calls
      .filter(({ args }) => args[1] === "image" && args[2] === "rm")
      .map(({ args }) => args),
    [["docker", "image", "rm", imageTag]],
  );
});

test("reconciles one-shot containers after migration, inspection, and fail-closed acknowledgments are lost", async (t) => {
  for (const [stage, name] of [
    ["migration", oneShotContainerNames.migration],
    ["runtimeInspection", oneShotContainerNames.runtimeInspection],
    ["devAuth", oneShotContainerNames.devAuth],
  ] as const) {
    await t.test(stage, async () => {
      const commandRunner = createOneShotWindowRunner({ failureAt: stage });
      const verification = createProductionImageVerification({
        commandRunner,
        fetchImpl: successfulOidcFetch().fetchImpl,
        log: () => undefined,
        projectName,
        signal: new globalThis.AbortController().signal,
      });

      await assert.rejects(verification.verify(), (error: unknown) =>
        stage === "devAuth"
          ? (error as Error).message ===
            "Production image Dev Auth rejection did not match the expected safe error."
          : stage === "migration"
            ? (error as Error).message ===
              "Production image database migration failed."
            : error === commandRunner.failures[stage as string],
      );
      assert.equal(commandRunner.containers.has(name as string), false);
      assert.equal(commandRunner.state().imageExists, false);
      const reconciliation = commandRunner.calls.filter(
        ({ args }) =>
          (args[1] === "container" &&
            args[2] === "inspect" &&
            args[3] === name) ||
          (args[1] === "rm" && args[3] === name),
      );
      assert.deepEqual(
        reconciliation.map(({ args }) => args),
        [
          ["docker", "container", "inspect", name],
          ["docker", "rm", "--force", name],
        ],
      );
      assert.equal(
        reconciliation.every(({ options }) => options.signal === undefined),
        true,
      );
    });
  }
});

test("reconciles one-shot containers after migration, inspection, and fail-closed interruptions", async (t) => {
  for (const [stage, name] of [
    ["migration", oneShotContainerNames.migration],
    ["runtimeInspection", oneShotContainerNames.runtimeInspection],
    ["devAuth", oneShotContainerNames.devAuth],
  ] as const) {
    await t.test(stage, async () => {
      const controller = new globalThis.AbortController();
      const commandRunner = createOneShotWindowRunner({
        controller,
        interruptAt: stage,
      });
      const verification = createProductionImageVerification({
        commandRunner,
        fetchImpl: successfulOidcFetch().fetchImpl,
        log: () => undefined,
        projectName,
        signal: controller.signal,
      });

      await assert.rejects(
        verification.verify(),
        (error) => error === commandRunner.interruptions[stage],
      );
      assert.equal(commandRunner.containers.has(name as string), false);
      assert.equal(commandRunner.state().imageExists, false);
      const reconciliation = commandRunner.calls.filter(
        ({ args }) =>
          (args[1] === "container" &&
            args[2] === "inspect" &&
            args[3] === name) ||
          (args[1] === "rm" && args[3] === name),
      );
      assert.deepEqual(
        reconciliation.map(({ args }) => args),
        [
          ["docker", "container", "inspect", name],
          ["docker", "rm", "--force", name],
        ],
      );
      assert.equal(
        reconciliation.every(({ options }) => options.signal === undefined),
        true,
      );
    });
  }
});

test("recovers the port and cleans a container created before detached-run acknowledgment is lost", async () => {
  const commandRunner = createAcknowledgmentWindowRunner({
    failureAt: "detachedRun",
  });
  const publishedPorts: unknown[] = [];
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: () => assert.fail("fetch must not run"),
    log: () => undefined,
    onApiPort: (port) => publishedPorts.push(port),
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    (error) => error === commandRunner.failures.detachedRun,
  );
  assert.deepEqual(publishedPorts, [apiPort]);
  assert.equal(commandRunner.state.containerExists, false);
  assert.equal(commandRunner.state.imageExists, false);
  const cleanupCalls = commandRunner.calls.filter(
    ({ args }) =>
      (args[1] === "container" && args[2] === "inspect") ||
      args[1] === "port" ||
      args[1] === "rm" ||
      (args[1] === "image" && args[2] === "rm"),
  );
  assert.deepEqual(
    cleanupCalls.map(({ args }) => args),
    [
      ["docker", "container", "inspect", apiContainerName],
      ["docker", "port", apiContainerName, "3000/tcp"],
      ["docker", "rm", "--force", apiContainerName],
      ["docker", "container", "inspect", oneShotContainerNames.migration],
      ["docker", "image", "rm", imageTag],
    ],
  );
  assert.equal(
    cleanupCalls.every(({ options }) => options.signal === undefined),
    true,
  );
});

test("refuses pre-existing exact image and container names without deleting them", async (t) => {
  for (const [resource, options, expectedMessage] of [
    [
      "image",
      { preexistingImage: true },
      /refuses a pre-existing exact image/u,
    ],
    [
      "container",
      { preexistingContainer: true },
      /refuses a pre-existing exact container/u,
    ],
  ] as const) {
    await t.test(resource, async () => {
      const commandRunner = createAcknowledgmentWindowRunner(options);
      const verification = createProductionImageVerification({
        commandRunner,
        fetchImpl: () => assert.fail("fetch must not run"),
        log: () => undefined,
        projectName,
        signal: new globalThis.AbortController().signal,
      });

      await assert.rejects(verification.verify(), expectedMessage);
      assert.equal(
        commandRunner.calls.some(({ args }) => args[1] === "build"),
        false,
      );
      assert.equal(
        commandRunner.calls.some(
          ({ args }) =>
            args[1] === "rm" || (args[1] === "image" && args[2] === "rm"),
        ),
        false,
      );
      assert.equal(
        commandRunner.state.imageExists,
        options.preexistingImage === true,
      );
      assert.equal(
        commandRunner.state.containerExists,
        options.preexistingContainer === true,
      );
    });
  }
});

test("an interrupted verification removes only its exact owned container and image", async () => {
  const commandRunner = createSuccessfulRunner();
  const controller = new globalThis.AbortController();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: () => {
      controller.abort(new Error("workflow interrupted"));
      controller.signal.throwIfAborted();
      return Promise.reject(new Error("unreachable"));
    },
    log: () => undefined,
    projectName,
    signal: controller.signal,
  });

  await assert.rejects(verification.verify(), /workflow interrupted/u);
  const cleanupCommands = commandRunner.calls
    .map(({ args }) => args)
    .filter(
      (command) =>
        command[1] === "rm" || (command[1] === "image" && command[2] === "rm"),
    );
  assert.deepEqual(cleanupCommands, [
    ["docker", "rm", "--force", apiContainerName],
    ["docker", "image", "rm", imageTag],
  ]);
  assert.equal(
    cleanupCommands.some((command) =>
      command.some((argument) => argument.includes("*")),
    ),
    false,
  );
});

test("an interruption rejects a health request that ignores its signal and still cleans exact resources", async () => {
  const commandRunner = createSuccessfulRunner();
  const controller = new globalThis.AbortController();
  const interruption = new Error("ignored-fetch workflow interruption");
  const abortTimer = setTimeout(() => controller.abort(interruption), 5);
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: async () => new Promise(() => undefined),
    log: () => undefined,
    projectName,
    signal: controller.signal,
  });

  let watchdog;
  try {
    await assert.rejects(
      Promise.race([
        verification.verify(),
        new Promise((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("production verification watchdog expired")),
            100,
          );
        }),
      ]),
      (error) => error === interruption,
    );
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(watchdog);
  }
  assert.deepEqual(resourceRemovalCommands(commandRunner), [
    ["docker", "rm", "--force", apiContainerName],
    ["docker", "image", "rm", imageTag],
  ]);
});

test("an interruption rejects an authenticated request that ignores its signal and still cleans exact resources", async () => {
  const commandRunner = createSuccessfulRunner();
  const controller = new globalThis.AbortController();
  const interruption = new Error("ignored-auth workflow interruption");
  let fetchCount = 0;
  const verification = createProductionImageVerification({
    commandRunner,
    async fetchImpl() {
      fetchCount += 1;
      if (fetchCount === 1) return globalThis.Response.json({ status: "ok" });
      return new Promise(() => undefined);
    },
    log: () => undefined,
    projectName,
    signal: controller.signal,
  });
  const abortTimer = setTimeout(() => controller.abort(interruption), 5);

  let watchdog;
  try {
    await assert.rejects(
      Promise.race([
        verification.verify(),
        new Promise((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("production verification watchdog expired")),
            100,
          );
        }),
      ]),
      (error) => error === interruption,
    );
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(watchdog);
  }
  assert.deepEqual(resourceRemovalCommands(commandRunner), [
    ["docker", "rm", "--force", apiContainerName],
    ["docker", "image", "rm", imageTag],
  ]);
});

test("cleanup treats already-absent exact resources as cleaned using captured stderr", async () => {
  const commandRunner = createSuccessfulRunner();
  const successfulRun = commandRunner.run.bind(commandRunner);
  commandRunner.run = async (command, args, options = {}) => {
    if (args[0] === "rm" || (args[0] === "image" && args[1] === "rm")) {
      commandRunner.calls.push({ args: [command, ...args], options });
      assert.equal(options.capture, true);
      assert.equal(options.captureStderr, true);
      throw processFailure(
        args[0] === "rm"
          ? `Error response from daemon: No such container: ${apiContainerName}`
          : `Error response from daemon: No such image: ${imageTag}`,
      );
    }
    return successfulRun(command, args, options);
  };
  const http = successfulOidcFetch();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: http.fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await verification.verify();
  await assert.doesNotReject(verification.cleanup());
  await assert.doesNotReject(verification.cleanup());
});

test("a cleanup failure is combined with the primary verification failure", async () => {
  const primaryFailure = new Error("health verification failed");
  const cleanupFailure = new Error("exact image removal failed");
  const commandRunner = createSuccessfulRunner({
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      (this.calls as RunnerCall[]).push({
        args: [command, ...args],
        options,
      });
      if (
        args[0] === "container" &&
        args[1] === "inspect" &&
        args[2] !== apiContainerName
      ) {
        throw processFailure(
          `Error response from daemon: No such container: ${args[2]}`,
        );
      }
      if (args[0] === "port") return `127.0.0.1:${apiPort}`;
      if (args[0] === "exec") return "1000";
      if (args[0] === "image" && args[1] === "rm") throw cleanupFailure;
      if (args.includes("--eval"))
        return JSON.stringify(validRuntimeSnapshot());
      if (args.some((argument) => argument.startsWith("find /app"))) {
        return "api.mjs\nmigrate.mjs\nmigrations\nnode_modules\npackage.json";
      }
      if (args.some((argument) => argument.startsWith("for path in")))
        return "";
      return "";
    },
  });
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: async () => {
      throw primaryFailure;
    },
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(verification.verify(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primaryFailure, cleanupFailure]);
    return true;
  });
  assert.deepEqual(resourceRemovalCommands(commandRunner), [
    ["docker", "rm", "--force", apiContainerName],
    ["docker", "image", "rm", imageTag],
  ]);
});

test("a mismatched fail-closed stderr raises a safe error without retaining database or cookie material", async () => {
  const rawCookie = "session=RAW_IMAGE_COOKIE_94e8";
  const commandRunner = createSuccessfulRunner({
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      (this.calls as RunnerCall[]).push({
        args: [command, ...args],
        options,
      });
      if (args[0] === "port") return `127.0.0.1:${apiPort}`;
      if (args[0] === "exec") return "1000";
      if (args.includes("--eval"))
        return JSON.stringify(validRuntimeSnapshot());
      if (args.some((argument) => argument.startsWith("find /app"))) {
        return "api.mjs\nmigrate.mjs\nmigrations\nnode_modules\npackage.json";
      }
      if (args.some((argument) => argument.startsWith("for path in")))
        return "";
      if (
        args.includes("NODE_ENV=production") &&
        args.includes("AUTH_PROVIDER=dev")
      ) {
        throw processFailure(
          `unsafe ${fixtureDatabasePasswordProbe} ${rawCookie}`,
          "docker exited with status 1",
        );
      }
      return "";
    },
  });
  const http = successfulOidcFetch();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: http.fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(verification.verify(), (error) => {
    assert.ok(error instanceof Error);
    const rendered = inspect(error, { depth: null });
    assert.equal(rendered.includes(fixtureDatabasePasswordProbe), false);
    assert.equal(rendered.includes(rawCookie), false);
    assert.equal(
      error.message,
      "Production image Dev Auth rejection did not match the expected safe error.",
    );
    return true;
  });
});

test("rejects fail-closed output when stdout contains forbidden material even with exact stderr", async () => {
  const unsafeStdout = `${fixtureDatabasePasswordProbe} session=opaque-image-cookie`;
  const commandRunner = createSuccessfulRunner({
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      (this.calls as RunnerCall[]).push({
        args: [command, ...args],
        options,
      });
      if (args[0] === "port") return `127.0.0.1:${apiPort}`;
      if (args[0] === "exec") return "1000";
      if (args.includes("--eval"))
        return JSON.stringify(validRuntimeSnapshot());
      if (
        args.includes("NODE_ENV=production") &&
        args.includes("AUTH_PROVIDER=dev")
      ) {
        throw processFailure(
          "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production\n",
          "docker exited with status 1",
          unsafeStdout,
        );
      }
      return "";
    },
  });
  const http = successfulOidcFetch();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: http.fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(verification.verify(), (error) => {
    const rendered = inspect(error, { depth: null });
    assert.equal(rendered.includes(fixtureDatabasePasswordProbe), false);
    assert.equal(rendered.includes("opaque-image-cookie"), false);
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      "Production image Dev Auth rejection did not match the expected safe error.",
    );
    return true;
  });
});

test("rejects a zero-exit fail-closed command even when stderr is exactly safe", async () => {
  const commandRunner = createSuccessfulRunner();
  const successfulRun = commandRunner.run.bind(commandRunner);
  commandRunner.run = async (command, args, options = {}) => {
    if (
      args.includes("NODE_ENV=production") &&
      args.includes("AUTH_PROVIDER=dev")
    ) {
      commandRunner.calls.push({ args: [command, ...args], options });
      return Object.freeze({
        stderr:
          "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production",
        stdout: "",
      });
    }
    return successfulRun(command, args, options);
  };
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: successfulOidcFetch().fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /Production image Dev Auth rejection did not match the expected safe error/u,
  );
});

test("rejects the exact safe stderr from an unintended nonzero status", async () => {
  const commandRunner = createSuccessfulRunner();
  const successfulRun = commandRunner.run.bind(commandRunner);
  commandRunner.run = async (command, args, options = {}) => {
    if (
      args.includes("NODE_ENV=production") &&
      args.includes("AUTH_PROVIDER=dev")
    ) {
      commandRunner.calls.push({ args: [command, ...args], options });
      throw processFailure(
        "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production",
        "docker exited with status 2",
        "",
        2,
      );
    }
    return successfulRun(command, args, options);
  };
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: successfulOidcFetch().fetchImpl,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /Production image Dev Auth rejection did not match the expected safe error/u,
  );
});

test("rethrows interruption during an expected fail-closed command and keeps cleanup signal-independent", async () => {
  const controller = new globalThis.AbortController();
  const interruption = new Error(
    "workflow interrupted during expected failure",
  );
  const commandRunner = createSuccessfulRunner({
    async run(
      command: string,
      args: readonly string[],
      options: Record<string, unknown> = {},
    ) {
      (this.calls as RunnerCall[]).push({
        args: [command, ...args],
        options,
      });
      if (args[0] === "port") return `127.0.0.1:${apiPort}`;
      if (args[0] === "exec") return "1000";
      if (args.includes("--eval"))
        return JSON.stringify(validRuntimeSnapshot());
      if (
        args[0] === "container" &&
        args[1] === "inspect" &&
        args[2] !== apiContainerName &&
        args[2] !== oneShotContainerNames.devAuth
      ) {
        throw processFailure(
          `Error response from daemon: No such container: ${args[2]}`,
        );
      }
      if (
        args.includes("NODE_ENV=production") &&
        args.includes("AUTH_PROVIDER=dev")
      ) {
        controller.abort(interruption);
        throw processFailure(
          "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production\n",
        );
      }
      return "";
    },
  });
  const http = successfulOidcFetch();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: http.fetchImpl,
    log: () => undefined,
    projectName,
    signal: controller.signal,
  });

  await assert.rejects(
    verification.verify(),
    (error) => error === interruption,
  );
  const cleanupStartIndex = commandRunner.calls.findIndex(
    ({ args }) => args[1] === "container" && args[2] === "inspect",
  );
  const cleanupCalls = commandRunner.calls.slice(cleanupStartIndex);
  assert.deepEqual(
    cleanupCalls.map(({ args }) => args),
    [
      ["docker", "container", "inspect", apiContainerName],
      ["docker", "rm", "--force", apiContainerName],
      ["docker", "container", "inspect", oneShotContainerNames.migration],
      [
        "docker",
        "container",
        "inspect",
        oneShotContainerNames.runtimeInspection,
      ],
      ["docker", "container", "inspect", oneShotContainerNames.devAuth],
      ["docker", "rm", "--force", oneShotContainerNames.devAuth],
      ["docker", "image", "rm", imageTag],
    ],
  );
  assert.equal(
    commandRunner.calls
      .slice(0, cleanupStartIndex)
      .every(({ options }) => options.signal === controller.signal),
    true,
  );
  assert.equal(
    cleanupCalls.every(({ options }) => options.signal === undefined),
    true,
  );
});

test("requires the reviewed RDS CA ownership and mutation denial in the runtime image", async (t) => {
  assert.doesNotThrow(() =>
    validateRuntimeSnapshot(validRuntimeSnapshot(), {
      expectedRdsCaSha256,
    }),
  );

  for (const { label, mutate, pattern } of [
    {
      label: "missing CA metadata",
      mutate: (snapshot: Snapshot) => {
        delete (snapshot as { rdsCa?: unknown }).rdsCa;
      },
      pattern: /invalid RDS CA metadata/u,
    },
    {
      label: "mismatched CA digest",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.sha256 = "0".repeat(64);
      },
      pattern: /RDS CA digest mismatch/u,
    },
    {
      label: "group-writable CA",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.mode = 0o664;
      },
      pattern: /RDS CA permissions allow runtime writes/u,
    },
    {
      label: "other-writable CA",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.mode = 0o646;
      },
      pattern: /RDS CA permissions allow runtime writes/u,
    },
    {
      label: "non-root CA owner",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.uid = 1000;
      },
      pattern: /RDS CA must be owned by root/u,
    },
    {
      label: "non-root CA group",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.gid = 1000;
      },
      pattern: /RDS CA must be owned by root/u,
    },
    {
      label: "runtime-user chmod success",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.chmodErrorCode = "CHMODDED";
      },
      pattern: /RDS CA chmod probe did not deny runtime mutation/u,
    },
    {
      label: "runtime-user replacement success",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.replaceErrorCode = "RENAMED";
      },
      pattern: /RDS CA replacement probe did not deny runtime mutation/u,
    },
    {
      label: "runtime-user unlink success",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.unlinkErrorCode = "UNLINKED";
      },
      pattern: /RDS CA unlink probe did not deny runtime mutation/u,
    },
    {
      label: "runtime-writable CA directory",
      mutate: (snapshot: Snapshot) => {
        snapshot.rdsCa.directory.mode = 0o777;
      },
      pattern: /RDS CA directory permissions allow runtime writes/u,
    },
  ]) {
    await t.test(label, () => {
      const snapshot = validRuntimeSnapshot();
      mutate(snapshot);
      assert.throws(
        () => validateRuntimeSnapshot(snapshot, { expectedRdsCaSha256 }),
        pattern,
      );
    });
  }

  assert.throws(
    () => validateRuntimeSnapshot(validRuntimeSnapshot()),
    /expected RDS CA digest/u,
  );
});

test("rejects an RDS CA writable by its owner even when group and other writes are absent", () => {
  const snapshot = validRuntimeSnapshot();
  snapshot.rdsCa.mode = 0o644;

  assert.throws(
    () => validateRuntimeSnapshot(snapshot, { expectedRdsCaSha256 }),
    /RDS CA permissions allow runtime writes/u,
  );
});

test("requires the RDS CA inspector group to match the default runtime group", () => {
  const snapshot = validRuntimeSnapshot();
  snapshot.rdsCa.inspector.gid = 2000;

  assert.throws(
    () =>
      validateRuntimeSnapshot(snapshot, {
        expectedRdsCaSha256,
        expectedRuntimeGid: 1000,
        expectedRuntimeUid: 1000,
      }),
    /RDS CA inspection did not run as the default runtime user/u,
  );
});

test("rejects nested repository TypeScript and test artifacts by exact image path", async () => {
  const runtimeSnapshot = validRuntimeSnapshot();
  runtimeSnapshot.repositoryEntries.push(
    { path: "/app/migrations/nested/source.ts", type: "file" },
    { path: "/app/migrations/__tests__/seed.test.js", type: "file" },
  );
  const verification = createProductionImageVerification({
    commandRunner: createSuccessfulRunner({ runtimeSnapshot }),
    fetchImpl: () => assert.fail("fetch must not run"),
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /forbidden repository paths: \/app\/migrations\/__tests__\/seed\.test\.js, \/app\/migrations\/nested\/source\.ts/u,
  );
});

test("rejects a forbidden build package nested below another runtime package", async () => {
  const runtimeSnapshot = validRuntimeSnapshot();
  runtimeSnapshot.installedPackages.push({
    name: "typescript",
    path: "/app/node_modules/example/node_modules/typescript",
  });
  const verification = createProductionImageVerification({
    commandRunner: createSuccessfulRunner({ runtimeSnapshot }),
    fetchImpl: () => assert.fail("fetch must not run"),
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /forbidden installed packages: \/app\/node_modules\/example\/node_modules\/typescript/u,
  );
});

test("rejects a test-only jose package anywhere in the runtime image", async () => {
  const runtimeSnapshot = validRuntimeSnapshot();
  runtimeSnapshot.installedPackages.push({
    name: "jose",
    path: "/app/node_modules/example/node_modules/jose",
  });
  const verification = createProductionImageVerification({
    commandRunner: createSuccessfulRunner({ runtimeSnapshot }),
    fetchImpl: () => assert.fail("fetch must not run"),
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /Production image contains forbidden jose package\./u,
  );
});

test("rejects dev and workspace declarations in the runtime package manifest", async () => {
  const runtimeSnapshot = validRuntimeSnapshot();
  const manifest = runtimeSnapshot.packageManifest;
  manifest.devDependencies = { vitest: "1.0.0" };
  manifest.workspaces = ["packages/*"];
  const verification = createProductionImageVerification({
    commandRunner: createSuccessfulRunner({ runtimeSnapshot }),
    fetchImpl: () => assert.fail("fetch must not run"),
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /\/app\/package\.json top-level keys mismatch; missing: none; extra: devDependencies, workspaces/u,
  );
});

test("rejects arbitrary root dependencies before runtime tree traversal", async () => {
  const runtimeSnapshot = validRuntimeSnapshot();
  (
    runtimeSnapshot.packageManifest.dependencies as Record<string, string>
  ).vitest = "1.0.0";
  runtimeSnapshot.dependencyProblems.push(
    "extraneous: vitest@1.0.0 /app/node_modules/vitest",
  );
  const verification = createProductionImageVerification({
    commandRunner: createSuccessfulRunner({ runtimeSnapshot }),
    fetchImpl: () => assert.fail("fetch must not run"),
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /runtime dependencies mismatch; missing: none; extra: vitest/u,
  );
});

test("rejects runtime dependency-tree problems independently of the exact root manifest", async () => {
  const runtimeSnapshot = validRuntimeSnapshot();
  runtimeSnapshot.dependencyProblems.push(
    "extraneous package /app/node_modules/vitest",
  );
  const verification = createProductionImageVerification({
    commandRunner: createSuccessfulRunner({ runtimeSnapshot }),
    fetchImpl: () => assert.fail("fetch must not run"),
    healthTimeoutMs: 0,
    log: () => undefined,
    projectName,
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /runtime dependency tree reported 1 problem: extraneous package \/app\/node_modules\/vitest\./u,
  );
});

test("the actual runtime walker and validator require the exact root package manifest", async (t) => {
  const cases = [
    {
      label: "root optionalDependencies",
      mutate: (manifest: Record<string, unknown>) => {
        manifest.optionalDependencies = { pg: "catalog:" };
      },
      pattern:
        /top-level keys mismatch; missing: none; extra: optionalDependencies/u,
    },
    {
      label: "root peerDependencies",
      mutate: (manifest: Record<string, unknown>) => {
        manifest.peerDependencies = { pg: "catalog:" };
      },
      pattern:
        /top-level keys mismatch; missing: none; extra: peerDependencies/u,
    },
    {
      label: "an additional top-level key",
      mutate: (manifest: Record<string, unknown>) => {
        manifest.scripts = {};
      },
      pattern: /top-level keys mismatch; missing: none; extra: scripts/u,
    },
    {
      label: "a wrong dependency value",
      mutate: (manifest: Record<string, unknown>) => {
        (manifest.dependencies as Record<string, string>).pg = "8.22.0";
      },
      pattern: /dependency values mismatch: pg/u,
    },
    {
      label: "an additional dependency",
      mutate: (manifest: Record<string, unknown>) => {
        (manifest.dependencies as Record<string, string>).vitest = "catalog:";
      },
      pattern: /runtime dependencies mismatch; missing: none; extra: vitest/u,
    },
  ];

  for (const { label, mutate, pattern } of cases) {
    await t.test(label, async (t) => {
      const manifest = exactRuntimeManifest();
      mutate(manifest);
      const appRoot = await createRuntimeFilesystem(
        t,
        ({ writeRootManifest }) => writeRootManifest(manifest),
      );

      const snapshot = withImageRdsCaMetadata(
        (await inspectRuntimeImage({ appRoot })) as Snapshot,
      );
      assert.throws(
        () => validateRuntimeSnapshot(snapshot, { expectedRdsCaSha256 }),
        pattern,
      );
    });
  }
});

test("the actual runtime graph accepts an installed optional peer and its absence", async (t) => {
  for (const installed of [true, false]) {
    await t.test(installed ? "installed" : "absent", async (t) => {
      const appRoot = await createRuntimeFilesystem(
        t,
        async ({ writePackage }) => {
          await writePackage("node_modules/pg", {
            main: "index.js",
            name: "pg",
            peerDependenciesMeta: {
              "supports-color": { optional: true },
            },
            version: "1.0.0",
          });
          if (installed) {
            await writePackage("node_modules/supports-color", {
              main: "index.js",
              name: "supports-color",
              version: "10.2.2",
            });
          }
        },
      );

      const snapshot = withImageRdsCaMetadata(
        (await inspectRuntimeImage({ appRoot })) as Snapshot,
      );
      assert.deepEqual(snapshot.dependencyProblems, []);
      assert.doesNotThrow(() =>
        validateRuntimeSnapshot(snapshot, { expectedRdsCaSha256 }),
      );
    });
  }
});

test("the actual runtime graph rejects a disconnected duplicate with a reachable package name", async (t) => {
  const duplicatePath = "node_modules/.pnpm/disconnected/node_modules/pg";
  const appRoot = await createRuntimeFilesystem(t, ({ writePackage }) =>
    writePackage(duplicatePath, {
      main: "index.js",
      name: "pg",
      version: "999.0.0",
    }),
  );

  const snapshot = withImageRdsCaMetadata(
    (await inspectRuntimeImage({ appRoot })) as Snapshot,
  );
  assert.deepEqual(snapshot.dependencyProblems, [
    `extraneous package ${path.join(appRoot, duplicatePath)}`,
  ]);
  assert.throws(
    () => validateRuntimeSnapshot(snapshot, { expectedRdsCaSha256 }),
    /runtime dependency tree reported 1 problem: extraneous package/u,
  );
});

test("the actual runtime graph rejects a disconnected package hidden behind a fake pnpm peer token", async (t) => {
  const fakePeerPath =
    "node_modules/.pnpm/fake_supports-color@10.2.2/node_modules/supports-color";
  const appRoot = await createRuntimeFilesystem(t, ({ writePackage }) =>
    writePackage(fakePeerPath, {
      main: "index.js",
      name: "supports-color",
      version: "10.2.2",
    }),
  );

  const snapshot = withImageRdsCaMetadata(
    (await inspectRuntimeImage({ appRoot })) as Snapshot,
  );
  assert.deepEqual(snapshot.dependencyProblems, [
    `extraneous package ${path.join(appRoot, fakePeerPath)}`,
  ]);
  assert.throws(
    () => validateRuntimeSnapshot(snapshot, { expectedRdsCaSha256 }),
    /runtime dependency tree reported 1 problem: extraneous package/u,
  );
});

test("rejects an unowned project name before issuing a Docker command", async () => {
  const commandRunner = createSuccessfulRunner();
  const verification = createProductionImageVerification({
    commandRunner,
    fetchImpl: () => assert.fail("fetch must not run"),
    log: () => undefined,
    projectName: "unrelated",
    signal: new globalThis.AbortController().signal,
  });

  await assert.rejects(
    verification.verify(),
    /Production image verification requires a generated project name\./u,
  );
  assert.deepEqual(commandRunner.calls, []);
});
