import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  createDeadlineSignal,
  raceOperationAgainstSignal,
} from "./abortable-operation.ts";
import {
  parseRuntimeSnapshot,
  runtimeSnapshotScript,
  validateRuntimeSnapshot,
} from "./runtime-image-inspection.ts";

const generatedProjectNamePattern =
  /^hono-starter-kit-test-[1-9][0-9]*-[0-9a-f]{16}$/u;
const applicationOrigin = "https://d111111abcdef8.cloudfront.net";
const containerCaCertificatePath = "/run/oidc-ca/ca-certificate.pem";
const containerDatabaseCaCertificatePath = "/run/postgres-ca/ca.pem";
const execFileAsync = promisify(execFile);
const expectedRdsCaSha256 = (
  await readFile(
    new URL("../../docker/certs/global-bundle.pem.sha256", import.meta.url),
    "utf8",
  )
)
  .trim()
  .split(/\s+/u)[0];

/** 本番設定で開発用 identity アダプターを選んだ API が、起動を拒否して標準エラーに出す 1 行。 */
export const devAuthRejectionStderr =
  "API startup failed: AUTH_PROVIDER must select an implemented non-Dev provider in production";

const randomProbe = (label: string) =>
  `${label}-${randomBytes(24).toString("base64url")}`;

const assertOwnedTlsDirectory = (directory: string) => {
  const prefix = `${resolve(tmpdir())}/hono-starter-oidc-tls-`;
  const candidate = resolve(directory);
  if (!candidate.startsWith(prefix) || candidate === prefix.slice(0, -1)) {
    throw new Error("Production OIDC TLS directory is not owned.");
  }
  return candidate;
};

const assertOwnedDatabaseTlsDirectory = (directory: string) => {
  const prefix = `${resolve(tmpdir())}/hono-starter-postgres-tls-`;
  const candidate = resolve(directory);
  if (!candidate.startsWith(prefix) || candidate === prefix.slice(0, -1)) {
    throw new Error("Production PostgreSQL TLS directory is not owned.");
  }
  return candidate;
};

const runOpenSsl = async (args: readonly string[]) => {
  try {
    await execFileAsync("openssl", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("Unable to generate production OIDC test TLS material.");
  }
};

export const createProductionOidcFixtureEnvironment = async () => {
  const directory = assertOwnedTlsDirectory(
    await mkdtemp(join(tmpdir(), "hono-starter-oidc-tls-")),
  );
  const caKeyPath = join(directory, "ca-key.pem");
  const caCertificatePath = join(directory, "ca-certificate.pem");
  const serverKeyPath = join(directory, "server-key.pem");
  const serverRequestPath = join(directory, "server-request.pem");
  const serverCertificatePath = join(directory, "server-certificate.pem");
  const serverExtensionsPath = join(directory, "server-extensions.cnf");
  // startOidcFixture は動的 import なので、ここで使う面だけを形として書く。
  let fixture:
    | {
        authorize: (authorizationUrl: URL) => Promise<URL>;
        clientConfig: { clientId: string; logoutEndpoint: string };
        close(): Promise<void>;
        issuer: string;
      }
    | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    if (fixture !== undefined) {
      try {
        await fixture.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await rm(assertOwnedTlsDirectory(directory), {
        force: true,
        recursive: true,
      });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new Error("Production OIDC fixture cleanup failed.");
    }
  };

  try {
    await runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=hono-starter-kit-test-ca",
      "-keyout",
      caKeyPath,
      "-out",
      caCertificatePath,
    ]);
    await runOpenSsl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-subj",
      "/CN=host.docker.internal",
      "-keyout",
      serverKeyPath,
      "-out",
      serverRequestPath,
    ]);
    await writeFile(
      serverExtensionsPath,
      "subjectAltName=DNS:host.docker.internal\nextendedKeyUsage=serverAuth\n",
      { mode: 0o600 },
    );
    await runOpenSsl([
      "x509",
      "-req",
      "-in",
      serverRequestPath,
      "-CA",
      caCertificatePath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      serverExtensionsPath,
      "-out",
      serverCertificatePath,
    ]);
    const { startOidcFixture } =
      await import("../../apps/api-node/src/testing/oidc-fixture.ts");
    const tokenProbe = randomProbe("token");
    const passwordProbe = randomProbe("password");
    fixture = await startOidcFixture({
      accessToken: tokenProbe,
      bindAddress: "0.0.0.0",
      claims: {
        sub: "production-image-subject",
        email: "oidc-image@example.com",
        email_verified: true,
        name: "OIDC Image User",
      },
      issuerHostname: "host.docker.internal",
      redirectUri: `${applicationOrigin}/auth/callback`,
      tls: {
        ca: await readFile(caCertificatePath),
        cert: await readFile(serverCertificatePath),
        key: await readFile(serverKeyPath),
      },
    });
    return Object.freeze({
      authorize: fixture.authorize,
      caCertificatePath,
      cleanup,
      clientId: fixture.clientConfig.clientId,
      issuer: fixture.issuer,
      logoutEndpoint: fixture.clientConfig.logoutEndpoint,
      passwordProbe,
      tokenProbe,
    });
  } catch (error) {
    try {
      await cleanup();
    } catch {
      // 安全な形に整えたフィクスチャ準備のエラーを残す。
    }
    throw error;
  }
};

// Docker を叩く側。実装が使うのは run だけなので、その形だけ要求する。
// 実装は capture / captureStderr の指定で戻り値の形を変える。captureStderr のときだけ
// オブジェクトで、それ以外は標準出力の文字列（capture 無しなら空文字）を返す。
type DockerRunner = {
  run(
    command: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ): Promise<string | { stdout: string; stderr: string }>;
};

