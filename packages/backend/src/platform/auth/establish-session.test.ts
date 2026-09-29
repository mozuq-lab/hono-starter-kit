import { describe, expect, it } from "vitest";
import type { SuppressedErrorEvent } from "../errors/report-suppressed-error.js";
import type {
  AuthenticatedUser,
  StoredAuthentication,
  VerifiedIdentity,
} from "./auth.model.js";
import type {
  AuthSessionStore,
  EstablishStoredSessionInput,
} from "./auth-session-store.js";
import { InMemoryAuthSessionStore } from "./auth-session-store.memory.js";
import { createEstablishSession } from "./establish-session.js";

const policy = {
  absoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  idleTtlMs: 24 * 60 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
};

const identity = (): VerifiedIdentity => ({
  provider: "test",
  issuer: "urn:test",
  subject: "subject",
  email: "subject@example.test",
  displayName: "Subject",
  roles: ["projects:read"],
  providerSessionId: "provider_session",
});

class CapturingInMemoryAuthSessionStore implements AuthSessionStore {
  readonly #store = new InMemoryAuthSessionStore();
  readonly establishInputs: EstablishStoredSessionInput[] = [];
  readonly calls: string[] = [];
  deleteExpiredInputs: { now: Date; limit: 100 }[] = [];
  deleteExpiredError: Error | undefined;

  establish(input: EstablishStoredSessionInput): Promise<AuthenticatedUser> {
    this.calls.push("establish");
    this.establishInputs.push(input);
    return this.#store.establish(input);
  }

  findByIdHash(idHash: string): Promise<StoredAuthentication | undefined> {
    return this.#store.findByIdHash(idHash);
  }

  touch(input: {
    idHash: string;
    observedLastAccessedAt: Date;
    observedIdleExpiresAt: Date;
    lastAccessedAt: Date;
    idleExpiresAt: Date;
  }): Promise<boolean> {
    return this.#store.touch(input);
  }

  revoke(input: { idHash: string }): Promise<void> {
    return this.#store.revoke(input);
  }

  deleteExpired(input: { now: Date; limit: 100 }): Promise<number> {
    this.calls.push("deleteExpired");
    this.deleteExpiredInputs.push(input);
    if (this.deleteExpiredError !== undefined) {
      return Promise.reject(this.deleteExpiredError);
    }
    return this.#store.deleteExpired(input);
  }
}

