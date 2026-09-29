import { describe, expect, it } from "vitest";
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
import { createAuthenticateSession } from "./authenticate-session.js";

const policy = {
  absoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  idleTtlMs: 24 * 60 * 60 * 1000,
  touchIntervalMs: 5 * 60 * 1000,
};

const identity: VerifiedIdentity = {
  provider: "test",
  issuer: "urn:test",
  subject: "subject",
  email: "subject@example.test",
  displayName: "Subject",
  roles: ["projects:read"],
};

class ObservedInMemoryAuthSessionStore implements AuthSessionStore {
  readonly #store = new InMemoryAuthSessionStore();
  readonly findCalls: string[] = [];
  // revoke は行を消すので、revoked_at 列に値の入った行はこのストアでは作れない。
  // 列が残る間の安全側の判定を確かめるため、読み出し結果に失効時刻を載せる。
  reportRevokedAt: Date | undefined;
  readonly touches: {
    idHash: string;
    observedLastAccessedAt: Date;
    observedIdleExpiresAt: Date;
    lastAccessedAt: Date;
    idleExpiresAt: Date;
  }[] = [];

  establish(input: EstablishStoredSessionInput): Promise<AuthenticatedUser> {
    return this.#store.establish(input);
  }

  async findByIdHash(
    idHash: string,
  ): Promise<StoredAuthentication | undefined> {
    this.findCalls.push(idHash);
    const authentication = await this.#store.findByIdHash(idHash);
    return authentication === undefined || this.reportRevokedAt === undefined
      ? authentication
      : { ...authentication, revokedAt: this.reportRevokedAt };
  }

  touch(input: {
    idHash: string;
    observedLastAccessedAt: Date;
    observedIdleExpiresAt: Date;
    lastAccessedAt: Date;
    idleExpiresAt: Date;
  }): Promise<boolean> {
    this.touches.push({
      ...input,
      observedLastAccessedAt: new Date(input.observedLastAccessedAt.getTime()),
      observedIdleExpiresAt: new Date(input.observedIdleExpiresAt.getTime()),
      lastAccessedAt: new Date(input.lastAccessedAt.getTime()),
      idleExpiresAt: new Date(input.idleExpiresAt.getTime()),
    });
    return this.#store.touch(input);
  }

  revoke(input: { idHash: string }): Promise<void> {
    return this.#store.revoke(input);
  }

  deleteExpired(input: { now: Date; limit: 100 }): Promise<number> {
    return this.#store.deleteExpired(input);
  }

  authentication(idHash = "hash:raw_session") {
    return this.#store.findByIdHash(idHash);
  }
}

const seedSession = async (
  store: AuthSessionStore,
  input: Partial<EstablishStoredSessionInput["session"]> = {},
) => {
  const start = new Date("2026-08-06T00:00:00.000Z");
  await store.establish({
    identity,
    newUserId: "user_generated",
    session: {
      idHash: "hash:raw_session",
      absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
      createdAt: start,
      lastAccessedAt: start,
      ...input,
    },
  });
};

describe("createAuthenticateSession", () => {
  it("does not hash or query when the session cookie is missing", async () => {
    const store = new ObservedInMemoryAuthSessionStore();
    const hashes: string[] = [];
    const authenticateSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      hashSessionId: (value) => {
        hashes.push(value);
        return `hash:${value}`;
      },
      policy,
      store,
    });

    await expect(authenticateSession(undefined)).resolves.toBeUndefined();
    expect(hashes).toEqual([]);
    expect(store.findCalls).toEqual([]);
  });

  it.each([
    ["revoked", undefined],
    [
      "absolute boundary",
      { absoluteExpiresAt: new Date("2026-08-06T00:00:00Z") },
    ],
    ["idle boundary", { idleExpiresAt: new Date("2026-08-06T00:00:00Z") }],
  ])("rejects %s sessions without touching them", async (_name, override) => {
    const store = new ObservedInMemoryAuthSessionStore();
    await seedSession(store, override);
    if (_name === "revoked") {
      store.reportRevokedAt = new Date("2026-08-05T23:59:00Z");
    }
    const authenticateSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await expect(authenticateSession("raw_session")).resolves.toBeUndefined();
    expect(store.touches).toEqual([]);
  });

  it("returns cloned actor and user values without touching inside the interval", async () => {
    const store = new ObservedInMemoryAuthSessionStore();
    await seedSession(store);
    const authenticateSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:04:59.000Z"),
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    const result = await authenticateSession("raw_session");
    expect(result).toEqual({
      actor: { userId: "user_generated", roles: ["projects:read"] },
      user: {
        id: "user_generated",
        email: "subject@example.test",
        displayName: "Subject",
        roles: ["projects:read"],
      },
    });
    expect(store.touches).toEqual([]);

    result?.actor.roles.push("unexpected");
    result?.user.roles.push("unexpected");
    await expect(store.authentication()).resolves.toMatchObject({
      user: { roles: ["projects:read"] },
    });
  });

  it("touches at the interval and caps idle expiry at absolute expiry", async () => {
    const store = new ObservedInMemoryAuthSessionStore();
    await seedSession(store, {
      absoluteExpiresAt: new Date("2026-08-06T00:06:00.000Z"),
    });
    const authenticateSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:05:00.000Z"),
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await expect(authenticateSession("raw_session")).resolves.toMatchObject({
      actor: { userId: "user_generated" },
    });
    expect(store.touches).toEqual([
      {
        idHash: "hash:raw_session",
        observedLastAccessedAt: new Date("2026-08-06T00:00:00.000Z"),
        observedIdleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
        lastAccessedAt: new Date("2026-08-06T00:05:00.000Z"),
        idleExpiresAt: new Date("2026-08-06T00:06:00.000Z"),
      },
    ]);
  });

  it("rechecks session state after losing a conditional touch", async () => {
    const backingStore = new InMemoryAuthSessionStore();
    await seedSession(backingStore);
    let findCount = 0;
    const store: AuthSessionStore = {
      establish: (input) => backingStore.establish(input),
      findByIdHash: async (idHash) => {
        findCount += 1;
        const authentication = await backingStore.findByIdHash(idHash);
        if (findCount === 2 && authentication !== undefined) {
          return {
            ...authentication,
            revokedAt: new Date("2026-08-06T00:05:00.000Z"),
          };
        }
        return authentication;
      },
      touch: () => Promise.resolve(false),
      revoke: (input) => backingStore.revoke(input),
      deleteExpired: (input) => backingStore.deleteExpired(input),
    };
    const authenticateSession = createAuthenticateSession({
      clock: () => new Date("2026-08-06T00:05:00.000Z"),
      hashSessionId: (value) => `hash:${value}`,
      policy,
      store,
    });

    await expect(authenticateSession("raw_session")).resolves.toBeUndefined();
    expect(findCount).toBe(2);
  });
});
