import { describe, expect, it } from "vitest";
import { toStoredAuthentication } from "./auth-session-store.kysely.js";

describe("toStoredAuthentication", () => {
  it("maps a joined PostgreSQL row without leaking mutable row values", () => {
    const roles = ["projects:read"];
    const absoluteExpiresAt = new Date("2026-08-13T00:00:00.000Z");
    const idleExpiresAt = new Date("2026-08-07T00:00:00.000Z");
    const lastAccessedAt = new Date("2026-08-06T00:00:00.000Z");
    const row = {
      id_hash: "a".repeat(64),
      user_id: "user_123",
      email: "developer@starter.local",
      display_name: "Local Developer",
      roles,
      absolute_expires_at: absoluteExpiresAt,
      idle_expires_at: idleExpiresAt,
      last_accessed_at: lastAccessedAt,
      revoked_at: null,
    };

    const authentication = toStoredAuthentication(row);

    expect(authentication).toEqual({
      idHash: "a".repeat(64),
      user: {
        id: "user_123",
        email: "developer@starter.local",
        displayName: "Local Developer",
        roles: ["projects:read"],
      },
      absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
      lastAccessedAt: new Date("2026-08-06T00:00:00.000Z"),
    });
    expect(authentication.user.roles).not.toBe(roles);
    expect(authentication.absoluteExpiresAt).not.toBe(absoluteExpiresAt);
    expect(authentication.idleExpiresAt).not.toBe(idleExpiresAt);
    expect(authentication.lastAccessedAt).not.toBe(lastAccessedAt);
  });

  it("maps nullable profile fields and a revoked timestamp", () => {
    const revokedAt = new Date("2026-08-06T01:00:00.000Z");

    const authentication = toStoredAuthentication({
      id_hash: "b".repeat(64),
      user_id: "user_without_profile",
      email: null,
      display_name: null,
      roles: [],
      absolute_expires_at: new Date("2026-08-13T00:00:00.000Z"),
      idle_expires_at: new Date("2026-08-07T00:00:00.000Z"),
      last_accessed_at: new Date("2026-08-06T00:00:00.000Z"),
      revoked_at: revokedAt,
    });

    expect(authentication).toEqual({
      idHash: "b".repeat(64),
      user: { id: "user_without_profile", roles: [] },
      absoluteExpiresAt: new Date("2026-08-13T00:00:00.000Z"),
      idleExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
      lastAccessedAt: new Date("2026-08-06T00:00:00.000Z"),
      revokedAt: new Date("2026-08-06T01:00:00.000Z"),
    });
    expect(authentication.revokedAt).not.toBe(revokedAt);
  });
});