describe("createEstablishSession", () => {
  it("hashes session IDs before storing a session with policy expiries", async () => {
    const store = new InMemoryAuthSessionStore();
    const establishSession = createEstablishSession({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      generateSessionId: () => "raw_new_session",
      generateUserId: () => "user_generated",
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await expect(establishSession({ identity: identity() })).resolves.toEqual({
      sessionId: "raw_new_session",
      user: {
        id: "user_generated",
        email: "subject@example.test",
        displayName: "Subject",
        roles: ["projects:read"],
      },
    });
    await expect(
      store.findByIdHash("raw_new_session"),
    ).resolves.toBeUndefined();
    await expect(store.findByIdHash("hash:raw_new_session")).resolves.toEqual({
      idHash: "hash:raw_new_session",
      user: {
        id: "user_generated",
        email: "subject@example.test",
        displayName: "Subject",
        roles: ["projects:read"],
      },
      absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
      lastAccessedAt: new Date("2026-08-06T00:00:00.000Z"),
    });
  });

  it("rotates a supplied previous session using only its hash", async () => {
    const store = new InMemoryAuthSessionStore();
    let sessionCount = 0;
    const establishSession = createEstablishSession({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      generateSessionId: () => `raw_session_${++sessionCount}`,
      generateUserId: () => "user_generated",
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await establishSession({ identity: identity() });
    await establishSession({
      identity: identity(),
      previousSessionId: "raw_session_1",
    });

    await expect(store.findByIdHash("raw_session_1")).resolves.toBeUndefined();
    await expect(
      store.findByIdHash("hash:raw_session_1"),
    ).resolves.toBeUndefined();
    await expect(
      store.findByIdHash("hash:raw_session_2"),
    ).resolves.toMatchObject({
      user: { id: "user_generated" },
    });
  });

  it("copies mutable identity roles and generated dates at the store boundary", async () => {
    const store = new InMemoryAuthSessionStore();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const verifiedIdentity = identity();
    const establishSession = createEstablishSession({
      clock: () => now,
      generateSessionId: () => "raw_new_session",
      generateUserId: () => "user_generated",
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await establishSession({ identity: verifiedIdentity });
    verifiedIdentity.roles.push("unexpected");
    now.setUTCFullYear(2040);

    const stored = await store.findByIdHash("hash:raw_new_session");
    expect(stored?.user.roles).toEqual(["projects:read"]);
    expect(stored?.lastAccessedAt).toEqual(
      new Date("2026-08-06T00:00:00.000Z"),
    );
  });

  it("delegates independently copied roles and all session dates", async () => {
    const store = new CapturingInMemoryAuthSessionStore();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const verifiedIdentity = identity();
    const establishSession = createEstablishSession({
      clock: () => now,
      generateSessionId: () => "raw_new_session",
      generateUserId: () => "user_generated",
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await establishSession({ identity: verifiedIdentity });

    const [delegated] = store.establishInputs;
    expect(delegated).toBeDefined();
    expect(delegated?.identity.roles).not.toBe(verifiedIdentity.roles);
    expect(delegated?.session.absoluteExpiresAt).not.toBe(now);
    expect(delegated?.session.idleExpiresAt).not.toBe(now);
    expect(delegated?.session.createdAt).not.toBe(now);
    expect(delegated?.session.lastAccessedAt).not.toBe(now);
    expect(
      new Set([
        delegated?.session.absoluteExpiresAt,
        delegated?.session.idleExpiresAt,
        delegated?.session.createdAt,
        delegated?.session.lastAccessedAt,
      ]).size,
    ).toBe(4);

    verifiedIdentity.roles.push("source mutation");
    now.setUTCFullYear(2040);

    expect(delegated?.identity.roles).toEqual(["projects:read"]);
    expect(delegated?.session.createdAt).toEqual(
      new Date("2026-08-06T00:00:00.000Z"),
    );
  });

  it("deletes idle-expired sessions after establishing the new session", async () => {
    const store = new CapturingInMemoryAuthSessionStore();
    await store.establish({
      identity: identity(),
      newUserId: "user_stale",
      session: {
        idHash: "hash:stale_session",
        absoluteExpiresAt: new Date("2026-08-05T00:00:00.000Z"),
        idleExpiresAt: new Date("2026-08-05T00:00:00.000Z"),
        createdAt: new Date("2026-08-04T00:00:00.000Z"),
        lastAccessedAt: new Date("2026-08-04T00:00:00.000Z"),
      },
    });
    store.calls.length = 0;
    const establishSession = createEstablishSession({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      generateSessionId: () => "raw_new_session",
      generateUserId: () => "user_generated",
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await establishSession({ identity: identity() });

    expect(store.calls).toEqual(["establish", "deleteExpired"]);
    expect(store.deleteExpiredInputs).toEqual([
      { now: new Date("2026-08-06T00:00:00.000Z"), limit: 100 },
    ]);
    await expect(
      store.findByIdHash("hash:stale_session"),
    ).resolves.toBeUndefined();
    await expect(
      store.findByIdHash("hash:raw_new_session"),
    ).resolves.toBeDefined();
  });

  it("still returns the new session and reports the failure as auth.session-cleanup when cleanup throws", async () => {
    const store = new CapturingInMemoryAuthSessionStore();
    const cleanupError = new Error("cleanup failed");
    store.deleteExpiredError = cleanupError;
    const reported: SuppressedErrorEvent[] = [];
    const establishSession = createEstablishSession({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      generateSessionId: () => "raw_new_session",
      generateUserId: () => "user_generated",
      hashSessionId: (value) => `hash:${value}`,
      policy,
      reportSuppressedError: (event) => {
        reported.push(event);
      },
      store,
    });

    await expect(establishSession({ identity: identity() })).resolves.toEqual({
      sessionId: "raw_new_session",
      user: {
        id: "user_generated",
        email: "subject@example.test",
        displayName: "Subject",
        roles: ["projects:read"],
      },
    });
    expect(reported).toEqual([
      { operation: "auth.session-cleanup", error: cleanupError },
    ]);
    await expect(
      store.findByIdHash("hash:raw_new_session"),
    ).resolves.toBeDefined();
  });

  it("does not run cleanup when establishing the session fails", async () => {
    const store = new CapturingInMemoryAuthSessionStore();
    const establishSession = createEstablishSession({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      generateSessionId: () => "raw_new_session",
      generateUserId: () => "user_generated",
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store: {
        establish: () => Promise.reject(new Error("establish failed")),
        findByIdHash: (idHash) => store.findByIdHash(idHash),
        touch: (input) => store.touch(input),
        revoke: (input) => store.revoke(input),
        deleteExpired: (input) => store.deleteExpired(input),
      },
    });

    await expect(establishSession({ identity: identity() })).rejects.toThrow(
      "establish failed",
    );
    expect(store.deleteExpiredInputs).toEqual([]);
  });
});
