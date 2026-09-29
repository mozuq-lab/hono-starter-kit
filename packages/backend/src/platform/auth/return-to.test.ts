import { describe, expect, it } from "vitest";
import { resolveReturnTo } from "./return-to.js";

describe("resolveReturnTo", () => {
  it.each([
    [undefined, "/projects"],
    [
      "/projects/project_alpha?tab=details",
      "/projects/project_alpha?tab=details",
    ],
    ["https://evil.test/projects", "/projects"],
    ["//evil.test/projects", "/projects"],
    ["projects", "/projects"],
    ["\\evil.example/steal", "/projects"],
    ["/projects\u0000admin", "/projects"],
    ["/projects\u007fadmin", "/projects"],
    ["/\\evil", "/projects"],
    ["/projects\nSet-Cookie:x", "/projects"],
    ["/auth/login", "/projects"],
    ["/auth/callback?code=x", "/projects"],
    ["/auth?continue=/projects", "/projects"],
    ["/projects/../auth/login?returnTo=%2Fprojects", "/projects"],
    ["/%61uth/login", "/projects"],
    ["/projects/%ZZ?tab=details", "/projects"],
    ["/projects/%0Aadmin", "/projects"],
    ["/projects/%5Cadmin", "/projects"],
    ["/.//evil.example/steal", "/projects"],
    ["/projects/..//evil.example/steal", "/projects"],
    ["/%2e//evil.example/steal", "/projects"],
    [
      "/projects/section/../project_alpha?next=%2Fprojects&tab=details",
      "/projects/project_alpha?next=%2Fprojects&tab=details",
    ],
  ])("maps %s to %s", (input, expected) => {
    expect(resolveReturnTo(input)).toBe(expected);
  });
});
