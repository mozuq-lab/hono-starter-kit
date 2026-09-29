import { describe, expect, it } from "vitest";
import { meResponseSchema } from "./auth.contract.js";

describe("meResponseSchema", () => {
  it("accepts the public authenticated user shape", () => {
    expect(
      meResponseSchema.parse({
        user: {
          id: "user_123",
          email: "developer@starter.local",
          displayName: "Local Developer",
          roles: ["projects:read", "projects:write"],
        },
      }),
    ).toEqual({
      user: {
        id: "user_123",
        email: "developer@starter.local",
        displayName: "Local Developer",
        roles: ["projects:read", "projects:write"],
      },
    });
  });

  it("allows missing optional profile fields and an empty role list", () => {
    expect(
      meResponseSchema.parse({ user: { id: "user_123", roles: [] } }),
    ).toEqual({ user: { id: "user_123", roles: [] } });
  });

  it("rejects provider claims and tokens from the public response", () => {
    expect(
      meResponseSchema.safeParse({
        user: { id: "user_123", roles: [], accessToken: "secret" },
      }).success,
    ).toBe(false);
  });
});
