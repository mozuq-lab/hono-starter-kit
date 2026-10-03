import type { VerifiedIdentity } from "./auth.model.js";
import type { ExternalIdentityProvider } from "./external-identity-provider.js";
import type { ExternalLoginTransactionStore } from "./external-login-transaction-store.js";

export type CompleteExternalLogin = (input: {
  callbackUrl: URL;
  state: string;
  nonce: string;
  verifier: string;
}) => Promise<{ identity: VerifiedIdentity; returnTo: string }>;

/**
 * 失敗した段階。運用者が記録から原因の見当を付けるための閉じた値で、IdP や DB の生のエラーは
 * 持たせない（メッセージが接続先・認可コード・IdP の応答を含み得るため）。
 */
export type ExternalLoginFailureStage = "store" | "transaction" | "provider";

export class ExternalLoginFailedError extends Error {
  override readonly name = "ExternalLoginFailedError";
  readonly stage: ExternalLoginFailureStage;
  /** 取引を取り出せた後の失敗だけが持つ、開始時に検証して保存した戻り先。 */
  readonly returnTo: string | undefined;

  constructor(stage: ExternalLoginFailureStage, returnTo?: string) {
    super("External login failed");
    this.stage = stage;
    this.returnTo = returnTo;
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
    let transaction: { returnTo: string } | undefined;
    try {
      const now = dependencies.clock();
      await dependencies.store.deleteExpired({ now, limit: 100 });
      transaction = await dependencies.store.consume({
        stateHash: dependencies.hash(state),
        nonceHash: dependencies.hash(nonce),
        verifierHash: dependencies.hash(verifier),
        now,
      });
    } catch {
      throw new ExternalLoginFailedError("store");
    }
    if (transaction === undefined) {
      throw new ExternalLoginFailedError("transaction");
    }

    try {
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
      throw new ExternalLoginFailedError("provider", transaction.returnTo);
    }
  };
};
