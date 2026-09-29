import { describe, expect, it } from "vitest";
import type { EstablishStoredSessionInput } from "./auth-session-store.js";
import { InMemoryAuthSessionStore } from "./auth-session-store.memory.js";

const createInput = (input: {
  idHash: string;
  newUserId: string;
  issuer: string;
  subject: string;
  authenticatedAt?: string;
  email?: string;
  displayName?: string;
  roles?: string[];
}): EstablishStoredSessionInput => {
  const authenticatedAt = new Date(
    input.authenticatedAt ?? "2026-08-06T00:00:00.000Z",
  );

  return {
    identity: {
      provider: "test",
      issuer: input.issuer,
      subject: input.subject,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.displayName === undefined
        ? {}
        : { displayName: input.displayName }),
      roles: input.roles ?? ["projects:read"],
    },
    newUserId: input.newUserId,
    session: {
      idHash: input.idHash,
      absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
      createdAt: authenticatedAt,
      lastAccessedAt: authenticatedAt,
    },
  };
};

describe("InMemoryAuthSessionStore", () => {
  it("known identities are reused on first login", async () => {
    const store = new InMemoryAuthSessionStore({
      knownIdentities: [
        { issuer: "urn:issuer", subject: "subject", userId: "user_known" },
      ],
    });

    const user = await store.establish(
      createInput({
        idHash: "hash:first",
        newUserId: "user_random",
        issuer: "urn:issuer",
        subject: "subject",
        email: "known@example.test",
        roles: ["projects:read"],
      }),
    );
    const other = await store.establish(
      createInput({
        idHash: "hash:other",
        newUserId: "user_other",
        issuer: "urn:issuer",
        subject: "other-subject",
      }),
    );

    expect(user).toEqual({
      id: "user_known",
      email: "known@example.test",
      roles: ["projects:read"],
    });
    expect(other.id).toBe("user_other");
    await expect(store.findByIdHash("hash:first")).resolves.toMatchObject({
      user: { id: "user_known" },
    });
  });

  it("keeps identities distinct when issuer and subject contain NUL characters", async () => {
    const store = new InMemoryAuthSessionStore();

    const first = await store.establish(
      createInput({
        idHash: "hash:first",
        newUserId: "user_first",
        issuer: "a\u0000b",
        subject: "c",
      }),
    );
    const second = await store.establish(
      createInput({
        idHash: "hash:second",
        newUserId: "user_second",
        issuer: "a",
        subject: "b\u0000c",
      }),
    );

    expect(first.id).toBe("user_first");
    expect(second.id).toBe("user_second");
  });

  it("reuses an identity user and refreshes trusted profile fields", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish(
      createInput({
        idHash: "hash:first",
        newUserId: "user_first_candidate",
        issuer: "urn:issuer",
        subject: "subject",
        email: "first@example.test",
        displayName: "First",
        roles: ["projects:read"],
      }),
    );

    await expect(
      store.establish(
        createInput({
          idHash: "hash:second",
          newUserId: "user_second_candidate",
          issuer: "urn:issuer",
          subject: "subject",
          email: "second@example.test",
          displayName: "Second",
          roles: ["projects:write"],
        }),
      ),
    ).resolves.toEqual({
      id: "user_first_candidate",
      email: "second@example.test",
      displayName: "Second",
      roles: ["projects:write"],
    });
    await expect(store.findByIdHash("hash:first")).resolves.toMatchObject({
      user: {
        id: "user_first_candidate",
        email: "second@example.test",
        displayName: "Second",
        roles: ["projects:write"],
      },
    });
  });

  it("preserves newer trusted profile state when an older authentication completes last", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish(
      createInput({
        idHash: "hash:newer",
        newUserId: "user_newer_candidate",
        issuer: "urn:issuer",
        subject: "subject",
        authenticatedAt: "2026-08-06T00:02:00.000Z",
        email: "newer@example.test",
        displayName: "Newer Profile",
        roles: ["projects:write"],
      }),
    );

    await expect(
      store.establish(
        createInput({
          idHash: "hash:older",
          newUserId: "user_older_candidate",
          issuer: "urn:issuer",
          subject: "subject",
          authenticatedAt: "2026-08-06T00:01:00.000Z",
          email: "older@example.test",
          displayName: "Older Profile",
          roles: ["projects:read"],
        }),
      ),
    ).resolves.toEqual({
      id: "user_newer_candidate",
      email: "newer@example.test",
      displayName: "Newer Profile",
      roles: ["projects:write"],
    });
    await expect(store.findByIdHash("hash:older")).resolves.toMatchObject({
      user: {
        id: "user_newer_candidate",
        email: "newer@example.test",
        displayName: "Newer Profile",
        roles: ["projects:write"],
      },
    });
    await expect(store.findByIdHash("hash:newer")).resolves.toMatchObject({
      user: {
        email: "newer@example.test",
        displayName: "Newer Profile",
        roles: ["projects:write"],
      },
    });
  });

  it.each([
    ["different issuer", "urn:issuer-two", "subject"],
    ["different subject", "urn:issuer", "subject-two"],
  ])(
    "does not link a matching email for a %s",
    async (_name, issuer, subject) => {
      const store = new InMemoryAuthSessionStore();
      await store.establish(
        createInput({
          idHash: "hash:first",
          newUserId: "user_first",
          issuer: "urn:issuer",
          subject: "subject",
          email: "same@example.test",
        }),
      );

      await expect(
        store.establish(
          createInput({
            idHash: "hash:second",
            newUserId: "user_second",
            issuer,
            subject,
            email: "same@example.test",
          }),
        ),
      ).resolves.toMatchObject({ id: "user_second" });
    },
  );

  it("allows only one monotonic touch from the same observed state", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish(
      createInput({
        idHash: "hash:session",
        newUserId: "user",
        issuer: "urn:issuer",
        subject: "subject",
      }),
    );
    const observed = await store.findByIdHash("hash:session");
    expect(observed).toBeDefined();

    const newerTouch = await store.touch({
      idHash: "hash:session",
      observedLastAccessedAt: observed!.lastAccessedAt,
      observedIdleExpiresAt: observed!.idleExpiresAt,
      lastAccessedAt: new Date("2026-08-06T00:06:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:06:00.000Z"),
    });
    const olderTouch = await store.touch({
      idHash: "hash:session",
      observedLastAccessedAt: observed!.lastAccessedAt,
      observedIdleExpiresAt: observed!.idleExpiresAt,
      lastAccessedAt: new Date("2026-08-06T00:05:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:05:00.000Z"),
    });

    expect([newerTouch, olderTouch]).toEqual([true, false]);
    await expect(store.findByIdHash("hash:session")).resolves.toMatchObject({
      lastAccessedAt: new Date("2026-08-06T00:06:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:06:00.000Z"),
    });
  });

  it("does not touch a revoked session", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish(
      createInput({
        idHash: "hash:session",
        newUserId: "user",
        issuer: "urn:issuer",
        subject: "subject",
      }),
    );
    const observed = await store.findByIdHash("hash:session");
    expect(observed).toBeDefined();
    await store.revoke({ idHash: "hash:session" });

    await expect(
      store.touch({
        idHash: "hash:session",
        observedLastAccessedAt: observed!.lastAccessedAt,
        observedIdleExpiresAt: observed!.idleExpiresAt,
        lastAccessedAt: new Date("2026-08-06T00:05:00.000Z"),
        idleExpiresAt: new Date("2026-08-07T00:05:00.000Z"),
      }),
    ).resolves.toBe(false);
    await expect(store.findByIdHash("hash:session")).resolves.toBeUndefined();
  });

  it("revoke removes the session and is a no-op for a missing session", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish(
      createInput({
        idHash: "hash:session",
        newUserId: "user",
        issuer: "urn:issuer",
        subject: "subject",
      }),
    );

    await store.revoke({ idHash: "hash:session" });
    await expect(store.findByIdHash("hash:session")).resolves.toBeUndefined();
    await expect(
      store.revoke({ idHash: "hash:session" }),
    ).resolves.toBeUndefined();
    await expect(
      store.revoke({ idHash: "hash:never_existed" }),
    ).resolves.toBeUndefined();
  });

  it("establish removes the previous session when rotating", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish(
      createInput({
        idHash: "hash:previous",
        newUserId: "user",
        issuer: "urn:issuer",
        subject: "subject",
      }),
    );

    await store.establish({
      ...createInput({
        idHash: "hash:next",
        newUserId: "user_candidate",
        issuer: "urn:issuer",
        subject: "subject",
        authenticatedAt: "2026-08-06T00:01:00.000Z",
      }),
      previousSessionIdHash: "hash:previous",
    });

    await expect(store.findByIdHash("hash:previous")).resolves.toBeUndefined();
    await expect(store.findByIdHash("hash:next")).resolves.toMatchObject({
      user: { id: "user" },
    });
  });

  it("deleteExpired removes unrevoked sessions whose idle expiry has passed, oldest first, up to the limit", async () => {
    const store = new InMemoryAuthSessionStore();
    const now = new Date("2026-08-10T00:00:00.000Z");
    const establishWithIdleExpiry = (idHash: string, idleExpiresAt: Date) =>
      store.establish({
        ...createInput({
          idHash,
          newUserId: "user",
          issuer: "urn:issuer",
          subject: "subject",
        }),
        session: {
          idHash,
          absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
          idleExpiresAt,
          createdAt: new Date("2026-08-06T00:00:00.000Z"),
          lastAccessedAt: new Date("2026-08-06T00:00:00.000Z"),
        },
      });
    // 挿入順と期限の順をずらし、Map の挿入順ではなく期限の古い順に消すことを確かめる。
    await establishWithIdleExpiry(
      "hash:newest_expired",
      new Date("2026-08-09T23:59:59.999Z"),
    );
    for (let index = 0; index < 100; index += 1) {
      await establishWithIdleExpiry(
        `hash:older_${index}`,
        new Date(Date.parse("2026-08-07T00:00:00.000Z") + index * 1000),
      );
    }
    await establishWithIdleExpiry("hash:at_boundary", new Date(now.getTime()));
    await establishWithIdleExpiry(
      "hash:not_expired",
      new Date("2026-08-10T00:00:00.001Z"),
    );

    await expect(store.deleteExpired({ now, limit: 100 })).resolves.toBe(100);
    await expect(store.findByIdHash("hash:older_0")).resolves.toBeUndefined();
    await expect(store.findByIdHash("hash:older_99")).resolves.toBeUndefined();
    await expect(
      store.findByIdHash("hash:newest_expired"),
    ).resolves.toBeDefined();
    await expect(store.findByIdHash("hash:at_boundary")).resolves.toBeDefined();

    await expect(store.deleteExpired({ now, limit: 100 })).resolves.toBe(2);
    await expect(
      store.findByIdHash("hash:newest_expired"),
    ).resolves.toBeUndefined();
    await expect(
      store.findByIdHash("hash:at_boundary"),
    ).resolves.toBeUndefined();
    await expect(store.findByIdHash("hash:not_expired")).resolves.toBeDefined();
    await expect(store.deleteExpired({ now, limit: 100 })).resolves.toBe(0);
  });

  it("returns cloned mutable values from authentication lookup", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.establish(
      createInput({
        idHash: "hash:session",
        newUserId: "user",
        issuer: "urn:issuer",
        subject: "subject",
      }),
    );

    const found = await store.findByIdHash("hash:session");
    found?.user.roles.push("mutated");
    found?.absoluteExpiresAt.setUTCFullYear(2040);
    found?.idleExpiresAt.setUTCFullYear(2040);
    found?.lastAccessedAt.setUTCFullYear(2040);

    await expect(store.findByIdHash("hash:session")).resolves.toEqual({
      idHash: "hash:session",
      user: { id: "user", roles: ["projects:read"] },
      absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
      lastAccessedAt: new Date("2026-08-06T00:00:00.000Z"),
    });
  });
});
