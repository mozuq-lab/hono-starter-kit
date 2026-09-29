import type {
  AuthenticatedUser,
  AuthSessionStore,
  EstablishStoredSessionInput,
  StoredAuthentication,
  TouchStoredSessionInput,
} from "@starter/backend";
import { sql, type Kysely, type Selectable } from "kysely";
import type { Database, SessionsTable, UsersTable } from "./database.types.js";

type StoredAuthenticationRow = Pick<
  Selectable<SessionsTable>,
  | "id_hash"
  | "user_id"
  | "absolute_expires_at"
  | "idle_expires_at"
  | "last_accessed_at"
  | "revoked_at"
> &
  Pick<Selectable<UsersTable>, "email" | "display_name" | "roles">;

const toAuthenticatedUser = (
  row: Pick<Selectable<UsersTable>, "id" | "email" | "display_name" | "roles">,
): AuthenticatedUser => ({
  id: row.id,
  ...(row.email === null ? {} : { email: row.email }),
  ...(row.display_name === null ? {} : { displayName: row.display_name }),
  roles: [...row.roles],
});

export const toStoredAuthentication = (
  row: StoredAuthenticationRow,
): StoredAuthentication => ({
  idHash: row.id_hash,
  user: {
    id: row.user_id,
    ...(row.email === null ? {} : { email: row.email }),
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    roles: [...row.roles],
  },
  absoluteExpiresAt: new Date(row.absolute_expires_at.getTime()),
  idleExpiresAt: new Date(row.idle_expires_at.getTime()),
  lastAccessedAt: new Date(row.last_accessed_at.getTime()),
  ...(row.revoked_at === null
    ? {}
    : { revokedAt: new Date(row.revoked_at.getTime()) }),
});

export class KyselyAuthSessionStore implements AuthSessionStore {
  constructor(private readonly database: Kysely<Database>) {}

  establish(input: EstablishStoredSessionInput): Promise<AuthenticatedUser> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtext(${input.identity.issuer}), hashtext(${input.identity.subject}))`.execute(
        transaction,
      );

      const existingIdentity = await transaction
        .selectFrom("user_identities")
        .select(["user_id", "last_authenticated_at"])
        .where("issuer", "=", input.identity.issuer)
        .where("subject", "=", input.identity.subject)
        .executeTakeFirst();

      const userId = existingIdentity?.user_id ?? input.newUserId;
      let userRow: Pick<
        Selectable<UsersTable>,
        "id" | "email" | "display_name" | "roles"
      >;
      if (existingIdentity === undefined) {
        userRow = await transaction
          .insertInto("users")
          .values({
            id: userId,
            email: input.identity.email ?? null,
            display_name: input.identity.displayName ?? null,
            roles: [...input.identity.roles],
            created_at: input.session.createdAt,
            updated_at: input.session.createdAt,
          })
          .returning(["id", "email", "display_name", "roles"])
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("user_identities")
          .values({
            issuer: input.identity.issuer,
            subject: input.identity.subject,
            provider: input.identity.provider,
            user_id: userId,
            created_at: input.session.createdAt,
            last_authenticated_at: input.session.createdAt,
          })
          .execute();
      } else if (
        input.session.createdAt.getTime() >=
        existingIdentity.last_authenticated_at.getTime()
      ) {
        userRow = await transaction
          .updateTable("users")
          .set({
            email: input.identity.email ?? null,
            display_name: input.identity.displayName ?? null,
            roles: [...input.identity.roles],
            updated_at: input.session.createdAt,
          })
          .where("id", "=", userId)
          .returning(["id", "email", "display_name", "roles"])
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("user_identities")
          .set({ last_authenticated_at: input.session.createdAt })
          .where("issuer", "=", input.identity.issuer)
          .where("subject", "=", input.identity.subject)
          .execute();
      } else {
        userRow = await transaction
          .selectFrom("users")
          .select(["id", "email", "display_name", "roles"])
          .where("id", "=", userId)
          .executeTakeFirstOrThrow();
      }

      if (input.previousSessionIdHash !== undefined) {
        await transaction
          .deleteFrom("sessions")
          .where("id_hash", "=", input.previousSessionIdHash)
          .execute();
      }

      await transaction
        .insertInto("sessions")
        .values({
          id_hash: input.session.idHash,
          user_id: userId,
          absolute_expires_at: input.session.absoluteExpiresAt,
          idle_expires_at: input.session.idleExpiresAt,
          created_at: input.session.createdAt,
          last_accessed_at: input.session.lastAccessedAt,
          revoked_at: null,
          provider_session_id: input.session.providerSessionId ?? null,
        })
        .execute();

      return toAuthenticatedUser(userRow);
    });
  }

  async findByIdHash(
    idHash: string,
  ): Promise<StoredAuthentication | undefined> {
    const row = await this.database
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.user_id")
      .select([
        "sessions.id_hash",
        "sessions.user_id",
        "users.email",
        "users.display_name",
        "users.roles",
        "sessions.absolute_expires_at",
        "sessions.idle_expires_at",
        "sessions.last_accessed_at",
        "sessions.revoked_at",
      ])
      .where("sessions.id_hash", "=", idHash)
      .executeTakeFirst();

    return row === undefined ? undefined : toStoredAuthentication(row);
  }

  async touch(input: TouchStoredSessionInput): Promise<boolean> {
    const result = await this.database
      .updateTable("sessions")
      .set({
        last_accessed_at: input.lastAccessedAt,
        idle_expires_at: input.idleExpiresAt,
      })
      .where("id_hash", "=", input.idHash)
      // revoke は行を消すので新しいコードは revoked_at を書かない。列が残る間は、値の入った行を
      // 有効と扱わない安全側の判定として残す。
      .where("revoked_at", "is", null)
      .where("last_accessed_at", "=", input.observedLastAccessedAt)
      .where("idle_expires_at", "=", input.observedIdleExpiresAt)
      .where("last_accessed_at", "<", input.lastAccessedAt)
      .where("idle_expires_at", "<=", input.idleExpiresAt)
      .executeTakeFirst();

    return result.numUpdatedRows === 1n;
  }

  async revoke(input: { idHash: string }): Promise<void> {
    await this.database
      .deleteFrom("sessions")
      .where("id_hash", "=", input.idHash)
      .execute();
  }

  async deleteExpired(input: { now: Date; limit: 100 }): Promise<number> {
    const result = await this.database
      .deleteFrom("sessions")
      .where("id_hash", "in", (eb) =>
        eb
          .selectFrom("sessions")
          .select("id_hash")
          // 部分 index sessions_active_expiry_idx の述語。外すと index を使えず全件を走査する。
          .where("revoked_at", "is", null)
          .where("idle_expires_at", "<=", input.now)
          .orderBy("idle_expires_at", "asc")
          .limit(input.limit)
          // 同時にログインした 2 つの要求が同じ行を消そうとしても、行ロックを待たずに飛ばす。
          // 待たせると、行ロックの取得順が実行計画次第なのでデッドロックも起き得る。
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }
}