export const createProductionDatabaseTlsEnvironment = async ({
  commandRunner,
  databaseContainerName,
  networkName,
  signal,
}: {
  commandRunner: DockerRunner;
  databaseContainerName: string;
  networkName: string;
  signal?: AbortSignal | undefined;
}) => {
  const directory = assertOwnedDatabaseTlsDirectory(
    await mkdtemp(join(tmpdir(), "hono-starter-postgres-tls-")),
  );
  const caKeyPath = join(directory, "ca-key.pem");
  const caCertificatePath = join(directory, "ca.pem");
  const serverKeyPath = join(directory, "server-key.pem");
  const serverRequestPath = join(directory, "server-request.pem");
  const serverCertificatePath = join(directory, "server-certificate.pem");
  const serverExtensionsPath = join(directory, "server-extensions.cnf");
  const passwordPath = join(directory, "password");
  const initSqlPath = join(directory, "001-create-unmigrated.sql");
  const password = randomProbe("database-password");
  let containerCreationAttempted = false;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    if (containerCreationAttempted) {
      let containerMayExist = true;
      try {
        await commandRunner.run(
          "docker",
          ["container", "inspect", databaseContainerName],
          { capture: true, captureStderr: true },
        );
      } catch (error) {
        if (isAlreadyAbsent(error, "container")) {
          containerMayExist = false;
          containerCreationAttempted = false;
        } else {
          failures.push(error);
        }
      }
      if (containerMayExist) {
        try {
          await commandRunner.run(
            "docker",
            ["rm", "--force", databaseContainerName],
            { capture: true, captureStderr: true },
          );
          containerCreationAttempted = false;
        } catch (error) {
          if (isAlreadyAbsent(error, "container")) {
            containerCreationAttempted = false;
          } else {
            failures.push(error);
          }
        }
      }
    }
    try {
      await rm(assertOwnedDatabaseTlsDirectory(directory), {
        force: true,
        recursive: true,
      });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Production PostgreSQL TLS cleanup produced ${failures.length} failures`,
      );
    }
  };

  try {
    await runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=hono-starter-kit-postgres-test-ca",
      "-keyout",
      caKeyPath,
      "-out",
      caCertificatePath,
    ]);
    await runOpenSsl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-subj",
      "/CN=postgres-tls",
      "-keyout",
      serverKeyPath,
      "-out",
      serverRequestPath,
    ]);
    await writeFile(
      serverExtensionsPath,
      "subjectAltName=DNS:postgres-tls\nextendedKeyUsage=serverAuth\n",
      { mode: 0o600 },
    );
    await runOpenSsl([
      "x509",
      "-req",
      "-in",
      serverRequestPath,
      "-CA",
      caCertificatePath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      serverExtensionsPath,
      "-out",
      serverCertificatePath,
    ]);
    await Promise.all([
      writeFile(passwordPath, `${password}\n`, { mode: 0o600 }),
      writeFile(initSqlPath, "CREATE DATABASE starter_unmigrated;\n", {
        mode: 0o600,
      }),
    ]);

    const containerTlsDirectory = "/var/lib/postgresql/tls";
    const bootstrapDirectory = "/run/postgres-bootstrap";
    const startScript = [
      `mkdir -p ${containerTlsDirectory} /docker-entrypoint-initdb.d`,
      `cp ${bootstrapDirectory}/server-certificate.pem ${containerTlsDirectory}/server.crt`,
      `cp ${bootstrapDirectory}/server-key.pem ${containerTlsDirectory}/server.key`,
      `cp ${bootstrapDirectory}/ca.pem ${containerTlsDirectory}/ca.pem`,
      `cp ${bootstrapDirectory}/001-create-unmigrated.sql /docker-entrypoint-initdb.d/001-create-unmigrated.sql`,
      `chown -R postgres:postgres ${containerTlsDirectory} /docker-entrypoint-initdb.d/001-create-unmigrated.sql`,
      `chmod 0600 ${containerTlsDirectory}/server.key`,
      `exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${containerTlsDirectory}/server.crt -c ssl_key_file=${containerTlsDirectory}/server.key -c ssl_ca_file=${containerTlsDirectory}/ca.pem`,
    ].join(" && ");
    containerCreationAttempted = true;
    await commandRunner.run(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        databaseContainerName,
        "--network",
        networkName,
        "--network-alias",
        "postgres-tls",
        "--network-alias",
        "postgres-tls-mismatch",
        "--tmpfs",
        "/var/lib/postgresql/data:rw,noexec,nosuid",
        "--volume",
        `${directory}:${bootstrapDirectory}:ro`,
        "-e",
        "POSTGRES_USER=starter",
        "-e",
        "POSTGRES_DB=starter_image",
        "-e",
        `POSTGRES_PASSWORD_FILE=${bootstrapDirectory}/password`,
        "--entrypoint",
        "sh",
        "postgres:17-alpine",
        "-ceu",
        startScript,
      ],
      { signal },
    );

    const readinessDeadline = Date.now() + 30_000;
    while (true) {
      signal?.throwIfAborted();
      try {
        await commandRunner.run(
          "docker",
          [
            "exec",
            databaseContainerName,
            "pg_isready",
            "--host",
            "127.0.0.1",
            "--port",
            "5432",
            "--username",
            "starter",
            "--dbname",
            "starter_image",
          ],
          { capture: true, signal },
        );
        break;
      } catch {
        signal?.throwIfAborted();
        if (Date.now() >= readinessDeadline) {
          throw new Error(
            "Production PostgreSQL TLS fixture did not become ready.",
          );
        }
        await delay(250, undefined, { signal });
      }
    }

    return Object.freeze({
      caCertificatePath,
      cleanup,
      host: "postgres-tls",
      mismatchHost: "postgres-tls-mismatch",
      password,
      port: "5432",
      user: "starter",
    });
  } catch (error) {
    const cleanupFailures = [];
    try {
      await cleanup();
    } catch (cleanupFailure) {
      if (cleanupFailure instanceof AggregateError) {
        cleanupFailures.push(...(cleanupFailure.errors as unknown[]));
      } else {
        cleanupFailures.push(cleanupFailure);
      }
    }
    throw combineFailures(error, cleanupFailures);
  }
};
const combineFailures = (
  primaryFailure: unknown,
  cleanupFailures: readonly unknown[],
) => {
  if (cleanupFailures.length === 0) return primaryFailure;
  return new AggregateError(
    [primaryFailure, ...cleanupFailures],
    `Production image verification and cleanup produced ${cleanupFailures.length + 1} failures`,
    { cause: primaryFailure },
  );
};

// docker の失敗には stdout / stderr / exitStatus が後付けされる。読み方をここに集約する。
type CapturedFailure = {
  stderr?: unknown;
  stdout?: unknown;
  exitStatus?: unknown;
};
const captured = (error: unknown) => error as CapturedFailure | undefined;
const capturedStderr = (error: unknown) => {
  const value = captured(error)?.stderr;
  return typeof value === "string" ? value.trim() : undefined;
};
const capturedStdout = (error: unknown) => {
  const value = captured(error)?.stdout;
  return typeof value === "string" ? value.trim() : undefined;
};
const capturedExitStatus = (error: unknown) => {
  const value = captured(error)?.exitStatus;
  return Number.isInteger(value) ? (value as number) : undefined;
};

type DatabaseEnvironment = {
  caCertificatePath: string;
  host: string;
  password: string;
  port: number | string;
  user: string;
};

const structuredDatabaseDockerArguments = ({
  databaseEnvironment,
  databaseName,
  host = databaseEnvironment.host,
}: {
  databaseEnvironment: DatabaseEnvironment;
  databaseName: string;
  host?: string;
}) => [
  "--volume",
  `${databaseEnvironment.caCertificatePath}:${containerDatabaseCaCertificatePath}:ro`,
  "-e",
  `PGHOST=${host}`,
  "-e",
  `PGPORT=${databaseEnvironment.port}`,
  "-e",
  `PGDATABASE=${databaseName}`,
  "-e",
  `PGUSER=${databaseEnvironment.user}`,
  "-e",
  `PGPASSWORD=${databaseEnvironment.password}`,
  "-e",
  `PGSSLROOTCERT=${containerDatabaseCaCertificatePath}`,
];

const isAlreadyAbsent = (error: unknown, resource: string) => {
  const stderr = capturedStderr(error);
  return (
    stderr !== undefined &&
    (resource === "container"
      ? /(?:No such container|is not running)/u.test(stderr)
      : /No such image/u.test(stderr))
  );
};

const parsePublishedPort = (output: unknown) => {
  const stdout =
    typeof output === "string" ? output : (capturedStdout(output) ?? "");
  const match = /127\.0\.0\.1:(\d+)$/u.exec(stdout.trim());
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Unable to parse the production image API port.");
  }
  return port;
};

const requireExactSafeFailure = async ({
  args,
  commandRunner,
  expectedStderr,
  forbiddenValues,
  label,
  signal,
}: {
  args: readonly string[];
  commandRunner: DockerRunner;
  expectedStderr: string;
  forbiddenValues: readonly unknown[];
  label: string;
  signal?: AbortSignal | undefined;
}) => {
  let actualStdout: string | undefined;
  let actualStderr: string | undefined;
  let exitStatus = 0;
  try {
    const output = await commandRunner.run("docker", args, {
      capture: true,
      captureStderr: true,
      signal,
    });
    signal?.throwIfAborted();
    actualStdout = capturedStdout(output);
    actualStderr = capturedStderr(output);
  } catch (error) {
    signal?.throwIfAborted();
    actualStdout = capturedStdout(error);
    actualStderr = capturedStderr(error);
    exitStatus = capturedExitStatus(error) ?? 0;
  }
  signal?.throwIfAborted();

  const capturedChannels = [actualStdout, actualStderr];
  const containsForbiddenValue = forbiddenValues.some(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      capturedChannels.some((channel) => channel?.includes(value)),
  );
  if (
    exitStatus !== 1 ||
    actualStdout !== "" ||
    actualStderr !== expectedStderr ||
    containsForbiddenValue
  ) {
    throw new Error(
      `Production image ${label} did not match the expected safe error.`,
    );
  }
};

const waitForHealth = async ({
  fetchImpl,
  origin,
  signal,
  timeoutMs,
}: {
  fetchImpl: typeof globalThis.fetch;
  origin: string;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  const deadlineSignal = createDeadlineSignal({ signal, timeoutMs });
  let lastFailure: unknown;
  const throwTimeout = (): never => {
    // 直前の失敗をそのまま伝える。包み直すと呼び出し側の判定が変わる。
    throw (
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      lastFailure ?? new Error("Production image API did not become ready.")
    );
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      if (deadlineSignal.cause() === "deadline") throwTimeout();
      try {
        const response = await raceOperationAgainstSignal(
          () =>
            fetchImpl(`${origin}/healthz`, {
              signal: deadlineSignal.signal,
            }),
          deadlineSignal.signal,
        );
        assert.equal(
          response.status,
          200,
          `Production image health returned ${response.status}.`,
        );
        return;
      } catch (error) {
        if (deadlineSignal.cause() === "workflow") {
          throw deadlineSignal.signal.reason;
        }
        if (deadlineSignal.cause() === "deadline") throwTimeout();
        lastFailure = error;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throwTimeout();
      await delay(Math.min(250, remainingMs), undefined, { signal });
    }
  } finally {
    deadlineSignal.dispose();
  }
};

const parseJson = async (
  response: { json(): Promise<unknown> },
  label: string,
  signal?: AbortSignal,
): Promise<unknown> => {
  try {
    return await raceOperationAgainstSignal(
      () => response.json(),
      signal ?? new AbortController().signal,
    );
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Production image ${label} returned malformed JSON.`);
  }
};

