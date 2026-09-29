import type { AuthSessionStore } from "./auth-session-store.js";

export type RevokeSession = (rawSessionId: string | undefined) => Promise<void>;

export const createRevokeSession = (dependencies: {
  hashSessionId: (value: string) => string;
  store: AuthSessionStore;
}): RevokeSession => {
  return async (rawSessionId) => {
    if (rawSessionId === undefined) return;

    await dependencies.store.revoke({
      idHash: dependencies.hashSessionId(rawSessionId),
    });
  };
};
