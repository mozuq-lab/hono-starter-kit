import { zValidator } from "@hono/zod-validator";
import { toFieldErrors } from "@starter/contracts";
import type { Context, ValidationTargets } from "hono";
import type { ZodType } from "zod";
import type { AppEnv } from "./app-env.js";
import { problemResponse } from "./problem.js";

// zod のバージョンや検証対象に縛られないよう、issue は構造だけで受ける。
// これにより hook を json と param の両方へ、スキーマごとの型引数なしで渡せる。
type ValidationIssue = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

type ValidationResult =
  | { success: true }
  | { success: false; error: { issues: readonly ValidationIssue[] } };

/**
 * zValidator の失敗を公開契約の Problem へ変換する唯一の場所。
 *
 * issue の畳み方（`path[0]` が文字列のものだけを最上位のフィールド名で公開する）は
 * 画面のエラー表示先を決める wire の形なので、contracts の `toFieldErrors` に任せる。
 */
export const validationHook = (
  result: ValidationResult,
  context: Context<AppEnv>,
) => {
  if (result.success) return;

  const fieldErrors = toFieldErrors(result.error.issues);

  return problemResponse(context, "VALIDATION_ERROR", { fieldErrors });
};

/**
 * `validationHook` を付けた zValidator を返す。
 *
 * zValidator は Env を hook の引数からは推論できず `Env` に落とすため、`AppEnv` を
 * 明示的に渡している。これを省くと hook の `context.get("requestId")` が型として
 * 成立しない。
 */
export const validate = <
  Target extends keyof ValidationTargets,
  T extends ZodType,
>(
  target: Target,
  schema: T,
) =>
  zValidator<T, Target, AppEnv, string, typeof validationHook>(
    target,
    schema,
    validationHook,
  );
