import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createDatabaseResources,
  toPgPoolConfig,
  type DatabaseConnectionConfig,
  type DatabaseSessionPolicy,
} from "./database.js";

const urlConnection = {
  mode: "url",
  connectionString: "postgresql://starter:secret@db/starter",
} as const satisfies DatabaseConnectionConfig;

const structuredConnection = {
  mode: "structured",
  host: "db.example.internal",
  port: 5432,
  database: "starter",
  user: "starter_admin",
  password: "database-password-canary",
  ssl: {
    ca: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
    rejectUnauthorized: true,
  },
} as const satisfies DatabaseConnectionConfig;

const policy = {
  maxConnections: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 300_000,
  statementTimeoutMillis: 15_000,
  idleInTransactionSessionTimeoutMillis: 30_000,
} as const satisfies DatabaseSessionPolicy;

const expectedPolicyOptions = {
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 300_000,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
};

describe("toPgPoolConfig", () => {
  it("applies connection, statement, and idle-in-transaction timeouts from the session policy in url mode", () => {
    expect(toPgPoolConfig(urlConnection, policy)).toEqual({
      connectionString: urlConnection.connectionString,
      ...expectedPolicyOptions,
    });
  });

  it("applies the same policy in structured mode without synthesizing a connection string", () => {
    const config = toPgPoolConfig(structuredConnection, policy);

    expect(config).toEqual({
      host: "db.example.internal",
      port: 5432,
      database: "starter",
      user: "starter_admin",
      password: "database-password-canary",
      ssl: {
        ca: structuredConnection.ssl.ca,
        rejectUnauthorized: true,
      },
      ...expectedPolicyOptions,
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  it("leaves statement_timeout unset for a policy without a statement timeout", () => {
    const config = toPgPoolConfig(urlConnection, {
      ...policy,
      statementTimeoutMillis: false,
      idleInTransactionSessionTimeoutMillis: false,
    });

    expect(config).not.toHaveProperty("statement_timeout");
    expect(config).not.toHaveProperty("idle_in_transaction_session_timeout");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxConnections %s",
    (maxConnections) => {
      expect(() =>
        toPgPoolConfig(urlConnection, { ...policy, maxConnections }),
      ).toThrow("maxConnections must be a positive integer");
    },
  );

  it.each([
    "connectionTimeoutMillis",
    "idleTimeoutMillis",
    "statementTimeoutMillis",
    "idleInTransactionSessionTimeoutMillis",
  ] as const)("rejects a non-positive %s", (key) => {
    expect(() =>
      toPgPoolConfig(urlConnection, { ...policy, [key]: 0 }),
    ).toThrow(`${key} must be a positive integer`);
  });
});

describe("createDatabaseResources", () => {
  it("attaches an error listener to every new client so a checked-out client can be terminated safely", async () => {
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const resources = createDatabaseResources({
      connection: urlConnection,
      policy,
    });
    try {
      const client = new EventEmitter();
      resources.pool.emit("connect", client);

      expect(() =>
        client.emit(
          "error",
          new Error("terminating connection postgres://starter:secret@db"),
        ),
      ).not.toThrow();
      expect(logError).toHaveBeenCalledExactlyOnceWith(
        "PostgreSQL connection closed.",
      );
    } finally {
      await resources.close();
    }
  });

  it("passes a checked-out client's error to the injected onClientError callback", async () => {
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const onClientError = vi.fn();
    const resources = createDatabaseResources({
      connection: urlConnection,
      policy,
      onClientError,
    });
    try {
      const client = new EventEmitter();
      resources.pool.emit("connect", client);
      const error = Object.assign(new Error("terminating connection"), {
        code: "25P03",
      });

      expect(() => client.emit("error", error)).not.toThrow();
      expect(onClientError).toHaveBeenCalledExactlyOnceWith(error);
      expect(logError).not.toHaveBeenCalled();
    } finally {
      await resources.close();
    }
  });

  it("idle 接続の切断をプロセス全体の未捕捉例外にせず、ログは client 側の 1 か所に任せる", async () => {
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const resources = createDatabaseResources({
      connection: urlConnection,
      policy,
    });
    try {
      expect(() =>
        resources.pool.emit("error", new Error("synthetic idle disconnect")),
      ).not.toThrow();
      expect(logError).not.toHaveBeenCalled();
    } finally {
      await resources.close();
    }
  });
});
