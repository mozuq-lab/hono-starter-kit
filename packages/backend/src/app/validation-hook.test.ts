import type { Problem } from "@starter/contracts";
import type { TypedResponse } from "hono";
import type { JSONParsed } from "hono/utils/types";
import { describe, expectTypeOf, it } from "vitest";
import { validationHook } from "./validation-hook.js";

describe("validationHook", () => {
  // hook の戻り値の型が、Route ごとの 400 応答の型の出どころになる（AppType に載る）。
  // status が number に広がったり本文の型が変わったりすると、api-client の 400 の型が崩れる。
  it("keeps the per-route 400 Problem response type", () => {
    expectTypeOf(validationHook).returns.toEqualTypeOf<
      (Response & TypedResponse<JSONParsed<Problem>, 400, "json">) | undefined
    >();
  });
});
