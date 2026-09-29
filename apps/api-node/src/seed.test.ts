import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { getDevIdentity } from "@starter/backend";
import { seedDatabase as seedPackageDatabase } from "@starter/database";
import { resolveDatabaseConfig } from "./database-config.js";
import { migrationSessionPolicy } from "./database-session-policy.js";
import { devUserId } from "./dev-user.js";
import { runSeed } from "./seed.js";

const processEnvironmentWithoutDatabaseSettings = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const key of [
    "DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSWORD_SECRET_ARN",
    "PGSSLROOTCERT",
  ]) {
    delete environment[key];
  }
  return environment;
};

describe("runSeed", () => {
  it("forwards the rotating password source to the seed connection", async () => {
    const password = () => Promise.resolve("rotated-password");
    const seedDatabase = vi.fn(() => Promise.resolve());
    await runSeed(
      {
        NODE_ENV: "production",
        PGHOST: "db.example.internal",
        PGPORT: "5432",
        PGDATABASE: "starter",
        PGUSER: "starter_admin",
        PGSSLROOTCERT: "/synthetic/ca.pem",
        PGPASSWORD_SECRET_ARN: "secret-arn-canary",
      },
      {
        seedDatabase,
        resolveDatabase: (input, dependencies) =>
          resolveDatabaseConfig(input, {
            ...dependencies,
            createDatabasePassword: () => password,
            parseCertificates: vi.fn(),
            readFile: vi.fn().mockResolvedValue("synthetic-certificate"),
          }),
      },
    );
    expect(seedDatabase).toHaveBeenCalledWith({
      connection: {
        mode: "structured",
        host: "db.example.internal",
        port: 5432,
        database: "starter",
        user: "starter_admin",
        password,
        ssl: { ca: "synthetic-certificate", rejectUnauthorized: true },
      },
      policy: migrationSessionPolicy,
      owner: { identity: getDevIdentity(), userId: devUserId },
    });
  });

  it("resolves URL mode before invoking the package seed lifecycle", async () => {
    const seedDatabase = vi.fn(() => Promise.resolve());

    await runSeed(
      {
        NODE_ENV: "production",
        DATABASE_URL:
          "postgresql://url-user:url-password@url-canary.invalid/starter",
      },
      { resolveDatabase: resolveDatabaseConfig, seedDatabase },
    );

    expect(seedDatabase).toHaveBeenCalledWith({
      connection: {
        mode: "url",
        connectionString:
          "postgresql://url-user:url-password@url-canary.invalid/starter",
      },
      policy: migrationSessionPolicy,
      owner: { identity: getDevIdentity(), userId: devUserId },
    });
  });

  it.each([
    { outcome: "success", seedProject: () => Promise.resolve() },
    {
      outcome: "failure",
      seedProject: () => Promise.reject(new Error("seed failed")),
    },
  ])(
    "destroys the Secrets Manager client after closing the database, on $outcome",
    async ({ outcome, seedProject }) => {
      const events: string[] = [];
      const secretClient = {
        send: vi.fn(),
        destroy: vi.fn(() => {
          events.push("secret client destroyed");
        }),
      };

      const run = runSeed(
        { NODE_ENV: "production", DATABASE_URL: "postgresql://db/starter" },
        {
          createSecretClient: () => secretClient,
          resolveDatabase: resolveDatabaseConfig,
          seedDatabase: (options) =>
            seedPackageDatabase({
              ...options,
              seedProject,
              createResources: () => ({
                db: {} as never,
                pool: {} as never,
                close: () => {
                  events.push("database closed");
                  return Promise.resolve();
                },
              }),
              log: vi.fn(),
            }),
        },
      );

      if (outcome === "success") await run;
      else await expect(run).rejects.toThrow("seed failed");
      expect(events).toEqual(["database closed", "secret client destroyed"]);
    },
  );
});

describe("seed CLI", () => {
  it("reports a fixed safe failure without exposing process canaries", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./seed.ts", import.meta.url))],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: {
          ...processEnvironmentWithoutDatabaseSettings(),
          NODE_ENV: "production",
          DATABASE_URL: "not-a-url-canary",
          PASSWORD_CANARY: "password-canary",
          COOKIE_CANARY: "cookie-canary",
          TOKEN_CANARY: "token-canary",
          NONCE_CANARY: "nonce-canary",
          STATE_CANARY: "state-canary",
          VERIFIER_CANARY: "verifier-canary",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "DATABASE_URL must be a valid PostgreSQL URL",
    );
    for (const canary of [
      "not-a-url-canary",
      "password-canary",
      "cookie-canary",
      "token-canary",
      "nonce-canary",
      "state-canary",
      "verifier-canary",
    ]) {
      expect(result.stderr).not.toContain(canary);
      expect(result.stdout).not.toContain(canary);
    }
  });
});
