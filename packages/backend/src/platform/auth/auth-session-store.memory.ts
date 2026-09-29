import type {
  AuthenticatedUser,
  StoredAuthentication,
  VerifiedIdentity,
} from "./auth.model.js";
import type {
  AuthSessionStore,
  EstablishStoredSessionInput,
  TouchStoredSessionInput,
} from "./auth-session-store.js";

const cloneUser = (user: AuthenticatedUser): AuthenticatedUser => ({
  ...user,
  roles: [...user.roles],
});

const cloneAuthentication = (
  authentication: StoredAuthentication,
): StoredAuthentication => ({
  ...authentication,
  user: cloneUser(authentication.user),
  absoluteExpiresAt: new Date(authentication.absoluteExpiresAt.getTime()),
  idleExpiresAt: new Date(authentication.idleExpiresAt.getTime()),
  lastAccessedAt: new Date(authentication.lastAccessedAt.getTime()),
});

const toUser = (identity: VerifiedIdentity, id: string): AuthenticatedUser => ({
  id,
  ...(identity.email === undefined ? {} : { email: identity.email }),
  ...(identity.displayName === undefined
    ? {}
    : { displayName: identity.displayName }),
  roles: [...identity.roles],
});

type StoredIdentity = {
  user: AuthenticatedUser;
  lastAuthenticatedAt: Date;
};

/**
 * 起動時から user に結び付いている identity。DB の seed が Dev identity を固定の user に
 * 結び付けておくのと同じことを、起動のたびに空から始まる memory store で再現する。
 * これがないと Dev ログインの user ID が毎回ランダムになり、fixture の Project の所有者と一致しない。
 */
export type KnownIdentity = {
  issuer: string;
  subject: string;
  userId: string;
};

export class InMemoryAuthSessionStore implements AuthSessionStore {
  #identitiesByIssuer = new Map<string, Map<string, StoredIdentity>>();
  #authenticationsByIdHash = new Map<string, StoredAuthentication>();
  #knownUserIds = new Map<string, Map<string, string>>();

  constructor({
    knownIdentities = [],
  }: { knownIdentities?: readonly KnownIdentity[] } = {}) {
    for (const identity of knownIdentities) {
      const bySubject =
        this.#knownUserIds.get(identity.issuer) ?? new Map<string, string>();
      bySubject.set(identity.subject, identity.userId);
      this.#knownUserIds.set(identity.issuer, bySubject);
    }
  }

  establish(input: EstablishStoredSessionInput): Promise<AuthenticatedUser> {
    const identitiesBySubject =
      this.#identitiesByIssuer.get(input.identity.issuer) ??
      new Map<string, StoredIdentity>();
    this.#identitiesByIssuer.set(input.identity.issuer, identitiesBySubject);
    const existing = identitiesBySubject.get(input.identity.subject);
    const authenticationTime = input.session.createdAt.getTime();
    const refreshIdentity =
      existing === undefined ||
      authenticationTime >= existing.lastAuthenticatedAt.getTime();
    const user = refreshIdentity
      ? toUser(
          input.identity,
          existing?.user.id ??
            this.#knownUserIds
              .get(input.identity.issuer)
              ?.get(input.identity.subject) ??
            input.newUserId,
        )
      : cloneUser(existing.user);

    if (refreshIdentity) {
      identitiesBySubject.set(input.identity.subject, {
        user: cloneUser(user),
        lastAuthenticatedAt: new Date(authenticationTime),
      });

      for (const authentication of this.#authenticationsByIdHash.values()) {
        if (authentication.user.id === user.id) {
          authentication.user = cloneUser(user);
        }
      }
    }

    if (input.previousSessionIdHash !== undefined) {
      this.#authenticationsByIdHash.delete(input.previousSessionIdHash);
    }

    this.#authenticationsByIdHash.set(input.session.idHash, {
      idHash: input.session.idHash,
      user: cloneUser(user),
      absoluteExpiresAt: new Date(input.session.absoluteExpiresAt.getTime()),
      idleExpiresAt: new Date(input.session.idleExpiresAt.getTime()),
      lastAccessedAt: new Date(input.session.lastAccessedAt.getTime()),
    });
    return Promise.resolve(cloneUser(user));
  }

  findByIdHash(idHash: string): Promise<StoredAuthentication | undefined> {
    const authentication = this.#authenticationsByIdHash.get(idHash);
    return Promise.resolve(
      authentication === undefined
        ? undefined
        : cloneAuthentication(authentication),
    );
  }

  touch(input: TouchStoredSessionInput): Promise<boolean> {
    const authentication = this.#authenticationsByIdHash.get(input.idHash);
    if (
      authentication === undefined ||
      authentication.lastAccessedAt.getTime() !==
        input.observedLastAccessedAt.getTime() ||
      authentication.idleExpiresAt.getTime() !==
        input.observedIdleExpiresAt.getTime() ||
      input.lastAccessedAt.getTime() <=
        authentication.lastAccessedAt.getTime() ||
      input.idleExpiresAt.getTime() < authentication.idleExpiresAt.getTime()
    ) {
      return Promise.resolve(false);
    }

    authentication.lastAccessedAt = new Date(input.lastAccessedAt.getTime());
    authentication.idleExpiresAt = new Date(input.idleExpiresAt.getTime());
    return Promise.resolve(true);
  }

  revoke(input: { idHash: string }): Promise<void> {
    this.#authenticationsByIdHash.delete(input.idHash);
    return Promise.resolve();
  }

  deleteExpired(input: { now: Date; limit: 100 }): Promise<number> {
    const expired = [...this.#authenticationsByIdHash.values()]
      .filter(
        (authentication) =>
          authentication.idleExpiresAt.getTime() <= input.now.getTime(),
      )
      .sort(
        (left, right) =>
          left.idleExpiresAt.getTime() - right.idleExpiresAt.getTime(),
      )
      .slice(0, input.limit);
    for (const authentication of expired) {
      this.#authenticationsByIdHash.delete(authentication.idHash);
    }
    return Promise.resolve(expired.length);
  }
}
