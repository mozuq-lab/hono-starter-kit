import { createHash } from "node:crypto";
import {
  createAuthenticateSession,
  createEstablishSession,
  createRevokeSession,
  type AuthSessionStore,
} from "@starter/backend";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { KyselyAuthSessionStore } from "./auth-session-store.kysely.js";
import {
  closeDatabaseIntegrationResources,
  createGuardedDatabaseIntegrationResources,
  resetToLatestSchema,
} from "./database-test-support.js";

const resources = createGuardedDatabaseIntegrationResources({
  environment: process.env,
});
const { pool } = resources;
const authStore = new KyselyAuthSessionStore(resources.db);

const hashSessionId = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const sessionPolicy = {
  absoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  idleTtlMs: 24 * 60 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
};

beforeEach(async () => {
  await resetToLatestSchema(pool, resources.ownedDatabaseName);
});

afterAll(async () => {
  await closeDatabaseIntegrationResources({
    close: () => resources.close(),
    temporaryMigrationsRoot: undefined,
  });
});

// 各テストが前提にする session を作る。alpha は user_primary_candidate の最初の session、
// beta は同じ identity で alpha を置き換えた session、gamma は別 issuer の session。
const establishAlpha = () =>
  createEstablishSession({
    clock: () => new Date("2026-08-06T00:00:00.000Z"),
    generateSessionId: () => "raw_session_alpha",
    generateUserId: () => "user_primary_candidate",
    hashSessionId,
    policy: sessionPolicy,
    store: authStore,
  })({
    identity: {
      provider: "test",
      issuer: "urn:issuer:alpha",
      subject: "subject-alpha",
      email: "same@example.test",
      displayName: "First Profile",
      roles: ["projects:read"],
      providerSessionId: "provider-session-alpha",
    },
  });

const establishBeta = (previousSessionId?: string) =>
  createEstablishSession({
    clock: () => new Date("2026-08-06T00:01:00.000Z"),
    generateSessionId: () => "raw_session_beta",
    generateUserId: () => "user_ignored_candidate",
    hashSessionId,
    policy: sessionPolicy,
    store: authStore,
  })({
    identity: {
      provider: "test",
      issuer: "urn:issuer:alpha",
      subject: "subject-alpha",
      email: "same@example.test",
      displayName: "Refreshed Profile",
      roles: ["projects:write"],
    },
    ...(previousSessionId === undefined ? {} : { previousSessionId }),
  });

const establishGamma = () =>
  createEstablishSession({
    clock: () => new Date("2026-08-06T00:02:00.000Z"),
    generateSessionId: () => "raw_session_gamma",
    generateUserId: () => "user_other_issuer",
    hashSessionId,
    policy: sessionPolicy,
    store: authStore,
  })({
    identity: {
      provider: "test",
      issuer: "urn:issuer:beta",
      subject: "subject-alpha",
      email: "same@example.test",
      displayName: "Other Issuer",
      roles: ["projects:read"],
    },
  });

