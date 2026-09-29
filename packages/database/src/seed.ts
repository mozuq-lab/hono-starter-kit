import type { VerifiedIdentity } from "@starter/backend";
import { sql, type Kysely } from "kysely";
import type { Database } from "./database.types.js";

const alphaTimestamp = new Date("2026-08-03T00:00:00.000Z");

/** Alpha の所有者にする Dev identity と、その identity がまだないときに作る user の ID。 */
export type AlphaOwner = { identity: VerifiedIdentity; userId: string };

// Alpha の所有者は Dev identity に結び付いた user にする。seed より先に Dev でログインした DB
// （pnpm db:migrate → ログイン → pnpm db:seed の順）では、identity がログイン時のランダムな
// user_id を指しているので、固定の ID を所有者にすると Dev ユーザーから Alpha が見えない。
// identity を固定の ID に付け替えると、既存の session の user_id と食い違う。
export const seedAlphaProject = (
  db: Kysely<Database>,
  { identity, userId }: AlphaOwner,
): Promise<void> =>
  db.transaction().execute(async (transaction) => {
    // establish（auth-session-store.kysely.ts）と同じ鍵。並行する Dev ログインと直列化し、
    // identity を二重に作らない。
    await sql`select pg_advisory_xact_lock(hashtext(${identity.issuer}), hashtext(${identity.subject}))`.execute(
      transaction,
    );

    const existing = await transaction
      .selectFrom("user_identities")
      .select("user_id")
      .where("issuer", "=", identity.issuer)
      .where("subject", "=", identity.subject)
      .executeTakeFirst();

    const ownerUserId = existing?.user_id ?? userId;
    if (existing === undefined) {
      // 以後の Dev ログインは establish の既存 identity の経路に乗り、この user を使う。
      await transaction
        .insertInto("users")
        .values({
          id: userId,
          email: identity.email ?? null,
          display_name: identity.displayName ?? null,
          roles: [...identity.roles],
          created_at: alphaTimestamp,
          updated_at: alphaTimestamp,
        })
        .execute();
      await transaction
        .insertInto("user_identities")
        .values({
          issuer: identity.issuer,
          subject: identity.subject,
          provider: identity.provider,
          user_id: userId,
          created_at: alphaTimestamp,
          last_authenticated_at: alphaTimestamp,
        })
        .execute();
    }

    // 更新側にも所有者と時刻を入れる。入れないと、改名や所有者の変わった Alpha が
    // 再 seed で既知の状態に戻らない。
    const alpha = {
      owner_user_id: ownerUserId,
      name: "Alpha",
      status: "active" as const,
      version: 1,
      created_at: alphaTimestamp,
      updated_at: alphaTimestamp,
    };
    await transaction
      .insertInto("projects")
      .values({ id: "project_alpha", ...alpha })
      .onConflict((conflict) => conflict.column("id").doUpdateSet(alpha))
      .execute();
  });
