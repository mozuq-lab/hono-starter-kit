import { describe, expect, it } from "vitest";
import type { VerifiedIdentity } from "./auth.model.js";
import {
  createCompleteExternalLogin,
  ExternalLoginFailedError,
} from "./complete-external-login.js";
import type { ExternalIdentityProvider } from "./external-identity-provider.js";
import { InMemoryExternalLoginTransactionStore } from "./external-login-transaction-store.memory.js";

const now = new Date("2026-08-10T00:00:00.000Z");
const identity: VerifiedIdentity = {
  provider: "oidc",
  issuer: "https://issuer.example",
  subject: "subject",
  roles: ["projects:read"],
};

const createProvider = (
  complete: (input: {
    callbackUrl: URL;
    redirectUri: string;
    expectedState: string;
    expectedNonce: string;
    verifier: string;
  }) => Promise<VerifiedIdentity> = (input) => {
    expect(input).toEqual({
      callbackUrl: new URL(
        "https://app.example/auth/callback?code=code&state=raw_state",
      ),
      redirectUri: "https://app.example/auth/callback",
      expectedState: "raw_state",
      expectedNonce: "raw_nonce",
      verifier: "raw_verifier",
    });
    return Promise.resolve(identity);
  },
): ExternalIdentityProvider => ({
  begin: () => Promise.reject(new Error("not used by completion")),
  complete,
  logoutUrl: () => "https://issuer.example/logout",
});

const createCompleteLogin = async (input?: {
  expiresAt?: Date;
  provider?: ExternalIdentityProvider;
}) => {
  const store = new InMemoryExternalLoginTransactionStore();
  await store.create({
    stateHash: "hash:raw_state",
    nonceHash: "hash:raw_nonce",
    verifierHash: "hash:raw_verifier",
    returnTo: "/projects",
    createdAt: now,
    expiresAt: input?.expiresAt ?? new Date("2026-08-10T00:10:00.000Z"),
  });
  return createCompleteExternalLogin({
    clock: () => now,
    hash: (value) => `hash:${value}`,
    provider: input?.provider ?? createProvider(),
    redirectUri: "https://app.example/auth/callback",
    store,
  });
};

const validCallback = {
  callbackUrl: new URL(
    "https://app.example/auth/callback?code=code&state=raw_state",
  ),
  state: "raw_state",
  nonce: "raw_nonce",
  verifier: "raw_verifier",
};

describe("createCompleteExternalLogin", () => {
  it("allows only one matching callback", async () => {
    const completeExternalLogin = await createCompleteLogin();

    await expect(completeExternalLogin(validCallback)).resolves.toEqual({
      identity,
      returnTo: "/projects",
    });
    await expect(completeExternalLogin(validCallback)).rejects.toThrow(
      ExternalLoginFailedError,
    );
  });

  it.each([
    { ...validCallback, state: "wrong_state" },
    { ...validCallback, nonce: "wrong_nonce" },
    { ...validCallback, verifier: "wrong_verifier" },
  ])(
    "does not consume a transaction when one protocol value differs",
    async (callback) => {
      const completeExternalLogin = await createCompleteLogin();

      await expect(completeExternalLogin(callback)).rejects.toThrow(
        ExternalLoginFailedError,
      );
      await expect(completeExternalLogin(validCallback)).resolves.toEqual({
        identity,
        returnTo: "/projects",
      });
    },
  );

  it.each([
    ["missing", undefined, createProvider(), "transaction", undefined],
    [
      "expired",
      new Date("2026-08-10T00:00:00.000Z"),
      createProvider(),
      "transaction",
      undefined,
    ],
    [
      "provider",
      new Date("2026-08-10T00:10:00.000Z"),
      createProvider(() =>
        Promise.reject(new Error("provider rejected raw_state")),
      ),
      "provider",
      "/projects",
    ],
  ])(
    "collapses %s failures to a generic error that names only the stage",
    async (_, expiresAt, provider, stage, returnTo) => {
      const completeExternalLogin =
        expiresAt === undefined
          ? createCompleteExternalLogin({
              clock: () => now,
              hash: (value) => `hash:${value}`,
              provider,
              redirectUri: "https://app.example/auth/callback",
              store: new InMemoryExternalLoginTransactionStore(),
            })
          : await createCompleteLogin({ expiresAt, provider });

      const error: unknown = await completeExternalLogin(validCallback).catch(
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(ExternalLoginFailedError);
      expect(error).toMatchObject({
        name: "ExternalLoginFailedError",
        message: "External login failed",
        stage,
      });
      expect((error as ExternalLoginFailedError).returnTo).toBe(returnTo);
      expect(error).not.toHaveProperty("cause");
    },
  );

  it("reports a failing transaction store as the store stage without its error", async () => {
    const store = new InMemoryExternalLoginTransactionStore();
    store.consume = () =>
      Promise.reject(new Error("connect ECONNREFUSED 10.0.1.5:5432"));
    const completeExternalLogin = createCompleteExternalLogin({
      clock: () => now,
      hash: (value) => `hash:${value}`,
      provider: createProvider(),
      redirectUri: "https://app.example/auth/callback",
      store,
    });

    const error: unknown = await completeExternalLogin(validCallback).catch(
      (rejection: unknown) => rejection,
    );
    expect(error).toMatchObject({ stage: "store" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("10.0.1.5");
  });
});