describe("auth schema", () => {
  it("keys user_identities by issuer and subject", async () => {
    const primaryKeyColumns = await pool.query<{
      column_name: string;
      ordinal_position: number;
    }>(`
    select kcu.column_name, kcu.ordinal_position
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_catalog = tc.constraint_catalog
      and kcu.constraint_schema = tc.constraint_schema
      and kcu.constraint_name = tc.constraint_name
      and kcu.table_catalog = tc.table_catalog
      and kcu.table_schema = tc.table_schema
      and kcu.table_name = tc.table_name
    where tc.table_schema = 'public'
      and tc.table_name = 'user_identities'
      and tc.constraint_type = 'PRIMARY KEY'
    order by kcu.ordinal_position
  `);
    expect(
      primaryKeyColumns.rows.map(({ column_name }) => column_name),
    ).toEqual(["issuer", "subject"]);
  });

  it("creates the user_id and active-expiry indexes", async () => {
    const authIndexes = await pool.query<{
      columns: string[];
      index_name: string;
      predicate: string | null;
    }>(
      `select
       index_class.relname as index_name,
       array_agg(attribute.attname::text order by index_key.ordinality)::text[]
         as columns,
       pg_get_expr(index_metadata.indpred, index_metadata.indrelid) as predicate
     from pg_index index_metadata
     join pg_class table_class on table_class.oid = index_metadata.indrelid
     join pg_class index_class on index_class.oid = index_metadata.indexrelid
     join pg_namespace namespace on namespace.oid = table_class.relnamespace
     cross join lateral unnest(index_metadata.indkey)
       with ordinality as index_key(attribute_number, ordinality)
     join pg_attribute attribute
       on attribute.attrelid = table_class.oid
       and attribute.attnum = index_key.attribute_number
     where namespace.nspname = 'public'
       and index_class.relname = any($1::text[])
     group by index_class.relname, index_metadata.indpred, index_metadata.indrelid
     order by index_class.relname`,
      [
        [
          "user_identities_user_id_idx",
          "sessions_user_id_idx",
          "sessions_active_expiry_idx",
        ],
      ],
    );
    expect(authIndexes.rows).toEqual([
      {
        columns: ["idle_expires_at", "absolute_expires_at"],
        index_name: "sessions_active_expiry_idx",
        predicate: "(revoked_at IS NULL)",
      },
      {
        columns: ["user_id"],
        index_name: "sessions_user_id_idx",
        predicate: null,
      },
      {
        columns: ["user_id"],
        index_name: "user_identities_user_id_idx",
        predicate: null,
      },
    ]);
  });
});

