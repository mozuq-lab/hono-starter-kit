import type { VerifiedIdentity } from "./auth.model.js";
import type { ExternalIdentityProvider } from "./external-identity-provider.js";
import type { ExternalLoginTransactionStore } from "./external-login-transaction-store.js";

export type CompleteExternalLogin = (input: {
  callbackUrl: URL;
  state: string;
  nonce: string;
  verifier: string;
}) => Promise<{ identity: VerifiedIdentity; returnTo: string }>;

export class ExternalLoginFailedError extends Error {
  constructor() {
    super("External login failed");
  }
}

export const createCompleteExternalLogin = (dependencies: {
  clock: () => Date;
  hash: (value: string) => string;
  provider: ExternalIdentityProvider;
  redirectUri: string;
  store: ExternalLoginTransactionStore;
}): CompleteExternalLogin => {
  return async ({ callbackUrl, state, nonce, verifier }) => {
    try {
      const now = dependencies.clock();
      await dependencies.store.deleteExpired({ now, limit: 100 });
      const transaction = await dependencies.store.consume({
        stateHash: dependencies.hash(state),
        nonceHash: dependencies.hash(nonce),
        verifierHash: dependencies.hash(verifier),
        now,
      });
      if (transaction === undefined) {
        throw new ExternalLoginFailedError();
      }

      const identity = await dependencies.provider.complete({
        callbackUrl,
        redirectUri: dependencies.redirectUri,
        expectedState: state,
        expectedNonce: nonce,
        verifier,
      });
      return {
        identity: { ...identity, roles: [...identity.roles] },
        returnTo: transaction.returnTo,
      };
    } catch {
      throw new ExternalLoginFailedError();
    }
  };
};
