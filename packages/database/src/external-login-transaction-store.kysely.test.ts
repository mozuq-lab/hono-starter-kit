import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Dialect,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "./database.types.js";
import {
  KyselyExternalLoginTransactionStore,
  toExternalLoginTransaction,
} from "./external-login-transaction-store.kysely.js";

const createPostgresTestDialect = (): Dialect => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: (db) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
});

const createQueryCapturingDatabase = (): {
  db: Kysely<Database>;
  queries: CompiledQuery[];
} => {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<Database>({
    dialect: createPostgresTestDialect(),
    log(event) {
      if (event.level === "query") queries.push(event.query);
    },
  });

  return { db, queries };
};

describe("toExternalLoginTransaction", () => {
  it("maps a PostgreSQL row without leaking mutable timestamp values", () => {
    const createdAt = new Date("2026-08-10T00:00:00.000Z");
    const expiresAt = new Date("2026-08-10T00:10:00.000Z");

    const transaction = toExternalLoginTransaction({
      state_hash: "state_hash",
      nonce_hash: "nonce_hash",
      verifier_hash: "verifier_hash",
      return_to: "/projects",
      created_at: createdAt,
      expires_at: expiresAt,
    });

    expect(transaction).toEqual({
      stateHash: "state_hash",
      nonceHash: "nonce_hash",
      verifierHash: "verifier_hash",
      returnTo: "/projects",
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      expiresAt: new Date("2026-08-10T00:10:00.000Z"),
    });
    expect(transaction.createdAt).not.toBe(createdAt);
    expect(transaction.expiresAt).not.toBe(expiresAt);
  });
});

describe("KyselyExternalLoginTransactionStore query contracts", () => {
  it("inserts only the hashed transaction fields and clones input dates before they reach PostgreSQL", async () => {
    const { db, queries } = createQueryCapturingDatabase();
    const store = new KyselyExternalLoginTransactionStore(db);
    const createdAt = new Date("2026-08-10T00:00:00.000Z");
    const expiresAt = new Date("2026-08-10T00:10:00.000Z");

    try {
      await store.create({
        stateHash: "state_hash",
        nonceHash: "nonce_hash",
        verifierHash: "verifier_hash",
        returnTo: "/projects",
        createdAt,
        expiresAt,
      });
    } finally {
      await db.destroy();
    }

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      sql: 'insert into "external_login_transactions" ("state_hash", "nonce_hash", "verifier_hash", "return_to", "created_at", "expires_at") values ($1, $2, $3, $4, $5, $6)',
      parameters: [
        "state_hash",
        "nonce_hash",
        "verifier_hash",
        "/projects",
        new Date("2026-08-10T00:00:00.000Z"),
        new Date("2026-08-10T00:10:00.000Z"),
      ],
    });
    expect(queries[0]?.parameters[4]).not.toBe(createdAt);
    expect(queries[0]?.parameters[5]).not.toBe(expiresAt);
  });

  it("uses one predicate-complete delete-returning statement to consume a transaction", async () => {
    const { db, queries } = createQueryCapturingDatabase();
    const store = new KyselyExternalLoginTransactionStore(db);
    const now = new Date("2026-08-10T00:00:00.000Z");

    try {
      await store.consume({
        stateHash: "state_hash",
        nonceHash: "nonce_hash",
        verifierHash: "verifier_hash",
        now,
      });
    } finally {
      await db.destroy();
    }

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      sql: 'delete from "external_login_transactions" where "state_hash" = $1 and "nonce_hash" = $2 and "verifier_hash" = $3 and "expires_at" > $4 returning *',
      parameters: [
        "state_hash",
        "nonce_hash",
        "verifier_hash",
        new Date("2026-08-10T00:00:00.000Z"),
      ],
    });
    expect(queries[0]?.parameters[3]).not.toBe(now);
  });

  it("deletes the earliest expired transactions through one ordered bounded parameterized statement", async () => {
    const { db, queries } = createQueryCapturingDatabase();
    const store = new KyselyExternalLoginTransactionStore(db);
    const now = new Date("2026-08-10T00:00:00.000Z");

    try {
      await store.deleteExpired({ now, limit: 100 });
    } finally {
      await db.destroy();
    }

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      sql: 'delete from "external_login_transactions" where "state_hash" in (select "state_hash" from "external_login_transactions" where "expires_at" <= $1 order by "expires_at" asc limit $2)',
      parameters: [new Date("2026-08-10T00:00:00.000Z"), 100],
    });
    expect(queries[0]?.parameters[0]).not.toBe(now);
  });
});
