import { readFile as readFileFromFileSystem } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  resolveDatabaseConfig,
  type DatabaseEnvironment,
} from "./database-config.js";

const validCertificatePem =
  "-----BEGIN CERTIFICATE-----\nfixture-public-certificate\n-----END CERTIFICATE-----\n";

const structuredEnvironment = {
  PGHOST: "db-canary.example.internal",
  PGPORT: "5432",
  PGDATABASE: "starter_canary",
  PGUSER: "user-canary",
  PGPASSWORD: "password-canary",
  PGSSLROOTCERT: "/app/certs/global-bundle.pem",
} as const satisfies DatabaseEnvironment;

const structuredEnvironmentKeys = Object.keys(structuredEnvironment) as Array<
  keyof typeof structuredEnvironment
>;

const secretCanaries = [
  "postgresql://url-user:url-password@url-canary.invalid/starter",
  "db-canary.example.internal",
  "starter_canary",
  "user-canary",
  "password-canary",
  "/app/certs/global-bundle.pem",
  "fixture-public-certificate",
] as const;

const captureError = async (
  databaseEnvironment: DatabaseEnvironment,
  nodeEnv = "production",
  dependencies: Parameters<typeof resolveDatabaseConfig>[1] = {
    parseCertificates: vi.fn(),
    readFile: vi.fn().mockResolvedValue(validCertificatePem),
  },
): Promise<Error> => {
  let thrown: unknown;
  try {
    await resolveDatabaseConfig({ nodeEnv, databaseEnvironment }, dependencies);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const captured = thrown as Error;
  for (const canary of secretCanaries) {
    expect(captured.message).not.toContain(canary);
  }
  return captured;
};

describe("resolveDatabaseConfig", () => {
  it("returns an explicit PostgreSQL URL connection", async () => {
    const connectionString =
      "postgresql://url-user:url-password@url-canary.invalid/starter";

    await expect(
      resolveDatabaseConfig({
        nodeEnv: "production",
        databaseEnvironment: { DATABASE_URL: connectionString },
      }),
    ).resolves.toEqual({ mode: "url", connectionString });
  });

  it.each([
    ["development", {}],
    [undefined, {}],
    ["development", { DATABASE_URL: " \t " }],
  ] as const)(
    "uses the checked-in local database when NODE_ENV is %s and settings are %j",
    async (nodeEnv, databaseEnvironment) => {
      await expect(
        resolveDatabaseConfig({ nodeEnv, databaseEnvironment }),
      ).resolves.toEqual({
        mode: "url",
        connectionString: "postgresql://starter:starter@127.0.0.1:5432/starter",
      });
    },
  );

  it.each([
    ["production", {}, "DATABASE_URL is required in production"],
    ["test", {}, "DATABASE_URL is unavailable in test runtime"],
    [
      "production",
      { DATABASE_URL: " \t " },
      "DATABASE_URL is required in production",
    ],
    [
      "test",
      { DATABASE_URL: " \t " },
      "DATABASE_URL is unavailable in test runtime",
    ],
  ] as const)(
    "fails closed with NODE_ENV %s and database settings %j",
    async (nodeEnv, databaseEnvironment, message) => {
      expect((await captureError(databaseEnvironment, nodeEnv)).message).toBe(
        message,
      );
    },
  );

  it("returns a complete structured production connection", async () => {
    const parseCertificates = vi.fn();
    const readFile = vi.fn().mockResolvedValue(validCertificatePem);

    await expect(
      resolveDatabaseConfig(
        {
          nodeEnv: "production",
          databaseEnvironment: structuredEnvironment,
        },
        { parseCertificates, readFile },
      ),
    ).resolves.toEqual({
      mode: "structured",
      host: "db-canary.example.internal",
      port: 5432,
      database: "starter_canary",
      user: "user-canary",
      password: "password-canary",
      ssl: { ca: validCertificatePem, rejectUnauthorized: true },
    });
    expect(readFile).toHaveBeenCalledWith(
      "/app/certs/global-bundle.pem",
      "utf8",
    );
    expect(parseCertificates).toHaveBeenCalledWith(validCertificatePem);
  });

  it("passes a lazy rotating password provider into the structured connection", async () => {
    const environment: Record<string, string> = { ...structuredEnvironment };
    delete environment.PGPASSWORD;
    const password = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("current");
    const createDatabasePassword = vi.fn(() => password);
    const secretClient = { send: vi.fn(), destroy: vi.fn() };
    const connection = await resolveDatabaseConfig(
      {
        nodeEnv: "production",
        databaseEnvironment: {
          ...environment,
          PGPASSWORD_SECRET_ARN:
            " arn:aws:secretsmanager:region:account:secret:db ",
        },
      },
      {
        createDatabasePassword,
        secretClient,
        parseCertificates: vi.fn(),
        readFile: vi.fn().mockResolvedValue(validCertificatePem),
      },
    );

    expect(connection).toMatchObject({
      mode: "structured",
      user: "user-canary",
      password,
      ssl: { ca: validCertificatePem, rejectUnauthorized: true },
    });
    expect(createDatabasePassword).toHaveBeenCalledWith(
      {
        secretArn: "arn:aws:secretsmanager:region:account:secret:db",
        user: "user-canary",
      },
      { client: secretClient },
    );
    expect(password).not.toHaveBeenCalled();
    expect(secretClient.send).not.toHaveBeenCalled();
  });

  it("refuses a secret ARN when the composition did not provide its Secrets Manager client", async () => {
    const environment: Record<string, string> = { ...structuredEnvironment };
    delete environment.PGPASSWORD;

    await expect(
      resolveDatabaseConfig(
        {
          nodeEnv: "production",
          databaseEnvironment: {
            ...environment,
            PGPASSWORD_SECRET_ARN: "secret-arn-canary",
          },
        },
        {
          parseCertificates: vi.fn(),
          readFile: vi.fn().mockResolvedValue(validCertificatePem),
        },
      ),
    ).rejects.toThrow(
      "PGPASSWORD_SECRET_ARN requires a Secrets Manager client",
    );
  });

  it("rejects simultaneous password sources even when one is blank", async () => {
    for (const PGPASSWORD_SECRET_ARN of ["secret-arn-canary", " "]) {
      const error = await captureError({
        ...structuredEnvironment,
        PGPASSWORD_SECRET_ARN,
      });
      expect(error.message).toBe(
        "PGPASSWORD cannot be combined with PGPASSWORD_SECRET_ARN",
      );
      expect(error.message).not.toContain("secret-arn-canary");
    }
  });

  it("rejects a secret ARN combined with DATABASE_URL", async () => {
    const error = await captureError({
      DATABASE_URL: "postgresql://user:password@localhost/starter",
      PGPASSWORD_SECRET_ARN: "secret-arn-canary",
    });
    expect(error.message).toBe(
      "DATABASE_URL cannot be combined with structured PostgreSQL settings",
    );
  });

  it("rejects an empty secret ARN without using a static password", async () => {
    const environment: Record<string, string> = { ...structuredEnvironment };
    delete environment.PGPASSWORD;
    const error = await captureError({
      ...environment,
      PGPASSWORD_SECRET_ARN: " \t ",
    });
    expect(error.message).toBe(
      "Structured PostgreSQL configuration requires PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD or PGPASSWORD_SECRET_ARN, and PGSSLROOTCERT",
    );
  });

  it("trims structured identifiers and path but preserves password bytes", async () => {
    const readFile = vi.fn().mockResolvedValue(validCertificatePem);

    await expect(
      resolveDatabaseConfig(
        {
          nodeEnv: "production",
          databaseEnvironment: {
            PGHOST: " db-canary.example.internal ",
            PGPORT: " 5432 ",
            PGDATABASE: " starter_canary ",
            PGUSER: " user-canary ",
            PGPASSWORD: " password-canary ",
            PGSSLROOTCERT: " /app/certs/global-bundle.pem ",
          },
        },
        { parseCertificates: vi.fn(), readFile },
      ),
    ).resolves.toMatchObject({
      host: "db-canary.example.internal",
      port: 5432,
      database: "starter_canary",
      user: "user-canary",
      password: " password-canary ",
    });
    expect(readFile).toHaveBeenCalledWith(
      "/app/certs/global-bundle.pem",
      "utf8",
    );
  });

  it.each(structuredEnvironmentKeys)(
    "rejects DATABASE_URL combined with %s",
    async (key) => {
      const error = await captureError({
        DATABASE_URL:
          "postgresql://url-user:url-password@url-canary.invalid/starter",
        [key]: structuredEnvironment[key],
      });
      expect(error.message).toBe(
        "DATABASE_URL cannot be combined with structured PostgreSQL settings",
      );
    },
  );

  it.each(structuredEnvironmentKeys)(
    "rejects structured settings missing %s",
    async (missingKey) => {
      const environment = { ...structuredEnvironment } as Record<
        string,
        string | undefined
      >;
      delete environment[missingKey];

      const error = await captureError(environment);
      expect(error.message).toBe(
        "Structured PostgreSQL configuration requires PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD or PGPASSWORD_SECRET_ARN, and PGSSLROOTCERT",
      );
    },
  );

  it.each(["PGPORT", "PGUSER", "PGPASSWORD", "PGSSLROOTCERT"] as const)(
    "rejects blank structured value %s",
    async (key) => {
      const error = await captureError({
        ...structuredEnvironment,
        [key]: " \t ",
      });
      expect(error.message).toBe(
        "Structured PostgreSQL configuration requires PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD or PGPASSWORD_SECRET_ARN, and PGSSLROOTCERT",
      );
    },
  );

  it.each(["PGHOST", "PGDATABASE"] as const)(
    "rejects blank %s with the safe identifier category",
    async (key) => {
      const error = await captureError({
        ...structuredEnvironment,
        [key]: " \t ",
      });
      expect(error.message).toBe(
        "PGHOST and PGDATABASE must be non-blank and contain no control characters",
      );
    },
  );

  it.each(["1.5", "+5432", "0x1538", "5e3", "5432x", "0", "65536"])(
    "rejects invalid PGPORT %s",
    async (PGPORT) => {
      const error = await captureError({ ...structuredEnvironment, PGPORT });
      expect(error.message).toBe(
        "PGPORT must be a base-10 integer from 1 to 65535",
      );
    },
  );

  it.each([
    ["PGHOST", "db-canary.example.internal\nsecond-host"],
    ["PGDATABASE", "starter_canary\u0000suffix"],
  ] as const)("rejects control characters in %s", async (key, value) => {
    const error = await captureError({
      ...structuredEnvironment,
      [key]: value,
    });
    expect(error.message).toBe(
      "PGHOST and PGDATABASE must be non-blank and contain no control characters",
    );
  });

  it("rejects an unreadable CA without exposing its path or cause", async () => {
    const error = await captureError(structuredEnvironment, "production", {
      parseCertificates: vi.fn(),
      readFile: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "EACCES /app/certs/global-bundle.pem password-canary token-canary",
          ),
        ),
    });
    expect(error.message).toBe(
      "PGSSLROOTCERT must reference a readable PEM certificate bundle",
    );
    expect(error.message).not.toContain("token-canary");
  });

  it("uses the default X509 parser and safely rejects malformed PEM", async () => {
    const malformedPem =
      "-----BEGIN CERTIFICATE-----\nfixture-public-certificate\n-----END CERTIFICATE-----\n";
    const error = await captureError(structuredEnvironment, "production", {
      readFile: vi.fn().mockResolvedValue(malformedPem),
    });
    expect(error.message).toBe(
      "PGSSLROOTCERT must reference a readable PEM certificate bundle",
    );
  });

  it("rejects a truncated certificate block after a real valid RDS trust bundle", async () => {
    const trustedBundle = await readFileFromFileSystem(
      new URL("../../../docker/certs/global-bundle.pem", import.meta.url),
      "utf8",
    );
    const readFile = vi
      .fn()
      .mockResolvedValue(
        `${trustedBundle}\n-----BEGIN CERTIFICATE-----\ntruncated`,
      );

    await expect(
      resolveDatabaseConfig(
        {
          nodeEnv: "production",
          databaseEnvironment: structuredEnvironment,
        },
        { readFile },
      ),
    ).rejects.toThrow(
      "PGSSLROOTCERT must reference a readable PEM certificate bundle",
    );
    expect(readFile).toHaveBeenCalledWith(
      "/app/certs/global-bundle.pem",
      "utf8",
    );
  });

  it.each(["not-a-url-secret", "https://user:secret@example.test/starter"])(
    "rejects invalid URL mode without exposing %s",
    async (DATABASE_URL) => {
      const error = await captureError({ DATABASE_URL });
      expect(error.message).toBe("DATABASE_URL must be a valid PostgreSQL URL");
      expect(error.message).not.toContain(DATABASE_URL);
      expect(error.message).not.toContain("secret");
    },
  );

  it("rejects unknown NODE_ENV before resolving database settings", async () => {
    const error = await captureError(structuredEnvironment, "staging");
    expect(error.message).toBe(
      "NODE_ENV must be development, production, or test",
    );
  });
});
