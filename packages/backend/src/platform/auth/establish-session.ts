import {
  ignoreSuppressedError,
  type ReportSuppressedError,
} from "../errors/report-suppressed-error.js";
import type { AuthenticatedUser, VerifiedIdentity } from "./auth.model.js";
import type { AuthSessionStore } from "./auth-session-store.js";
import type { SessionPolicy } from "./session-policy.js";

export type EstablishSession = (input: {
  identity: VerifiedIdentity;
  previousSessionId?: string;
}) => Promise<{ sessionId: string; user: AuthenticatedUser }>;

export const createEstablishSession = (dependencies: {
  clock: () => Date;
  generateSessionId: () => string;
  generateUserId: () => string;
  hashSessionId: (value: string) => string;
  policy: SessionPolicy;
  reportSuppressedError?: ReportSuppressedError;
  store: AuthSessionStore;
}): EstablishSession => {
  const reportSuppressedError =
    dependencies.reportSuppressedError ?? ignoreSuppressedError;
  return async ({ identity, previousSessionId }) => {
    const now = dependencies.clock();
    const sessionId = dependencies.generateSessionId();
    const user = await dependencies.store.establish({
      identity: { ...identity, roles: [...identity.roles] },
      newUserId: dependencies.generateUserId(),
      ...(previousSessionId === undefined
        ? {}
        : {
            previousSessionIdHash:
              dependencies.hashSessionId(previousSessionId),
          }),
      session: {
        idHash: dependencies.hashSessionId(sessionId),
        absoluteExpiresAt: new Date(
          now.getTime() + dependencies.policy.absoluteTtlMs,
        ),
        idleExpiresAt: new Date(now.getTime() + dependencies.policy.idleTtlMs),
        createdAt: new Date(now.getTime()),
        lastAccessedAt: new Date(now.getTime()),
        ...(identity.providerSessionId === undefined
          ? {}
          : { providerSessionId: identity.providerSessionId }),
      },
    });

    // 掃除は新しい session を確立した後に、その transaction の外で行う。advisory lock を
    // 取る transaction を長くしないため。失敗してもログインは成功させる。OIDC では認可コードの
    // 交換まで済んでおり、落とすと IdP の往復をやり直させるうえ、route は例外を記録せずに
    // 握るので運用者も気付けない。
    try {
      await dependencies.store.deleteExpired({
        now: new Date(now.getTime()),
        limit: 100,
      });
    } catch (error) {
      reportSuppressedError({ operation: "auth.session-cleanup", error });
    }

    return { sessionId, user: { ...user, roles: [...user.roles] } };
  };
};
