import { describe, expect, it } from "vitest";
import type { VerifiedIdentity } from "./auth.model.js";
import { InMemoryAuthSessionStore } from "./auth-session-store.memory.js";
import { createRevokeSession } from "./revoke-session.js";

const identity: VerifiedIdentity = {
  provider: "test",
  issuer: "urn:test",
  subject: "subject",
  roles: ["projects:read"],
};

describe("createRevokeSession", () => {
  it("does nothing when the session cookie is missing", async () => {
    const store = new InMemoryAuthSessionStore();
    const hashes: string[] = [];
    const revokeSession = createRevokeSession({
      hashSessionId: (value) => {
        hashes.push(value);
        return `hash:${value}`;
      },
      store,
    });

    await expect(revokeSession(undefined)).resolves.toBeUndefined();
    expect(hashes).toEqual([]);
  });

  it("hashes a present cookie before deleting the stored session", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish({
      identity,
      newUserId: "user_generated",
      session: {
        idHash: "hash:raw_session",
        absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
        idleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
        lastAccessedAt: new Date("2026-08-06T00:00:00.000Z"),
      },
    });
    const revokeSession = createRevokeSession({
      hashSessionId: (value) => `hash:${value}`,
      store,
    });

    await revokeSession("raw_session");

    await expect(store.findByIdHash("raw_session")).resolves.toBeUndefined();
    await expect(
      store.findByIdHash("hash:raw_session"),
    ).resolves.toBeUndefined();
  });
});
