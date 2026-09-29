import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Dialect,
} from "kysely";
import { expect, it } from "vitest";
import type { Database } from "./database.types.js";
import { seedAlphaProject, type AlphaOwner } from "./seed.js";

const createPostgresTestDialect = (): Dialect => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: (db) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
});

const alphaTimestamp = new Date("2026-08-03T00:00:00.000Z");

// 所有者は呼び出し側（api-node）が決める。Dev identity の既定値とは別の値で、渡したものが使われることを確かめる。
const owner: AlphaOwner = {
  identity: {
    provider: "dev",
    issuer: "urn:starter:seed-test",
    subject: "seed-subject",
    email: "seed@starter.local",
    displayName: "Seed Owner",
    roles: ["projects:read"],
  },
  userId: "user_seed_owner",
};

// DummyDriver は select に空の結果を返すので、Dev identity がまだない DB の経路になる。
// 既にログインした DB の経路と、実際の制約は DB 統合テスト（projects.integration.test.ts）が確かめる。
it("creates the Dev user and upserts the canonical alpha project owned by it", async () => {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<Database>({
    dialect: createPostgresTestDialect(),
    log(event) {
      if (event.level === "query") {
        queries.push(event.query);
      }
    },
  });

  try {
    await seedAlphaProject(db, owner);
  } finally {
    await db.destroy();
  }

  expect(queries.map((query) => query.sql)).toEqual([
    // establish（auth-session-store.kysely.ts）と同じ鍵で、並行する Dev ログインと直列化する。
    "select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    'select "user_id" from "user_identities" where "issuer" = $1 and "subject" = $2',
    'insert into "users" ("id", "email", "display_name", "roles", "created_at", "updated_at") values ($1, $2, $3, $4, $5, $6)',
    'insert into "user_identities" ("issuer", "subject", "provider", "user_id", "created_at", "last_authenticated_at") values ($1, $2, $3, $4, $5, $6)',
    'insert into "projects" ("id", "owner_user_id", "name", "status", "version", "created_at", "updated_at") values ($1, $2, $3, $4, $5, $6, $7) on conflict ("id") do update set "owner_user_id" = $8, "name" = $9, "status" = $10, "version" = $11, "created_at" = $12, "updated_at" = $13',
  ]);
  expect(queries[0]?.parameters).toEqual([
    "urn:starter:seed-test",
    "seed-subject",
  ]);
  expect(queries[4]?.parameters).toEqual([
    "project_alpha",
    "user_seed_owner",
    "Alpha",
    "active",
    1,
    alphaTimestamp,
    alphaTimestamp,
    "user_seed_owner",
    "Alpha",
    "active",
    1,
    alphaTimestamp,
    alphaTimestamp,
  ]);
});
