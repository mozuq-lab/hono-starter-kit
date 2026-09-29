import { afterAll, beforeEach, expect, it } from "vitest";
import { KyselyExternalLoginTransactionStore } from "./external-login-transaction-store.kysely.js";
import {
  closeDatabaseIntegrationResources,
  createGuardedDatabaseIntegrationResources,
  resetToLatestSchema,
} from "./database-test-support.js";

const resources = createGuardedDatabaseIntegrationResources({
  environment: process.env,
});
const loginNow = new Date("2026-08-10T00:00:00.000Z");

beforeEach(async () => {
  await resetToLatestSchema(resources.pool, resources.ownedDatabaseName);
});

afterAll(async () => {
  await closeDatabaseIntegrationResources({
    close: () => resources.close(),
    temporaryMigrationsRoot: undefined,
  });
});

it("stores the columns of external_login_transactions in the expected order", async () => {
  await expect(
    resources.pool.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'external_login_transactions'
       order by ordinal_position`,
    ),
  ).resolves.toMatchObject({
    rows: [
      { column_name: "state_hash" },
      { column_name: "nonce_hash" },
      { column_name: "verifier_hash" },
      { column_name: "return_to" },
      { column_name: "created_at" },
      { column_name: "expires_at" },
    ],
  });
});

it("rejects a row whose expires_at is not after created_at", async () => {
  await expect(
    resources.pool.query(
      `insert into external_login_transactions (
         state_hash, nonce_hash, verifier_hash, return_to, created_at, expires_at
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        "invalid_login_transaction",
        "nonce_hash",
        "verifier_hash",
        "/projects",
        "2026-08-10T00:00:00.000Z",
      ],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("consumes a transaction once and only when nonce and verifier match", async () => {
  const externalLoginStore = new KyselyExternalLoginTransactionStore(
    resources.db,
  );
  await externalLoginStore.create({
    stateHash: "state_hash",
    nonceHash: "nonce_hash",
    verifierHash: "verifier_hash",
    returnTo: "/projects",
    createdAt: new Date("2026-08-09T23:55:00.000Z"),
    expiresAt: new Date("2026-08-10T00:10:00.000Z"),
  });
  await expect(
    externalLoginStore.consume({
      stateHash: "state_hash",
      nonceHash: "wrong_nonce_hash",
      verifierHash: "verifier_hash",
      now: loginNow,
    }),
  ).resolves.toBeUndefined();
  const consumeInput = {
    stateHash: "state_hash",
    nonceHash: "nonce_hash",
    verifierHash: "verifier_hash",
    now: loginNow,
  };
  await expect(externalLoginStore.consume(consumeInput)).resolves.toEqual({
    stateHash: "state_hash",
    nonceHash: "nonce_hash",
    verifierHash: "verifier_hash",
    returnTo: "/projects",
    createdAt: new Date("2026-08-09T23:55:00.000Z"),
    expiresAt: new Date("2026-08-10T00:10:00.000Z"),
  });
  await expect(
    externalLoginStore.consume(consumeInput),
  ).resolves.toBeUndefined();
});

it("does not consume an expired transaction and deletes it as expired", async () => {
  const externalLoginStore = new KyselyExternalLoginTransactionStore(
    resources.db,
  );
  await externalLoginStore.create({
    stateHash: "expired_state_hash",
    nonceHash: "expired_nonce_hash",
    verifierHash: "expired_verifier_hash",
    returnTo: "/projects",
    createdAt: new Date("2026-08-09T23:50:00.000Z"),
    expiresAt: loginNow,
  });
  await expect(
    externalLoginStore.consume({
      stateHash: "expired_state_hash",
      nonceHash: "expired_nonce_hash",
      verifierHash: "expired_verifier_hash",
      now: loginNow,
    }),
  ).resolves.toBeUndefined();
  await expect(
    externalLoginStore.deleteExpired({ now: loginNow, limit: 100 }),
  ).resolves.toBe(1);
});

it("lets exactly one of two concurrent consumers take a transaction", async () => {
  const externalLoginStore = new KyselyExternalLoginTransactionStore(
    resources.db,
  );
  await externalLoginStore.create({
    stateHash: "concurrent_state_hash",
    nonceHash: "concurrent_nonce_hash",
    verifierHash: "concurrent_verifier_hash",
    returnTo: "/projects",
    createdAt: new Date("2026-08-09T23:55:00.000Z"),
    expiresAt: new Date("2026-08-10T00:10:00.000Z"),
  });
  const concurrentConsumes = await Promise.all(
    Array.from({ length: 2 }, () =>
      externalLoginStore.consume({
        stateHash: "concurrent_state_hash",
        nonceHash: "concurrent_nonce_hash",
        verifierHash: "concurrent_verifier_hash",
        now: loginNow,
      }),
    ),
  );
  expect(
    concurrentConsumes.filter((transaction) => transaction !== undefined),
  ).toEqual([expect.objectContaining({ returnTo: "/projects" })]);
});

it("deletes expired transactions in batches of at most the given limit", async () => {
  const externalLoginStore = new KyselyExternalLoginTransactionStore(
    resources.db,
  );
  for (let index = 0; index < 101; index += 1) {
    await externalLoginStore.create({
      stateHash: `cleanup_state_${index.toString().padStart(3, "0")}`,
      nonceHash: `cleanup_nonce_${index}`,
      verifierHash: `cleanup_verifier_${index}`,
      returnTo: "/projects",
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
      expiresAt: new Date(
        Date.parse("2026-08-09T01:00:00.000Z") + index * 1_000,
      ),
    });
  }
  await expect(
    externalLoginStore.deleteExpired({ now: loginNow, limit: 100 }),
  ).resolves.toBe(100);
  await expect(
    resources.db
      .selectFrom("external_login_transactions")
      .select("state_hash")
      .orderBy("state_hash")
      .execute(),
  ).resolves.toEqual([{ state_hash: "cleanup_state_100" }]);
});
