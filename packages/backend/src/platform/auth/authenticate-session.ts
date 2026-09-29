import type {
  Actor,
  AuthenticatedUser,
  StoredAuthentication,
} from "./auth.model.js";
import type { AuthSessionStore } from "./auth-session-store.js";
import type { SessionPolicy } from "./session-policy.js";

export type AuthenticateSession = (
  rawSessionId: string | undefined,
) => Promise<{ actor: Actor; user: AuthenticatedUser } | undefined>;

const isActive = (
  authentication: StoredAuthentication | undefined,
  now: Date,
): authentication is StoredAuthentication =>
  authentication !== undefined &&
  authentication.revokedAt === undefined &&
  authentication.absoluteExpiresAt.getTime() > now.getTime() &&
  authentication.idleExpiresAt.getTime() > now.getTime();

export const createAuthenticateSession = (_dependencies: {
  clock: () => Date;
  hashSessionId: (value: string) => string;
  policy: SessionPolicy;
  store: AuthSessionStore;
}): AuthenticateSession => {
  return async (rawSessionId) => {
    if (rawSessionId === undefined) return undefined;

    const idHash = _dependencies.hashSessionId(rawSessionId);
    let authentication = await _dependencies.store.findByIdHash(idHash);
    if (
      authentication === undefined ||
      authentication.revokedAt !== undefined
    ) {
      return undefined;
    }

    const now = _dependencies.clock();
    if (!isActive(authentication, now)) return undefined;

    if (
      now.getTime() - authentication.lastAccessedAt.getTime() >=
      _dependencies.policy.touchIntervalMs
    ) {
      const touched = await _dependencies.store.touch({
        idHash,
        observedLastAccessedAt: new Date(
          authentication.lastAccessedAt.getTime(),
        ),
        observedIdleExpiresAt: new Date(authentication.idleExpiresAt.getTime()),
        lastAccessedAt: new Date(now.getTime()),
        idleExpiresAt: new Date(
          Math.min(
            now.getTime() + _dependencies.policy.idleTtlMs,
            authentication.absoluteExpiresAt.getTime(),
          ),
        ),
      });
      if (!touched) {
        authentication = await _dependencies.store.findByIdHash(idHash);
        if (!isActive(authentication, now)) return undefined;
      }
    }

    const user = {
      ...authentication.user,
      roles: [...authentication.user.roles],
    };
    return {
      actor: { userId: user.id, roles: [...user.roles] },
      user,
    };
  };
};