describe("session establishment", () => {
  it("creates the user, identity and a session stored only as a hash", async () => {
    await expect(establishAlpha()).resolves.toEqual({
      sessionId: "raw_session_alpha",
      user: {
        id: "user_primary_candidate",
        email: "same@example.test",
        displayName: "First Profile",
        roles: ["projects:read"],
      },
    });
    await expect(
      pool.query<{
        identities: number;
        sessions: number;
        users: number;
      }>(`select
      (select count(*)::int from users) as users,
      (select count(*)::int from user_identities) as identities,
      (select count(*)::int from sessions) as sessions`),
    ).resolves.toMatchObject({
      rows: [{ identities: 1, sessions: 1, users: 1 }],
    });
    const firstStoredSession = await pool.query<{ id_hash: string }>(
      "select id_hash from sessions where id_hash = $1",
      ["b64852b17d4042fb6bdfae2eac7dbaf44ef4bad74b84b82a71e38690e226128b"],
    );
    expect(firstStoredSession.rows).toEqual([
      {
        id_hash:
          "b64852b17d4042fb6bdfae2eac7dbaf44ef4bad74b84b82a71e38690e226128b",
      },
    ]);
    expect(firstStoredSession.rows[0]?.id_hash).not.toBe("raw_session_alpha");
  });

  it("keeps the first user id, refreshes the profile and deletes the previous session on re-login", async () => {
    await establishAlpha();

    await expect(establishBeta("raw_session_alpha")).resolves.toEqual({
      sessionId: "raw_session_beta",
      user: {
        id: "user_primary_candidate",
        email: "same@example.test",
        displayName: "Refreshed Profile",
        roles: ["projects:write"],
      },
    });
    await expect(
      pool.query<{
        display_name: string;
        email: string;
        id: string;
        roles: string[];
      }>("select id, email, display_name, roles from users order by id"),
    ).resolves.toMatchObject({
      rows: [
        {
          display_name: "Refreshed Profile",
          email: "same@example.test",
          id: "user_primary_candidate",
          roles: ["projects:write"],
        },
      ],
    });
    await expect(
      pool.query<{ last_authenticated_at: Date; user_id: string }>(
        `select user_id, last_authenticated_at
       from user_identities
       where issuer = $1 and subject = $2`,
        ["urn:issuer:alpha", "subject-alpha"],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          last_authenticated_at: new Date("2026-08-06T00:01:00.000Z"),
          user_id: "user_primary_candidate",
        },
      ],
    });
    await expect(
      pool.query<{ id_hash: string }>(
        "select id_hash from sessions where id_hash = $1",
        ["b64852b17d4042fb6bdfae2eac7dbaf44ef4bad74b84b82a71e38690e226128b"],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("creates a separate user for the same subject under another issuer", async () => {
    await establishAlpha();
    await establishBeta("raw_session_alpha");

    await expect(establishGamma()).resolves.toMatchObject({
      user: { id: "user_other_issuer" },
    });
    await expect(
      pool.query<{ identities: number; sessions: number; users: number }>(
        `select
        (select count(*)::int from users) as users,
        (select count(*)::int from user_identities) as identities,
        (select count(*)::int from sessions) as sessions`,
      ),
    ).resolves.toMatchObject({
      rows: [{ identities: 2, sessions: 2, users: 2 }],
    });
  });

  it("converges two concurrent first logins of one identity onto a single user", async () => {
    const concurrentIdentity = {
      provider: "test",
      issuer: "urn:issuer:concurrent",
      subject: "subject-concurrent",
      email: "concurrent@example.test",
      displayName: "Concurrent Identity",
      roles: ["projects:read"],
    };
    const concurrentFirstEstablish = createEstablishSession({
      clock: () => new Date("2026-08-06T00:03:00.000Z"),
      generateSessionId: () => "raw_session_concurrent_one",
      generateUserId: () => "user_concurrent_candidate_one",
      hashSessionId,
      policy: sessionPolicy,
      store: authStore,
    });
    const concurrentSecondEstablish = createEstablishSession({
      clock: () => new Date("2026-08-06T00:03:00.000Z"),
      generateSessionId: () => "raw_session_concurrent_two",
      generateUserId: () => "user_concurrent_candidate_two",
      hashSessionId,
      policy: sessionPolicy,
      store: authStore,
    });
    const concurrentResults = await Promise.all([
      concurrentFirstEstablish({ identity: concurrentIdentity }),
      concurrentSecondEstablish({ identity: concurrentIdentity }),
    ]);
    expect(new Set(concurrentResults.map(({ user }) => user.id)).size).toBe(1);
    const concurrentUserId = concurrentResults[0]?.user.id;
    expect([
      "user_concurrent_candidate_one",
      "user_concurrent_candidate_two",
    ]).toContain(concurrentUserId);
    expect(concurrentResults.map(({ sessionId }) => sessionId)).toEqual([
      "raw_session_concurrent_one",
      "raw_session_concurrent_two",
    ]);
    const concurrentUsers = await pool.query<{ id: string }>(
      "select id from users where id = any($1::text[]) order by id",
      [["user_concurrent_candidate_one", "user_concurrent_candidate_two"]],
    );
    expect(concurrentUsers.rows).toEqual([{ id: concurrentUserId }]);
    const concurrentIdentities = await pool.query<{ user_id: string }>(
      `select user_id
     from user_identities
     where issuer = $1 and subject = $2`,
      ["urn:issuer:concurrent", "subject-concurrent"],
    );
    expect(concurrentIdentities.rows).toEqual([{ user_id: concurrentUserId }]);
    const concurrentSessions = await pool.query<{
      id_hash: string;
      user_id: string;
    }>(
      `select id_hash, user_id
     from sessions
     where id_hash = any($1::text[])
     order by id_hash`,
      [
        [
          "c2f357008cff0605c553ad32e9fd825f51536c043ea72534d17ab468091c363b",
          "7937827c83ade2addbc095cd98b4f93204ac03aced2e1517022fde94f234f993",
        ],
      ],
    );
    expect(concurrentSessions.rows).toEqual([
      {
        id_hash:
          "7937827c83ade2addbc095cd98b4f93204ac03aced2e1517022fde94f234f993",
        user_id: concurrentUserId,
      },
      {
        id_hash:
          "c2f357008cff0605c553ad32e9fd825f51536c043ea72534d17ab468091c363b",
        user_id: concurrentUserId,
      },
    ]);
  });

  it("keeps the newer profile when an older login completes after a newer one", async () => {
    let releaseOlderEstablishment = () => {};
    let reportOlderEstablishmentStarted = () => {};
    const olderEstablishmentStarted = new Promise<void>((resolve) => {
      reportOlderEstablishmentStarted = resolve;
    });
    const olderEstablishmentCanContinue = new Promise<void>((resolve) => {
      releaseOlderEstablishment = resolve;
    });
    const delayedOlderStore: AuthSessionStore = {
      establish: async (input) => {
        reportOlderEstablishmentStarted();
        await olderEstablishmentCanContinue;
        return authStore.establish(input);
      },
      findByIdHash: (idHash) => authStore.findByIdHash(idHash),
      touch: (input) => authStore.touch(input),
      revoke: (input) => authStore.revoke(input),
      deleteExpired: (input) => authStore.deleteExpired(input),
    };
    const reverseOlderEstablish = createEstablishSession({
      clock: () => new Date("2026-08-06T00:04:00.000Z"),
      generateSessionId: () => "raw_session_reverse_older",
      generateUserId: () => "user_reverse_older_candidate",
      hashSessionId,
      policy: sessionPolicy,
      store: delayedOlderStore,
    });
    const reverseNewerEstablish = createEstablishSession({
      clock: () => new Date("2026-08-06T00:05:00.000Z"),
      generateSessionId: () => "raw_session_reverse_newer",
      generateUserId: () => "user_reverse_newer_candidate",
      hashSessionId,
      policy: sessionPolicy,
      store: authStore,
    });
    const olderEstablishment = reverseOlderEstablish({
      identity: {
        provider: "test",
        issuer: "urn:issuer:reverse-completion",
        subject: "subject-reverse-completion",
        email: "older@example.test",
        displayName: "Older Profile",
        roles: ["projects:read"],
      },
    });
    await olderEstablishmentStarted;
    const newerEstablishment = await reverseNewerEstablish({
      identity: {
        provider: "test",
        issuer: "urn:issuer:reverse-completion",
        subject: "subject-reverse-completion",
        email: "newer@example.test",
        displayName: "Newer Profile",
        roles: ["projects:write"],
      },
    });
    releaseOlderEstablishment();
    await expect(olderEstablishment).resolves.toEqual({
      sessionId: "raw_session_reverse_older",
      user: newerEstablishment.user,
    });
    await expect(
      pool.query<{
        display_name: string;
        email: string;
        last_authenticated_at: Date;
        roles: string[];
        session_count: number;
        updated_at: Date;
      }>(
        `select users.email,
              users.display_name,
              users.roles,
              users.updated_at,
              user_identities.last_authenticated_at,
              count(sessions.id_hash)::int as session_count
       from user_identities
       join users on users.id = user_identities.user_id
       join sessions on sessions.user_id = users.id
       where user_identities.issuer = $1
         and user_identities.subject = $2
       group by users.id, user_identities.issuer, user_identities.subject`,
        ["urn:issuer:reverse-completion", "subject-reverse-completion"],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          display_name: "Newer Profile",
          email: "newer@example.test",
          last_authenticated_at: new Date("2026-08-06T00:05:00.000Z"),
          roles: ["projects:write"],
          session_count: 2,
          updated_at: new Date("2026-08-06T00:05:00.000Z"),
        },
      ],
    });
  });

  it("rolls back the user, identity and new session and keeps the previous session when establishment fails", async () => {
    await establishGamma();

    const rollbackEstablish = createEstablishSession({
      clock: () => new Date("2026-08-06T00:20:00.000Z"),
      generateSessionId: () => "raw_session_rollback",
      generateUserId: () => "user_rolled_back_auth",
      hashSessionId,
      policy: {
        absoluteTtlMs: 60 * 60 * 1000,
        idleTtlMs: 2 * 60 * 60 * 1000,
        touchIntervalMs: 5 * 60 * 1000,
      },
      store: authStore,
    });
    await expect(
      rollbackEstablish({
        identity: {
          provider: "test",
          issuer: "urn:issuer:rolled-back",
          subject: "subject-rolled-back",
          roles: ["projects:read"],
        },
        previousSessionId: "raw_session_gamma",
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query<{
        identity_exists: boolean;
        new_session_exists: boolean;
        previous_exists: boolean;
        user_exists: boolean;
      }>(
        `select
        exists(select 1 from users where id = $1) as user_exists,
        exists(
          select 1 from user_identities where issuer = $2 and subject = $3
        ) as identity_exists,
        exists(select 1 from sessions where id_hash = $4) as previous_exists,
        exists(select 1 from sessions where id_hash = $5) as new_session_exists`,
        [
          "user_rolled_back_auth",
          "urn:issuer:rolled-back",
          "subject-rolled-back",
          "c635699125ca1a007e2a44ed3a3157c117daa4698d065da296c9d1bbb1f87cec",
          "23cc74234c5a0cf61bfaeb508402a21568d398f55fc134baba5e69ce702af281",
        ],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          identity_exists: false,
          new_session_exists: false,
          previous_exists: true,
          user_exists: false,
        },
      ],
    });
  });
});

