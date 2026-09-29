import { describe, expect, it } from "vitest";
import { InMemoryExternalLoginTransactionStore } from "./external-login-transaction-store.memory.js";

describe("InMemoryExternalLoginTransactionStore", () => {
  it("consumes a matching unexpired transaction only once", async () => {
    const store = new InMemoryExternalLoginTransactionStore();
    await store.create({
      stateHash: "state",
      nonceHash: "nonce",
      verifierHash: "verifier",
      returnTo: "/projects",
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      expiresAt: new Date("2026-08-10T00:10:00.000Z"),
    });

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        store.consume({
          stateHash: "state",
          nonceHash: "nonce",
          verifierHash: "verifier",
          now: new Date("2026-08-10T00:00:00.000Z"),
        }),
      ),
    );

    expect(results).toEqual([
      {
        stateHash: "state",
        nonceHash: "nonce",
        verifierHash: "verifier",
        returnTo: "/projects",
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
        expiresAt: new Date("2026-08-10T00:10:00.000Z"),
      },
      undefined,
    ]);
  });

  it("clones input and output dates and deletes expired transactions in the requested batch", async () => {
    const store = new InMemoryExternalLoginTransactionStore();
    const createdAt = new Date("2026-08-10T00:00:00.000Z");
    const expiresAt = new Date("2026-08-10T00:10:00.000Z");
    await store.create({
      stateHash: "state",
      nonceHash: "nonce",
      verifierHash: "verifier",
      returnTo: "/projects",
      createdAt,
      expiresAt,
    });
    createdAt.setUTCFullYear(2030);
    expiresAt.setUTCFullYear(2030);

    const result = await store.consume({
      stateHash: "state",
      nonceHash: "nonce",
      verifierHash: "verifier",
      now: new Date("2026-08-10T00:00:00.000Z"),
    });

    expect(result).toEqual({
      stateHash: "state",
      nonceHash: "nonce",
      verifierHash: "verifier",
      returnTo: "/projects",
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      expiresAt: new Date("2026-08-10T00:10:00.000Z"),
    });

    await store.create({
      stateHash: "expired",
      nonceHash: "nonce",
      verifierHash: "verifier",
      returnTo: "/projects",
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      expiresAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    await expect(
      store.deleteExpired({
        now: new Date("2026-08-10T00:00:00.000Z"),
        limit: 100,
      }),
    ).resolves.toBe(1);
  });
});