const cookiePairNamed = (
  setCookie: string | null | undefined,
  name: string,
) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|,\\s*)(${escapedName}=[^;,\\s]+)`, "u").exec(
    setCookie ?? "",
  )?.[1];
};

const decodeTransactionCookie = (cookiePair: string) => {
  const separator = cookiePair.indexOf("=");
  if (separator <= 0) throw new Error();
  const parsed: unknown = JSON.parse(
    Buffer.from(cookiePair.slice(separator + 1), "base64url").toString("utf8"),
  );
  const candidate = parsed as { nonce?: unknown; verifier?: unknown } | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof candidate?.nonce !== "string" ||
    typeof candidate.verifier !== "string"
  ) {
    throw new Error();
  }
  return { nonce: candidate.nonce, verifier: candidate.verifier };
};

export const requestCallbackThroughLocalOrigin = ({
  callbackUrl,
  headers,
  origin,
  signal,
}: {
  callbackUrl: URL | string;
  headers: Headers;
  origin: string;
  signal?: AbortSignal | undefined;
}) => {
  const connection = new URL(origin);
  const callback = new URL(callbackUrl);
  return new Promise<Response>((resolveResponse, reject) => {
    const request = requestHttp(
      {
        headers: Object.fromEntries(headers.entries()),
        hostname: connection.hostname,
        method: "GET",
        path: `${callback.pathname}${callback.search}`,
        port: connection.port,
        signal,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode;
          if (status === undefined) {
            reject(new Error("Production callback response had no status."));
            return;
          }
          const responseHeaders = new globalThis.Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(
              response.rawHeaders[index] ?? "",
              response.rawHeaders[index + 1] ?? "",
            );
          }
          resolveResponse(
            new globalThis.Response(null, {
              headers: responseHeaders,
              status,
            }),
          );
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
};

// /api/me の応答のうち、この検証が読む面だけ。
type MeResponse = {
  user?: { displayName?: unknown; email?: unknown; roles?: unknown };
};

const verifyOidcAuthenticatedFlow = async ({
  databaseForbiddenValues,
  fetchImpl,
  oidcEnvironment,
  onTraceEvidence,
  origin,
  requestCallback,
  signal,
}: {
  databaseForbiddenValues: readonly unknown[];
  fetchImpl: typeof globalThis.fetch;
  oidcEnvironment: {
    authorize: (authorizationUrl: URL) => Promise<URL>;
    clientId: string;
    issuer: string;
    logoutEndpoint: string;
    passwordProbe: string;
    tokenProbe: string;
  };
  onTraceEvidence?: ((evidence: unknown) => Promise<void>) | undefined;
  origin: string;
  requestCallback: typeof requestCallbackThroughLocalOrigin;
  signal: AbortSignal;
}) => {
  let stage = "login";
  const fetchApi = (path: string, init: RequestInit = {}) =>
    raceOperationAgainstSignal(
      () => fetchImpl(`${origin}${path}`, { ...init, signal }),
      signal,
    );
  try {
    const loginResponse = await fetchApi("/auth/login?returnTo=%2Fprojects", {
      redirect: "manual",
    });
    assert.equal(loginResponse.status, 303);
    const authorizationLocation = loginResponse.headers.get("location");
    assert.ok(authorizationLocation);
    const authorizationUrl = new URL(authorizationLocation);
    assert.equal(
      authorizationUrl.origin,
      new URL(oidcEnvironment.issuer).origin,
    );
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    stage = "transaction-cookie";
    const transactionCookie = cookiePairNamed(
      loginResponse.headers.get("set-cookie"),
      "__Secure-oidc-transaction",
    );
    assert.ok(transactionCookie);
    const { nonce, verifier } = decodeTransactionCookie(transactionCookie);

    stage = "provider-authorization";
    const providerCallback = await oidcEnvironment.authorize(authorizationUrl);
    const callbackState = providerCallback.searchParams.get("state");
    const code = providerCallback.searchParams.get("code");
    assert.equal(callbackState, state);
    assert.ok(code);
    const traceId = randomBytes(16).toString("hex");
    const parentSpanId = randomBytes(8).toString("hex");
    const callbackHeaders = new globalThis.Headers({
      Cookie: transactionCookie,
      traceparent: `00-${traceId}-${parentSpanId}-01`,
    });
    stage = "callback";
    const callbackResponse = await requestCallback({
      callbackUrl: providerCallback,
      headers: callbackHeaders,
      origin,
      signal,
    });
    assert.equal(callbackResponse.status, 303);
    assert.equal(callbackResponse.headers.get("location"), "/projects");
    const applicationCookie = cookiePairNamed(
      callbackResponse.headers.get("set-cookie"),
      "__Host-session",
    );
    assert.ok(applicationCookie);
    const requestId = callbackResponse.headers.get("x-request-id");
    assert.ok(requestId);

    stage = "authenticated-identity";
    const meResponse = await fetchApi("/api/me", {
      headers: { Cookie: applicationCookie },
    });
    assert.equal(meResponse.status, 200);
    const me = await parseJson(meResponse, "/api/me", signal);
    assert.deepEqual(
      {
        displayName: (me as MeResponse)?.user?.displayName,
        email: (me as MeResponse)?.user?.email,
        roles: (me as MeResponse)?.user?.roles,
      },
      {
        displayName: "OIDC Image User",
        email: "oidc-image@example.com",
        roles: [],
      },
    );

    stage = "provider-logout";
    const logoutResponse = await fetchApi("/auth/provider-logout", {
      redirect: "manual",
    });
    assert.equal(logoutResponse.status, 303);
    const logoutLocationHeader = logoutResponse.headers.get("location");
    assert.ok(logoutLocationHeader);
    const logoutLocation = new URL(logoutLocationHeader);
    assert.equal(
      logoutLocation.origin + logoutLocation.pathname,
      oidcEnvironment.logoutEndpoint,
    );
    assert.equal(
      logoutLocation.searchParams.get("client_id"),
      oidcEnvironment.clientId,
    );
    assert.equal(
      logoutLocation.searchParams.get("logout_uri"),
      `${applicationOrigin}/login`,
    );
    assert.equal(
      logoutLocation.searchParams.has("post_logout_redirect_uri"),
      false,
    );

    const forbiddenValues = [
      state,
      nonce,
      verifier,
      code,
      oidcEnvironment.tokenProbe,
      oidcEnvironment.passwordProbe,
      transactionCookie,
      transactionCookie.slice(transactionCookie.indexOf("=") + 1),
      applicationCookie,
      applicationCookie.slice(applicationCookie.indexOf("=") + 1),
      ...databaseForbiddenValues,
    ];
    stage = "trace-evidence";
    await onTraceEvidence?.({
      // traceparent を付けたのはコールバックの要求なので、その route の名前を期待する。
      expectedServerSpanName: "GET /auth/callback",
      expectedTraceId: traceId,
      forbiddenValues,
      requestId,
    });
    return { applicationCookie, forbiddenValues };
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      `Production image OIDC flow verification failed at ${stage}.`,
    );
  }
};

export const createProductionImageVerification = ({
  commandRunner,
  createDatabaseTlsEnvironment = createProductionDatabaseTlsEnvironment,
  createOidcFixtureEnvironment = createProductionOidcFixtureEnvironment,
  fetchImpl = globalThis.fetch,
  healthTimeoutMs = 30_000,
  log = () => undefined,
  onApiPort = () => undefined,
  onTraceEvidence = () => Promise.resolve(),
  projectName,
  requestCallback = requestCallbackThroughLocalOrigin,
  signal = new globalThis.AbortController().signal,
}: {
  commandRunner: DockerRunner;
  createDatabaseTlsEnvironment?: typeof createProductionDatabaseTlsEnvironment;
  createOidcFixtureEnvironment?: typeof createProductionOidcFixtureEnvironment;
  fetchImpl?: typeof globalThis.fetch;
  healthTimeoutMs?: number;
  log?: (message: string) => void;
  onApiPort?: (port: number) => void;
  onTraceEvidence?: (evidence: unknown) => Promise<void>;
  projectName: string;
  requestCallback?: typeof requestCallbackThroughLocalOrigin;
  signal?: AbortSignal;
}) => {
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
  let imageCreationAttempted = false;
  let apiContainerCreationAttempted = false;
  const attemptedOneShotContainers = new Set<string>();
  let databaseEnvironment:
    | Awaited<ReturnType<typeof createProductionDatabaseTlsEnvironment>>
    | undefined;
  let oidcEnvironment:
    | Awaited<ReturnType<typeof createProductionOidcFixtureEnvironment>>
    | undefined;
  let publishedApiPort: number | undefined;
  let cleanupPromise: Promise<unknown> | undefined;
  let verificationPromise: Promise<unknown> | undefined;

  const run = (
    args: readonly string[],
    options: Record<string, unknown> = {},
  ) => commandRunner.run("docker", args, { ...options, signal });
  const runCaptured = (args: readonly string[]) => run(args, { capture: true });

  const reportApiPort = (apiPort: number) => {
    if (publishedApiPort !== undefined) {
      if (publishedApiPort !== apiPort) {
        throw new Error("Production image API port changed unexpectedly.");
      }
      return;
    }
    onApiPort(apiPort);
    publishedApiPort = apiPort;
  };

  const cleanupOwnedResources = async () => {
    const failures: unknown[] = [];
    if (apiContainerCreationAttempted) {
      let containerMayExist = true;
      try {
        await commandRunner.run(
          "docker",
          ["container", "inspect", apiContainerName],
          {
            capture: true,
            captureStderr: true,
          },
        );
      } catch (error) {
        if (isAlreadyAbsent(error, "container")) {
          containerMayExist = false;
          apiContainerCreationAttempted = false;
        } else {
          failures.push(error);
        }
      }
      if (containerMayExist && publishedApiPort === undefined) {
        try {
          const apiPort = parsePublishedPort(
            await commandRunner.run(
              "docker",
              ["port", apiContainerName, "3000/tcp"],
              { capture: true, captureStderr: true },
            ),
          );
          reportApiPort(apiPort);
          log(`Recovered production image API port 127.0.0.1:${apiPort}`);
        } catch (error) {
          if (isAlreadyAbsent(error, "container")) {
            containerMayExist = false;
            apiContainerCreationAttempted = false;
          } else {
            failures.push(error);
          }
        }
      }
      if (containerMayExist) {
        try {
          await commandRunner.run(
            "docker",
            ["rm", "--force", apiContainerName],
            {
              capture: true,
              captureStderr: true,
            },
          );
          apiContainerCreationAttempted = false;
          log(`Removed production image API container ${apiContainerName}`);
        } catch (error) {
          if (isAlreadyAbsent(error, "container")) {
            apiContainerCreationAttempted = false;
          } else {
            failures.push(error);
          }
        }
      }
    }
    for (const containerName of [...attemptedOneShotContainers]) {
      let containerMayExist = true;
      try {
        await commandRunner.run(
          "docker",
          ["container", "inspect", containerName],
          {
            capture: true,
            captureStderr: true,
          },
        );
      } catch (error) {
        if (isAlreadyAbsent(error, "container")) {
          containerMayExist = false;
          attemptedOneShotContainers.delete(containerName);
        } else {
          failures.push(error);
        }
      }
      if (containerMayExist) {
        try {
          await commandRunner.run("docker", ["rm", "--force", containerName], {
            capture: true,
            captureStderr: true,
          });
          attemptedOneShotContainers.delete(containerName);
          log(`Removed production one-shot container ${containerName}`);
        } catch (error) {
          if (isAlreadyAbsent(error, "container")) {
            attemptedOneShotContainers.delete(containerName);
          } else {
            failures.push(error);
          }
        }
      }
    }
    if (oidcEnvironment !== undefined) {
      try {
        await oidcEnvironment.cleanup();
        oidcEnvironment = undefined;
        log("Removed production OIDC fixture and TLS directory");
      } catch (error) {
        failures.push(error);
      }
    }
    if (databaseEnvironment !== undefined) {
      try {
        await databaseEnvironment.cleanup();
        databaseEnvironment = undefined;
        log("Removed production PostgreSQL TLS fixture and TLS directory");
      } catch (error) {
        failures.push(error);
      }
    }
    if (imageCreationAttempted) {
      try {
        await commandRunner.run("docker", ["image", "rm", imageTag], {
          capture: true,
          captureStderr: true,
        });
        imageCreationAttempted = false;
        log(`Removed production image ${imageTag}`);
      } catch (error) {
        if (isAlreadyAbsent(error, "image")) {
          imageCreationAttempted = false;
        } else {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Production image cleanup produced ${failures.length} failures`,
      );
    }
  };

  const cleanup = () => (cleanupPromise ??= cleanupOwnedResources());

  const runOneShot = async (
    containerName: string,
    args: readonly string[],
    options: Record<string, unknown> = {},
  ) => {
    attemptedOneShotContainers.add(containerName);
    try {
      return await run(
        ["run", "--rm", "--name", containerName, ...args],
        options,
      );
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  };

  const performVerification = async () => {
    if (!generatedProjectNamePattern.test(projectName)) {
      throw new Error(
        "Production image verification requires a generated project name.",
      );
    }
    signal?.throwIfAborted();

    const existingImage = await runCaptured([
      "image",
      "ls",
      "--quiet",
      "--no-trunc",
      "--filter",
      `reference=${imageTag}`,
    ]);
    if (existingImage !== "") {
      throw new Error(
        "Production image verification refuses a pre-existing exact image.",
      );
    }
    for (const containerName of exactContainerNames) {
      const existingContainer = await runCaptured([
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `name=^/${containerName}$`,
      ]);
      if (existingContainer !== "") {
        throw new Error(
          "Production image verification refuses a pre-existing exact container.",
        );
      }
    }

    imageCreationAttempted = true;
    await run([
      "build",
      "--tag",
      imageTag,
      "--file",
      "docker/api.Dockerfile",
      ".",
    ]);
    log(`Built production image ${imageTag}`);

    databaseEnvironment = await createDatabaseTlsEnvironment({
      commandRunner,
      databaseContainerName,
      networkName,
      signal,
    });
    signal?.throwIfAborted();
    log("Started owned production PostgreSQL TLS fixture");

    let migrationOutput;
    try {
      migrationOutput = await runOneShot(
        oneShotContainerNames.migration,
        [
          "--network",
          networkName,
          ...structuredDatabaseDockerArguments({
            databaseEnvironment,
            databaseName: "starter_image",
          }),
          imageTag,
          "node",
          "/app/migrate.mjs",
        ],
        { capture: true, captureStderr: true },
      );
    } catch {
      signal?.throwIfAborted();
      throw new Error("Production image database migration failed.");
    }
    const migrationOutputChannels = [
      typeof migrationOutput === "string"
        ? migrationOutput
        : capturedStdout(migrationOutput),
      capturedStderr(migrationOutput),
    ];
    if (
      migrationOutputChannels.some((channel) =>
        channel?.includes(databaseEnvironment?.password ?? ""),
      )
    ) {
      throw new Error(
        "Production image database migration output contained forbidden database material.",
      );
    }
    log("Applied production image migrations to starter_image");

    oidcEnvironment = await createOidcFixtureEnvironment();
    signal?.throwIfAborted();
    log("Started owned HTTPS production OIDC fixture");

    apiContainerCreationAttempted = true;
    await run([
      "run",
      "--detach",
      "--name",
      apiContainerName,
      "--network",
      networkName,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--volume",
      `${oidcEnvironment.caCertificatePath}:${containerCaCertificatePath}:ro`,
      ...structuredDatabaseDockerArguments({
        databaseEnvironment,
        databaseName: "starter_image",
      }),
      "-e",
      "NODE_ENV=production",
      "-e",
      "AUTH_PROVIDER=oidc",
      "-e",
      "MIGRATIONS_DIRECTORY=/app/migrations",
      "-e",
      `APP_ORIGIN=${applicationOrigin}`,
      "-e",
      `OIDC_ISSUER=${oidcEnvironment.issuer}`,
      "-e",
      `OIDC_CLIENT_ID=${oidcEnvironment.clientId}`,
      "-e",
      `OIDC_LOGOUT_ENDPOINT=${oidcEnvironment.logoutEndpoint}`,
      "-e",
      `NODE_EXTRA_CA_CERTS=${containerCaCertificatePath}`,
      "-e",
      "OTEL_TRACES_EXPORTER=otlp",
      "-e",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318",
      "-e",
      "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
      "--publish",
      "127.0.0.1::3000",
      imageTag,
    ]);
    const apiPort = parsePublishedPort(
      await runCaptured(["port", apiContainerName, "3000/tcp"]),
    );
    reportApiPort(apiPort);
    log(`Production image API published on 127.0.0.1:${apiPort}`);

    const uidOutput = await runCaptured(["exec", apiContainerName, "id", "-u"]);
    const uid = Number(uidOutput);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      throw new Error("Production image API must run as a non-root UID.");
    }
    log(`Validated production image API non-root UID ${uid}`);

    const gidOutput = await runCaptured(["exec", apiContainerName, "id", "-g"]);
    const gid = Number(gidOutput);
    if (!Number.isSafeInteger(gid) || gid < 0) {
      throw new Error("Production image API must run with a valid GID.");
    }
    log(`Validated production image API GID ${gid}`);

    const parsedSnapshot = parseRuntimeSnapshot(
      (await runOneShot(
        oneShotContainerNames.runtimeInspection,
        [
          "--entrypoint",
          "node",
          imageTag,
          "--input-type=module",
          "--eval",
          runtimeSnapshotScript,
        ],
        { capture: true },
      )) as string,
    );
    const runtimeSnapshot = validateRuntimeSnapshot(parsedSnapshot, {
      ...(expectedRdsCaSha256 === undefined ? {} : { expectedRdsCaSha256 }),
      expectedRuntimeGid: gid,
      expectedRuntimeUid: uid,
    });
    log(
      `Validated production image RDS CA ${JSON.stringify({
        appendErrorCode: runtimeSnapshot.rdsCa.appendErrorCode,
        chmodErrorCode: runtimeSnapshot.rdsCa.chmodErrorCode,
        directory: {
          gid: runtimeSnapshot.rdsCa.directory.gid,
          mode: runtimeSnapshot.rdsCa.directory.mode
            .toString(8)
            .padStart(4, "0"),
          uid: runtimeSnapshot.rdsCa.directory.uid,
        },
        file: {
          gid: runtimeSnapshot.rdsCa.gid,
          mode: runtimeSnapshot.rdsCa.mode.toString(8).padStart(4, "0"),
          uid: runtimeSnapshot.rdsCa.uid,
        },
        inspector: runtimeSnapshot.rdsCa.inspector,
        replaceErrorCode: runtimeSnapshot.rdsCa.replaceErrorCode,
        unlinkErrorCode: runtimeSnapshot.rdsCa.unlinkErrorCode,
      })}`,
    );
    if (
      runtimeSnapshot.installedPackages.some(
        (installedPackage) => installedPackage.name === "jose",
      )
    ) {
      throw new Error("Production image contains forbidden jose package.");
    }
    log("Validated production image recursive runtime allow-list");

    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    await waitForHealth({
      fetchImpl,
      origin: apiOrigin,
      signal,
      timeoutMs: healthTimeoutMs,
    });
    log(`Validated production image health on 127.0.0.1:${apiPort}`);

    const { applicationCookie, forbiddenValues } =
      await verifyOidcAuthenticatedFlow({
        databaseForbiddenValues: [databaseEnvironment.password],
        fetchImpl,
        oidcEnvironment,
        onTraceEvidence,
        origin: apiOrigin,
        requestCallback,
        signal,
      });
    const cookieValue = applicationCookie.slice(
      applicationCookie.indexOf("=") + 1,
    );
    log(
      `Validated authenticated production image OIDC flow on 127.0.0.1:${apiPort}`,
    );

    const containerLogs = await run(["logs", apiContainerName], {
      capture: true,
      captureStderr: true,
    });
    const logChannels = [
      typeof containerLogs === "string"
        ? containerLogs
        : capturedStdout(containerLogs),
      capturedStderr(containerLogs),
    ];
    if (
      forbiddenValues.some((value) =>
        logChannels.some(
          (channel) =>
            typeof channel === "string" &&
            typeof value === "string" &&
            channel.includes(value),
        ),
      )
    ) {
      throw new Error(
        "Production image logs contained forbidden auth material.",
      );
    }
    log("Validated production image stdout and stderr redaction");

    attemptedOneShotContainers.add(oneShotContainerNames.devAuth);
    await requireExactSafeFailure({
      args: [
        "run",
        "--rm",
        "--name",
        oneShotContainerNames.devAuth,
        "--network",
        "none",
        "-e",
        "NODE_ENV=production",
        "-e",
        "AUTH_PROVIDER=dev",
        imageTag,
      ],
      commandRunner,
      expectedStderr: devAuthRejectionStderr,
      forbiddenValues,
      label: "Dev Auth rejection",
      signal,
    });
    log("Validated production image Dev Auth rejection");

    attemptedOneShotContainers.add(oneShotContainerNames.httpIssuer);
    await requireExactSafeFailure({
      args: [
        "run",
        "--rm",
        "--name",
        oneShotContainerNames.httpIssuer,
        "--network",
        "none",
        "-e",
        "NODE_ENV=production",
        "-e",
        "AUTH_PROVIDER=oidc",
        "-e",
        `APP_ORIGIN=${applicationOrigin}`,
        "-e",
        "OIDC_ISSUER=http://issuer.example",
        "-e",
        `OIDC_CLIENT_ID=${oidcEnvironment.clientId}`,
        "-e",
        `OIDC_LOGOUT_ENDPOINT=${oidcEnvironment.logoutEndpoint}`,
        imageTag,
      ],
      commandRunner,
      expectedStderr: "API startup failed: OIDC requires HTTPS in production",
      forbiddenValues,
      label: "HTTP OIDC issuer rejection",
      signal,
    });
    log("Validated production image HTTP OIDC issuer rejection");

    // 本番イメージにテスト用フィクスチャが同梱されていないことを、
    // 「モジュールが見つからない」偶然ではなく明示的な起動失敗として確認する。
    attemptedOneShotContainers.add(oneShotContainerNames.testEnvironment);
    await requireExactSafeFailure({
      args: [
        "run",
        "--rm",
        "--name",
        oneShotContainerNames.testEnvironment,
        "--network",
        "none",
        "-e",
        "NODE_ENV=test",
        imageTag,
      ],
      commandRunner,
      expectedStderr:
        "API startup failed: NODE_ENV=test requires development-only fixtures that are excluded from the production runtime bundle",
      forbiddenValues,
      label: "test environment rejection",
      signal,
    });
    log("Validated production image test environment rejection");

    attemptedOneShotContainers.add(oneShotContainerNames.unmigrated);
    await requireExactSafeFailure({
      args: [
        "run",
        "--rm",
        "--name",
        oneShotContainerNames.unmigrated,
        "--network",
        networkName,
        ...structuredDatabaseDockerArguments({
          databaseEnvironment,
          databaseName: "starter_unmigrated",
        }),
        "-e",
        "NODE_ENV=production",
        "-e",
        "AUTH_PROVIDER=oidc",
        "-e",
        "MIGRATIONS_DIRECTORY=/app/migrations",
        "-e",
        `APP_ORIGIN=${applicationOrigin}`,
        "-e",
        `OIDC_ISSUER=${oidcEnvironment.issuer}`,
        "-e",
        `OIDC_CLIENT_ID=${oidcEnvironment.clientId}`,
        "-e",
        `OIDC_LOGOUT_ENDPOINT=${oidcEnvironment.logoutEndpoint}`,
        imageTag,
      ],
      commandRunner,
      expectedStderr:
        'API startup failed: Database migrations are not initialized. Run "pnpm db:migrate".',
      forbiddenValues,
      label: "unmigrated database rejection",
      signal,
    });
    log("Validated production image unmigrated database rejection");

    attemptedOneShotContainers.add(oneShotContainerNames.tlsHostname);
    await requireExactSafeFailure({
      args: [
        "run",
        "--rm",
        "--name",
        oneShotContainerNames.tlsHostname,
        "--network",
        networkName,
        ...structuredDatabaseDockerArguments({
          databaseEnvironment,
          databaseName: "starter_image",
          host: databaseEnvironment.mismatchHost,
        }),
        "-e",
        "NODE_ENV=production",
        "-e",
        "AUTH_PROVIDER=oidc",
        "-e",
        `APP_ORIGIN=${applicationOrigin}`,
        "-e",
        `OIDC_ISSUER=${oidcEnvironment.issuer}`,
        "-e",
        `OIDC_CLIENT_ID=${oidcEnvironment.clientId}`,
        "-e",
        `OIDC_LOGOUT_ENDPOINT=${oidcEnvironment.logoutEndpoint}`,
        imageTag,
      ],
      commandRunner,
      expectedStderr:
        "API startup failed: Unable to connect to PostgreSQL. Check database availability and configuration.",
      forbiddenValues,
      label: "PostgreSQL TLS hostname rejection",
      signal,
    });
    log("Validated production image PostgreSQL TLS hostname rejection");

    attemptedOneShotContainers.add(oneShotContainerNames.missingDatabaseUrl);
    await requireExactSafeFailure({
      args: [
        "run",
        "--rm",
        "--name",
        oneShotContainerNames.missingDatabaseUrl,
        "--network",
        "none",
        imageTag,
        "node",
        "/app/migrate.mjs",
      ],
      commandRunner,
      expectedStderr: "DATABASE_URL is required in production",
      forbiddenValues: [...forbiddenValues, applicationCookie, cookieValue],
      label: "missing DATABASE_URL rejection",
      signal,
    });
    log("Validated production image missing DATABASE_URL rejection");

    return Object.freeze({ apiPort });
  };

  const verify = () => {
    verificationPromise ??= (async () => {
      try {
        return await performVerification();
      } catch (primaryFailure) {
        const cleanupFailures = [];
        try {
          await cleanup();
        } catch (cleanupFailure) {
          if (cleanupFailure instanceof AggregateError) {
            cleanupFailures.push(...(cleanupFailure.errors as unknown[]));
          } else {
            cleanupFailures.push(cleanupFailure);
          }
        }
        throw combineFailures(primaryFailure, cleanupFailures);
      }
    })();
    return verificationPromise;
  };

  return Object.freeze({ cleanup, verify });
};
