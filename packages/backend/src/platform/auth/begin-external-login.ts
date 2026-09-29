import type { ExternalIdentityProvider } from "./external-identity-provider.js";
import type { ExternalLoginTransactionStore } from "./external-login-transaction-store.js";
import { resolveReturnTo } from "./return-to.js";

export type BeginExternalLogin = (input: {
  returnTo: string | undefined;
}) => Promise<{
  authorizationUrl: string;
  state: string;
  nonce: string;
  verifier: string;
}>;

export const createBeginExternalLogin = (dependencies: {
  clock: () => Date;
  hash: (value: string) => string;
  provider: ExternalIdentityProvider;
  redirectUri: string;
  store: ExternalLoginTransactionStore;
  ttlMs: number;
}): BeginExternalLogin => {
  return async ({ returnTo }) => {
    const now = dependencies.clock();
    await dependencies.store.deleteExpired({ now, limit: 100 });
    const authorization = await dependencies.provider.begin({
      redirectUri: dependencies.redirectUri,
    });
    await dependencies.store.create({
      stateHash: dependencies.hash(authorization.state),
      nonceHash: dependencies.hash(authorization.nonce),
      verifierHash: dependencies.hash(authorization.verifier),
      returnTo: resolveReturnTo(returnTo),
      createdAt: now,
      expiresAt: new Date(now.getTime() + dependencies.ttlMs),
    });
    return authorization;
  };
};