describe("session touch and revoke", () => {
  it("extends the idle expiry when a session is authenticated after the touch interval", async () => {
    await establishAlpha();
    await establishBeta("raw_session_alpha");

    const authenticateTouchedSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:10:00.000Z"),
      hashSessionId,
      policy: sessionPolicy,
      store: authStore,
    });
    await expect(
      authenticateTouchedSession("raw_session_beta"),
    ).resolves.toMatchObject({
      actor: { userId: "user_primary_candidate" },
    });
    await expect(
      pool.query<{ idle_expires_at: Date; last_accessed_at: Date }>(
        `select idle_expires_at, last_accessed_at
       from sessions
       where id_hash = $1`,
        ["c4b865a7786a0ef4e46329f7f325a0a8ce08f73a4925caa8d5ccd73facab7c98"],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          idle_expires_at: new Date("2026-08-07T00:10:00.000Z"),
          last_accessed_at: new Date("2026-08-06T00:10:00.000Z"),
        },
      ],
    });
  });

  it("applies only the newer of two touches based on the same observed state", async () => {
    await establishAlpha();
    await establishBeta("raw_session_alpha");
    const authenticateTouchedSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:10:00.000Z"),
      hashSessionId,
      policy: sessionPolicy,
      store: authStore,
    });
    await authenticateTouchedSession("raw_session_beta");

    const observedTouchState = await authStore.findByIdHash(
      hashSessionId("raw_session_beta"),
    );
    expect(observedTouchState).toBeDefined();
    const commonTouchInput = {
      idHash: hashSessionId("raw_session_beta"),
      observedLastAccessedAt: observedTouchState!.lastAccessedAt,
      observedIdleExpiresAt: observedTouchState!.idleExpiresAt,
    };
    const newerTouch = await authStore.touch({
      ...commonTouchInput,
      lastAccessedAt: new Date("2026-08-06T00:16:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:16:00.000Z"),
    });
    const olderTouch = await authStore.touch({
      ...commonTouchInput,
      lastAccessedAt: new Date("2026-08-06T00:15:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:15:00.000Z"),
    });
    expect([newerTouch, olderTouch]).toEqual([true, false]);
    await expect(
      pool.query<{ idle_expires_at: Date; last_accessed_at: Date }>(
        `select idle_expires_at, last_accessed_at
       from sessions
       where id_hash = $1`,
        [hashSessionId("raw_session_beta")],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          idle_expires_at: new Date("2026-08-07T00:16:00.000Z"),
          last_accessed_at: new Date("2026-08-06T00:16:00.000Z"),
        },
      ],
    });
  });

  it("neither touches nor authenticates a revoked session", async () => {
    await establishAlpha();
    await establishBeta("raw_session_alpha");

    const revokeSession = createRevokeSession({
      hashSessionId,
      store: authStore,
    });
    await revokeSession("raw_session_beta");
    await expect(
      authStore.touch({
        idHash: hashSessionId("raw_session_beta"),
        observedLastAccessedAt: new Date("2026-08-06T00:16:00.000Z"),
        observedIdleExpiresAt: new Date("2026-08-07T00:16:00.000Z"),
        lastAccessedAt: new Date("2026-08-06T00:18:00.000Z"),
        idleExpiresAt: new Date("2026-08-07T00:18:00.000Z"),
      }),
    ).resolves.toBe(false);
    const authenticateRevokedSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:18:00.000Z"),
      hashSessionId,
      policy: sessionPolicy,
      store: authStore,
    });
    await expect(
      authenticateRevokedSession("raw_session_beta"),
    ).resolves.toBeUndefined();
  });
});

