import type {
  AuthenticatedUser,
  StoredAuthentication,
  VerifiedIdentity,
} from "./auth.model.js";

export type EstablishStoredSessionInput = {
  identity: VerifiedIdentity;
  newUserId: string;
  previousSessionIdHash?: string;
  session: {
    idHash: string;
    absoluteExpiresAt: Date;
    idleExpiresAt: Date;
    createdAt: Date;
    lastAccessedAt: Date;
    providerSessionId?: string;
  };
};

export type TouchStoredSessionInput = {
  idHash: string;
  observedLastAccessedAt: Date;
  observedIdleExpiresAt: Date;
  lastAccessedAt: Date;
  idleExpiresAt: Date;
};

export interface AuthSessionStore {
  establish(input: EstablishStoredSessionInput): Promise<AuthenticatedUser>;
  findByIdHash(idHash: string): Promise<StoredAuthentication | undefined>;
  touch(input: TouchStoredSessionInput): Promise<boolean>;
  /** session の行を消す。行が無くても成功する。 */
  revoke(input: { idHash: string }): Promise<void>;
  /**
   * idle 期限を過ぎた未失効の session を、期限の古い順に最大 limit 行消し、消した行数を返す。
   * idle 期限は絶対期限を超えない（DB の CHECK）ので、絶対期限切れの行もここで消える。
   */
  deleteExpired(input: { now: Date; limit: 100 }): Promise<number>;
}
