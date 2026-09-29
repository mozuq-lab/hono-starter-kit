import { describe, expect, it } from "vitest";
import { createVerifiedIdentity } from "./verified-identity.js";

describe("createVerifiedIdentity", () => {
  it("omits optional profile values rejected by the public user contract", () => {
    expect(
      createVerifiedIdentity({
        provider: "oidc",
        issuer: "https://issuer.example",
        subject: "subject-1",
        email: "not-an-email",
        displayName: "",
        roles: [],
      }),
    ).toEqual({
      provider: "oidc",
      issuer: "https://issuer.example",
      subject: "subject-1",
      roles: [],
    });
  });

  it("preserves valid profile values and clones validated roles", () => {
    const roles = ["projects:read"];

    const identity = createVerifiedIdentity({
      provider: "oidc",
      issuer: "https://issuer.example",
      subject: "subject-1",
      email: "user@example.com",
      displayName: "OIDC User",
      roles,
    });

    expect(identity).toEqual({
      provider: "oidc",
      issuer: "https://issuer.example",
      subject: "subject-1",
      email: "user@example.com",
      displayName: "OIDC User",
      roles: ["projects:read"],
    });
    expect(identity.roles).not.toBe(roles);
  });

  it("rejects roles that violate the public user contract", () => {
    expect(() =>
      createVerifiedIdentity({
        provider: "oidc",
        issuer: "https://issuer.example",
        subject: "subject-1",
        roles: [""],
      }),
    ).toThrow();
  });
});
