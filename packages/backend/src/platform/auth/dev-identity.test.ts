import { describe, expect, it } from "vitest";
import { getDevIdentity } from "./dev-identity.js";

describe("getDevIdentity", () => {
  it("returns the stable local developer identity", () => {
    expect(getDevIdentity()).toEqual({
      provider: "dev",
      issuer: "urn:starter:dev",
      subject: "local-developer",
      email: "developer@starter.local",
      displayName: "Local Developer",
      roles: ["projects:read", "projects:write"],
    });
  });

  it("does not share its mutable roles array", () => {
    const first = getDevIdentity();
    first.roles.push("unexpected");

    expect(getDevIdentity().roles).toEqual(["projects:read", "projects:write"]);
  });
});
