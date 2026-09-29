import { describe, expect, it } from "vitest";
import {
  generateSecureValue,
  generateSessionId,
  generateUserId,
  hashValue,
  hashSessionId,
} from "./session-crypto.js";

describe("session crypto", () => {
  it("generates unique 32-byte URL-safe values", () => {
    const values = Array.from({ length: 100 }, () => generateSecureValue());

    expect(new Set(values)).toHaveLength(100);
    for (const value of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
    }
  });

  it("generates unique 32-byte URL-safe session IDs", () => {
    const sessionIds = Array.from({ length: 100 }, () => generateSessionId());

    expect(new Set(sessionIds)).toHaveLength(100);
    for (const sessionId of sessionIds) {
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(sessionId, "base64url")).toHaveLength(32);
    }
  });

  it("generates namespaced UUID user IDs", () => {
    expect(generateUserId()).toMatch(/^user_[0-9a-f-]{36}$/);
  });

  it("hashes raw session IDs with SHA-256", () => {
    expect(hashSessionId("raw_session")).toBe(
      "f6f367b9f6152a649e30269540c0bc03194d8317f7617fab977cba2d18e04288",
    );
  });

  it("hashes generic values with the same SHA-256 primitive", () => {
    expect(hashValue("raw_session")).toBe(
      "f6f367b9f6152a649e30269540c0bc03194d8317f7617fab977cba2d18e04288",
    );
    expect(hashSessionId("raw_session")).toBe(hashValue("raw_session"));
  });

  it("keeps session generation as a compatibility alias", () => {
    expect(generateSessionId).toBe(generateSecureValue);
    const sessionId = generateSessionId();

    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(sessionId, "base64url")).toHaveLength(32);
  });
});
