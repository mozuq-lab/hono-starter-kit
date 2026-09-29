import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseConnectionConfig } from "@starter/database";
import {
  createDatabasePassword,
  type SecretClient,
} from "./database-password.js";
import {
  resolveNodeEnvironment,
  type NodeEnvironment,
} from "./node-environment.js";

// compose.yaml が立てるローカル DB に合わせた開発時の既定値。
// production では既定値を持たせず、DATABASE_URL 未設定を起動失敗にする。
const defaultDevelopmentDatabaseUrl =
  "postgresql://starter:starter@127.0.0.1:5432/starter";

const structuredKeys = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSWORD_SECRET_ARN",
  "PGSSLROOTCERT",
] as const;

export type DatabaseEnvironment = Readonly<{
  DATABASE_URL?: string;
  PGHOST?: string;
  PGPORT?: string;
  PGDATABASE?: string;
  PGUSER?: string;
  PGPASSWORD?: string;
  PGPASSWORD_SECRET_ARN?: string;
  PGSSLROOTCERT?: string;
}>;

export type ResolveDatabaseConfig = (
  input: {
    nodeEnv: string | undefined;
    databaseEnvironment: DatabaseEnvironment;
  },
  dependencies?: {
    createDatabasePassword?: typeof createDatabasePassword;
    // プロセスで 1 つの client。寿命（destroy）は呼び出し側の composition が持つ。
    secretClient?: SecretClient;
    parseCertificates?: (pem: string) => void;
    readFile?: typeof readFile;
  },
) => Promise<DatabaseConnectionConfig>;

const invalidDatabaseUrl = () =>
  new Error("DATABASE_URL must be a valid PostgreSQL URL");

const missingDatabaseUrl = (environment: NodeEnvironment): Error =>
  environment === "production"
    ? new Error("DATABASE_URL is required in production")
    : new Error("DATABASE_URL is unavailable in test runtime");

const parseCertificates = (pem: string): void => {
  const certificateBlocks = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (
    certificateBlocks === null ||
    certificateBlocks.length === 0 ||
    pem
      .replace(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
        "",
      )
      .trim() !== ""
  ) {
    throw new Error(
      "Certificate bundle must contain only complete PEM certificates",
    );
  }
  for (const certificate of certificateBlocks) {
    new X509Certificate(certificate);
  }
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return true;
    }
  }
  return false;
};

export const resolveDatabaseConfig: ResolveDatabaseConfig = async (
  { nodeEnv, databaseEnvironment },
  dependencies = {},
) => {
  const environment = resolveNodeEnvironment(nodeEnv);
  const hasStructuredSetting = structuredKeys.some(
    (key) => databaseEnvironment[key] !== undefined,
  );

  if (databaseEnvironment.DATABASE_URL !== undefined && hasStructuredSetting) {
    throw new Error(
      "DATABASE_URL cannot be combined with structured PostgreSQL settings",
    );
  }

  if (!hasStructuredSetting) {
    const explicitConnectionString = databaseEnvironment.DATABASE_URL;
    const connectionString =
      explicitConnectionString === undefined ||
      explicitConnectionString.trim() === ""
        ? environment === "development"
          ? defaultDevelopmentDatabaseUrl
          : undefined
        : explicitConnectionString;
    if (connectionString === undefined) {
      throw missingDatabaseUrl(environment);
    }

    let parsed: URL;
    try {
      parsed = new URL(connectionString);
    } catch {
      throw invalidDatabaseUrl();
    }
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw invalidDatabaseUrl();
    }
    return { mode: "url", connectionString };
  }

  const {
    PGHOST,
    PGPORT,
    PGDATABASE,
    PGUSER,
    PGPASSWORD,
    PGPASSWORD_SECRET_ARN,
    PGSSLROOTCERT,
  } = databaseEnvironment;
  if (PGPASSWORD !== undefined && PGPASSWORD_SECRET_ARN !== undefined) {
    throw new Error("PGPASSWORD cannot be combined with PGPASSWORD_SECRET_ARN");
  }
  if (
    PGHOST === undefined ||
    PGPORT === undefined ||
    PGDATABASE === undefined ||
    PGUSER === undefined ||
    (PGPASSWORD === undefined && PGPASSWORD_SECRET_ARN === undefined) ||
    PGSSLROOTCERT === undefined
  ) {
    throw new Error(
      "Structured PostgreSQL configuration requires PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD or PGPASSWORD_SECRET_ARN, and PGSSLROOTCERT",
    );
  }

  const host = PGHOST.trim();
  const database = PGDATABASE.trim();
  if (
    host === "" ||
    database === "" ||
    hasControlCharacter(host) ||
    hasControlCharacter(database)
  ) {
    throw new Error(
      "PGHOST and PGDATABASE must be non-blank and contain no control characters",
    );
  }
  if (
    PGPORT.trim() === "" ||
    PGUSER.trim() === "" ||
    PGPASSWORD?.trim() === "" ||
    PGPASSWORD_SECRET_ARN?.trim() === "" ||
    PGSSLROOTCERT.trim() === ""
  ) {
    throw new Error(
      "Structured PostgreSQL configuration requires PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD or PGPASSWORD_SECRET_ARN, and PGSSLROOTCERT",
    );
  }

  const portText = PGPORT.trim();
  if (!/^[0-9]+$/u.test(portText)) {
    throw new Error("PGPORT must be a base-10 integer from 1 to 65535");
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PGPORT must be a base-10 integer from 1 to 65535");
  }

  const certificatePath = PGSSLROOTCERT.trim();
  let certificatePem: string;
  try {
    certificatePem = await (dependencies.readFile ?? readFile)(
      certificatePath,
      "utf8",
    );
    (dependencies.parseCertificates ?? parseCertificates)(certificatePem);
  } catch {
    throw new Error(
      "PGSSLROOTCERT must reference a readable PEM certificate bundle",
    );
  }

  const resolvePassword = () => {
    if (PGPASSWORD_SECRET_ARN === undefined) return PGPASSWORD!;
    // 呼び出しごとに client を作ると destroy されずに残るので、配線漏れは起動時に止める。
    if (dependencies.secretClient === undefined) {
      throw new Error(
        "PGPASSWORD_SECRET_ARN requires a Secrets Manager client",
      );
    }
    return (dependencies.createDatabasePassword ?? createDatabasePassword)(
      { secretArn: PGPASSWORD_SECRET_ARN.trim(), user: PGUSER.trim() },
      { client: dependencies.secretClient },
    );
  };

  return {
    mode: "structured",
    host,
    port,
    database,
    user: PGUSER.trim(),
    password: resolvePassword(),
    ssl: { ca: certificatePem, rejectUnauthorized: true },
  };
};
