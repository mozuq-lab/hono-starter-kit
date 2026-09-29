import { createHash } from "node:crypto";
import {
  createAuthenticateSession,
  createEstablishSession,
} from "@starter/backend";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { KyselyAuthSessionStore } from "./auth-session-store.kysely.js";
import type { DatabaseSessionPolicy } from "./database.js";
import {
  closeDatabaseIntegrationResources,
  createGuardedDatabaseIntegrationResources,
  dropTestSchema,
  type GuardedDatabaseResources,
  integrationTestSessionPolicy,
  recreateTestSchema,
} from "./database-test-support.js";
import { defaultMigrationsDirectory } from "./migration-files.js";
import { applyMigrations } from "./migration-runner.js";

// ここで作る session と migration 履歴が、他のファイルの使う public に混ざらないよう、専用の
// スキーマで動かす。search_path は接続の startup option で固定するので、どの client も public を触れない。
const testSchema = "starter_session_cleanup_test";

const opened: GuardedDatabaseResources[] = [];
const open = (policy: DatabaseSessionPolicy = integrationTestSessionPolicy) => {
  const resources = createGuardedDatabaseIntegrationResources({
    environment: process.env,
    policy,
    schema: testSchema,
  });
  opened.push(resources);
  return resources;
};

const hashSessionId = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const sessionPolicy = {
  absoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  idleTtlMs: 24 * 60 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
};

const now = new Date("2026-08-10T00:00:00.000Z");

let admin: GuardedDatabaseResources;

it("reports the test schema as current_schema on the first query of a fresh connection", async () => {
  const fresh = open();
  await expect(
    fresh.pool.query<{ current_schema: string }>("select current_schema()"),
  ).resolves.toMatchObject({ rows: [{ current_schema: testSchema }] });
});

beforeAll(async () => {
  admin = open();
  await recreateTestSchema(admin.pool, admin.ownedDatabaseName, testSchema);
  await applyMigrations({
    pool: admin.pool,
    migrationsDirectory: defaultMigrationsDirectory,
  });
  await admin.pool.query(
    `insert into users (id, created_at, updated_at) values ($1, $2, $2)`,
    ["user_cleanup", "2026-08-01T00:00:00.000Z"],
  );
});

beforeEach(async () => {
  await admin.pool.query("delete from sessions");
});

afterEach(async () => {
  // 失敗したテストが行ロックやトランザクションを握ったまま次へ進まないよう、
  // テストごとに開いた pool をすべて閉じる（最初の admin は afterAll で閉じる）。
  await Promise.all(opened.splice(1).map((resources) => resources.close()));
});

afterAll(async () => {
  await closeDatabaseIntegrationResources({
    close: async () => {
      const admin = opened[0];
      try {
        if (admin !== undefined) {
          await dropTestSchema(admin.pool, admin.ownedDatabaseName, testSchema);
        }
      } finally {
        await Promise.all(
          opened.splice(0).map((resources) => resources.close()),
        );
      }
    },
    temporaryMigrationsRoot: undefined,
  });
});

const insertSession = (input: {
  rawId: string;
  idleExpiresAt: string;
  revokedAt?: string;
}) =>
  admin.pool.query(
    `insert into sessions (
       id_hash, user_id, absolute_expires_at, idle_expires_at,
       created_at, last_accessed_at, revoked_at
     ) values ($1, $2, $3, $4, $5, $5, $6)`,
    [
      hashSessionId(input.rawId),
      "user_cleanup",
      "2026-08-13T00:00:00.000Z",
      input.idleExpiresAt,
      "2026-08-01T00:00:00.000Z",
      input.revokedAt ?? null,
    ],
  );

// idle 期限を 1 秒ずつずらした期限切れの行を count 行入れる。bulk_0 が最も古い。
const insertExpiredSessions = (count: number) =>
  admin.pool.query(
    `insert into sessions (
       id_hash, user_id, absolute_expires_at, idle_expires_at,
       created_at, last_accessed_at
     )
     select encode(sha256(convert_to('bulk_' || i, 'UTF8')), 'hex'),
            'user_cleanup',
            '2026-08-13T00:00:00.000Z'::timestamptz,
            '2026-08-05T00:00:00.000Z'::timestamptz + i * interval '1 second',
            '2026-08-01T00:00:00.000Z'::timestamptz,
            '2026-08-01T00:00:00.000Z'::timestamptz
     from generate_series(0, $1::int - 1) as i`,
    [count],
  );

const sessionExists = async (rawId: string): Promise<boolean> => {
  const { rows } = await admin.pool.query<{ exists: boolean }>(
    "select exists(select 1 from sessions where id_hash = $1) as exists",
    [hashSessionId(rawId)],
  );
  return rows[0]!.exists;
};

const countSessions = async (): Promise<number> => {
  const { rows } = await admin.pool.query<{ count: number }>(
    "select count(*)::int as count from sessions",
  );
  return rows[0]!.count;
};

