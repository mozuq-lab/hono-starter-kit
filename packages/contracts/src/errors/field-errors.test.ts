import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./field-errors.js";

describe("toFieldErrors", () => {
  it("keys messages by the top-level field name", () => {
    expect(
      toFieldErrors([{ path: ["name", "nested"], message: "too long" }]),
    ).toEqual({ name: ["too long"] });
  });

  it("stacks messages for the same field in issue order", () => {
    expect(
      toFieldErrors([
        { path: ["name"], message: "first" },
        { path: ["version"], message: "other" },
        { path: ["name"], message: "second" },
      ]),
    ).toEqual({ name: ["first", "second"], version: ["other"] });
  });

  it("drops issues whose path[0] is not a string", () => {
    expect(
      toFieldErrors([
        { path: [0], message: "array index" },
        { path: [], message: "root" },
        { path: [Symbol("s")], message: "symbol" },
      ]),
    ).toEqual({});
  });
});
