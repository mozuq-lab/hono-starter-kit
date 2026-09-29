import { describe, expect, it } from "vitest";
import type { ExternalIdentityProvider } from "./external-identity-provider.js";
import type {
  ExternalLoginTransaction,
  ExternalLoginTransactionStore,
} from "./external-login-transaction-store.js";
import { createBeginExternalLogin } from "./begin-external-login.js";

class CapturingTransactionStore implements ExternalLoginTransactionStore {
  readonly created: ExternalLoginTransaction[] = [];
  readonly deleteExpiredInputs: { now: Date; limit: 100 }[] = [];

  create(input: ExternalLoginTransaction): Promise<void> {
    this.created.push(input);
    return Promise.resolve();
  }

  consume(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  deleteExpired(input: { now: Date; limit: 100 }): Promise<number> {
    this.deleteExpiredInputs.push(input);
    return Promise.resolve(0);
  }
}

describe("createBeginExternalLogin", () => {
  it("persists hashes and the normalized return path", async () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const store = new CapturingTransactionStore();
    const provider: ExternalIdentityProvider = {
      begin: ({ redirectUri }) => {
        expect(redirectUri).toBe("https://app.example/auth/callback");
        return Promise.resolve({
          authorizationUrl: "https://issuer.example/authorize?state=raw_state",
          state: "raw_state",
          nonce: "raw_nonce",
          verifier: "raw_verifier",
        });
      },
      complete: () => Promise.reject(new Error("not used by begin")),
      logoutUrl: () => "https://issuer.example/logout",
    };
    const beginExternalLogin = createBeginExternalLogin({
      clock: () => now,
      hash: (value) => `hash:${value}`,
      provider,
      redirectUri: "https://app.example/auth/callback",
      store,
      ttlMs: 600_000,
    });

    await expect(
      beginExternalLogin({ returnTo: "//evil.example" }),
    ).resolves.toEqual({
      authorizationUrl: "https://issuer.example/authorize?state=raw_state",
      state: "raw_state",
      nonce: "raw_nonce",
      verifier: "raw_verifier",
    });
    expect(store.deleteExpiredInputs).toEqual([{ now, limit: 100 }]);
    expect(store.created).toEqual([
      {
        stateHash: "hash:raw_state",
        nonceHash: "hash:raw_nonce",
        verifierHash: "hash:raw_verifier",
        returnTo: "/projects",
        createdAt: now,
        expiresAt: new Date("2026-08-10T00:10:00.000Z"),
      },
    ]);
  });
});