it("deleteExpired removes unrevoked sessions whose idle expiry has passed, oldest first, up to the limit", async () => {
  const store = new KyselyAuthSessionStore(admin.db);
  await insertExpiredSessions(100);
  await insertSession({
    rawId: "newest_expired",
    idleExpiresAt: "2026-08-09T23:59:59.999Z",
  });
  await insertSession({
    rawId: "at_boundary",
    idleExpiresAt: now.toISOString(),
  });
  await insertSession({
    rawId: "not_expired",
    idleExpiresAt: "2026-08-10T00:00:00.001Z",
  });

  await expect(store.deleteExpired({ now, limit: 100 })).resolves.toBe(100);
  await expect(sessionExists("bulk_0")).resolves.toBe(false);
  await expect(sessionExists("bulk_99")).resolves.toBe(false);
  await expect(sessionExists("newest_expired")).resolves.toBe(true);
  await expect(sessionExists("at_boundary")).resolves.toBe(true);

  await expect(store.deleteExpired({ now, limit: 100 })).resolves.toBe(2);
  await expect(sessionExists("newest_expired")).resolves.toBe(false);
  await expect(sessionExists("at_boundary")).resolves.toBe(false);
  await expect(sessionExists("not_expired")).resolves.toBe(true);
  await expect(store.deleteExpired({ now, limit: 100 })).resolves.toBe(0);
});

it("finishes concurrent deleteExpired calls without errors and deletes every target row once", async () => {
  await insertExpiredSessions(150);
  const first = new KyselyAuthSessionStore(open().db);
  const second = new KyselyAuthSessionStore(open().db);

  const deleted = await Promise.all([
    first.deleteExpired({ now, limit: 100 }),
    second.deleteExpired({ now, limit: 100 }),
  ]);

  expect(deleted[0] + deleted[1]).toBe(150);
  await expect(countSessions()).resolves.toBe(0);
});

it("skips rows locked by another cleanup instead of waiting for them", async () => {
  await insertExpiredSessions(150);
  const holder = open();
  // skip locked が無いと、ロックの解放を待って statement_timeout で落ちる。
  const waiter = open({
    ...integrationTestSessionPolicy,
    statementTimeoutMillis: 2_000,
  });
  const client = await holder.pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<{ id_hash: string }>(
      `select id_hash from sessions
       where revoked_at is null and idle_expires_at <= $1
       order by idle_expires_at
       limit 100
       for update`,
      [now],
    );
    expect(locked.rows).toHaveLength(100);

    await expect(
      new KyselyAuthSessionStore(waiter.db).deleteExpired({ now, limit: 100 }),
    ).resolves.toBe(50);

    await client.query("delete from sessions where id_hash = any($1::text[])", [
      locked.rows.map(({ id_hash }) => id_hash),
    ]);
    await client.query("commit");
  } finally {
    // 途中で失敗しても行ロックを持ったトランザクションを pool に戻さない。接続ごと捨てれば
    // サーバーが rollback し、次のテストの beforeEach がロック待ちで止まらない。
    client.release(true);
  }
  await expect(countSessions()).resolves.toBe(0);
});

it("revoke deletes the session row and is a no-op for a missing session", async () => {
  const store = new KyselyAuthSessionStore(admin.db);
  await insertSession({
    rawId: "to_revoke",
    idleExpiresAt: "2026-08-11T00:00:00.000Z",
  });

  await store.revoke({ idHash: hashSessionId("to_revoke") });
  await expect(sessionExists("to_revoke")).resolves.toBe(false);
  await expect(
    store.revoke({ idHash: hashSessionId("to_revoke") }),
  ).resolves.toBeUndefined();
  await expect(
    store.revoke({ idHash: hashSessionId("never_existed") }),
  ).resolves.toBeUndefined();
});

it("establish deletes the previous session and cleans up idle-expired sessions", async () => {
  const store = new KyselyAuthSessionStore(admin.db);
  await insertSession({
    rawId: "stale",
    idleExpiresAt: "2026-08-09T00:00:00.000Z",
  });
  const identity = {
    provider: "test",
    issuer: "urn:issuer:cleanup",
    subject: "subject-cleanup",
    roles: ["projects:read"],
  };
  let sessionCount = 0;
  const establishSession = createEstablishSession({
    clock: () => new Date(now.getTime()),
    generateSessionId: () => `rotated_${++sessionCount}`,
    generateUserId: () => "user_rotated",
    hashSessionId,
    policy: sessionPolicy,
    store,
  });

  await establishSession({ identity });
  await expect(sessionExists("stale")).resolves.toBe(false);

  await establishSession({ identity, previousSessionId: "rotated_1" });
  await expect(sessionExists("rotated_1")).resolves.toBe(false);
  await expect(sessionExists("rotated_2")).resolves.toBe(true);
});

it("rejects a session whose revoked_at is set while the column remains", async () => {
  const store = new KyselyAuthSessionStore(admin.db);
  await insertSession({
    rawId: "revoked_by_column",
    idleExpiresAt: "2026-08-11T00:00:00.000Z",
    revokedAt: "2026-08-09T00:00:00.000Z",
  });
  const authenticateSession = createAuthenticateSession({
    clock: () => new Date(now.getTime()),
    hashSessionId,
    policy: sessionPolicy,
    store,
  });

  await expect(
    authenticateSession("revoked_by_column"),
  ).resolves.toBeUndefined();
  await expect(
    store.touch({
      idHash: hashSessionId("revoked_by_column"),
      observedLastAccessedAt: new Date("2026-08-01T00:00:00.000Z"),
      observedIdleExpiresAt: new Date("2026-08-11T00:00:00.000Z"),
      lastAccessedAt: new Date(now.getTime()),
      idleExpiresAt: new Date("2026-08-11T00:00:00.000Z"),
    }),
  ).resolves.toBe(false);
});