describe("users, identities and sessions constraints", () => {
  beforeEach(async () => {
    await pool.query(
      `insert into users (id, created_at, updated_at)
     values ($1, $2, $2)`,
      ["user_constraint_target", "2026-08-06T00:00:00.000Z"],
    );
  });

  it("rejects an identity with a blank issuer, subject or provider", async () => {
    for (const [issuer, subject, provider] of [
      [" ", "valid-subject-one", "test"],
      ["urn:issuer:constraint", " ", "test"],
      ["urn:issuer:provider", "valid-subject-two", " "],
    ]) {
      await expect(
        pool.query(
          `insert into user_identities (
           issuer, subject, provider, user_id, created_at, last_authenticated_at
         ) values ($1, $2, $3, $4, $5, $5)`,
          [
            issuer,
            subject,
            provider,
            "user_constraint_target",
            "2026-08-06T00:00:00.000Z",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects a session id hash that is not 64 lowercase hex characters", async () => {
    for (const invalidHash of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
    ]) {
      await expect(
        pool.query(
          `insert into sessions (
           id_hash, user_id, absolute_expires_at, idle_expires_at,
           created_at, last_accessed_at
         ) values ($1, $2, $3, $4, $5, $5)`,
          [
            invalidHash,
            "user_constraint_target",
            "2026-08-08T00:00:00.000Z",
            "2026-08-07T00:00:00.000Z",
            "2026-08-06T00:00:00.000Z",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects a user whose updated_at is before created_at", async () => {
    await expect(
      pool.query(
        `insert into users (id, created_at, updated_at)
       values ($1, $2, $3)`,
        [
          "user_invalid_timestamp_order",
          "2026-08-06T00:01:00.000Z",
          "2026-08-06T00:00:00.000Z",
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an identity whose last_authenticated_at is before created_at", async () => {
    await expect(
      pool.query(
        `insert into user_identities (
         issuer, subject, provider, user_id, created_at, last_authenticated_at
       ) values ($1, $2, $3, $4, $5, $6)`,
        [
          "urn:issuer:invalid-time",
          "subject-invalid-time",
          "test",
          "user_constraint_target",
          "2026-08-06T00:01:00.000Z",
          "2026-08-06T00:00:00.000Z",
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a session with inconsistent expiry, access or revocation timestamps", async () => {
    for (const [
      idHash,
      absoluteExpiresAt,
      idleExpiresAt,
      lastAccessedAt,
      revokedAt,
    ] of [
      [
        "1".repeat(64),
        "2026-08-06T00:00:00.000Z",
        "2026-08-06T01:00:00.000Z",
        "2026-08-06T00:00:00.000Z",
        null,
      ],
      [
        "2".repeat(64),
        "2026-08-06T02:00:00.000Z",
        "2026-08-06T00:00:00.000Z",
        "2026-08-06T00:00:00.000Z",
        null,
      ],
      [
        "3".repeat(64),
        "2026-08-06T01:00:00.000Z",
        "2026-08-06T02:00:00.000Z",
        "2026-08-06T00:00:00.000Z",
        null,
      ],
      [
        "4".repeat(64),
        "2026-08-06T02:00:00.000Z",
        "2026-08-06T01:00:00.000Z",
        "2026-08-05T23:59:00.000Z",
        null,
      ],
      [
        "5".repeat(64),
        "2026-08-06T02:00:00.000Z",
        "2026-08-06T01:00:00.000Z",
        "2026-08-06T00:00:00.000Z",
        "2026-08-05T23:59:00.000Z",
      ],
    ] as const) {
      await expect(
        pool.query(
          `insert into sessions (
           id_hash, user_id, absolute_expires_at, idle_expires_at,
           created_at, last_accessed_at, revoked_at
         ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            idHash,
            "user_constraint_target",
            absoluteExpiresAt,
            idleExpiresAt,
            "2026-08-06T00:00:00.000Z",
            lastAccessedAt,
            revokedAt,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects an identity that references a missing user", async () => {
    await expect(
      pool.query(
        `insert into user_identities (
         issuer, subject, provider, user_id, created_at, last_authenticated_at
       ) values ($1, $2, $3, $4, $5, $5)`,
        [
          "urn:issuer:missing-user",
          "subject-missing-user",
          "test",
          "user_does_not_exist",
          "2026-08-06T00:00:00.000Z",
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
