import {
  problemTypes,
  type Problem,
  type ProblemCode,
} from "@starter/contracts";
import type { Context } from "hono";
import type { AppEnv } from "./app-env.js";

// 表に置ける status を、いま使っているエラー応答に絞る。PublicAppType は AppType そのもので、
// 非 2xx の形は api-client が problemSchema で実行時に検証するため、status を足しても
// app-type.ts の更新は要らない。新しい status はここに足し、契約の code と一緒に表へ登録する。
type ProblemStatus = 400 | 401 | 403 | 404 | 409 | 413 | 500;

/**
 * 契約の全コードに status と title を与える唯一の表。
 * コードの足し忘れも、契約にないコードの登録も、satisfies でコンパイルエラーになる。
 */
export const problemCatalog = {
  INTERNAL_ERROR: { status: 500, title: "Internal Server Error" },
  UNAUTHENTICATED: { status: 401, title: "Unauthenticated" },
  ORIGIN_NOT_ALLOWED: { status: 403, title: "Origin not allowed" },
  VALIDATION_ERROR: { status: 400, title: "Validation Error" },
  NOT_FOUND: { status: 404, title: "Not Found" },
  PAYLOAD_TOO_LARGE: { status: 413, title: "Payload Too Large" },
  PROJECT_NOT_FOUND: { status: 404, title: "Project not found" },
  PROJECT_ARCHIVED: { status: 409, title: "Project is archived" },
  PROJECT_VERSION_CONFLICT: { status: 409, title: "Project version conflict" },
} as const satisfies Record<
  ProblemCode,
  { status: ProblemStatus; title: string }
>;

type ProblemOptions = {
  // undefined も受けるのは、onError がエラーの任意プロパティをそのまま渡せるようにするため。
  // キーを省くかどうかの判断は buildProblem の 1 か所に置く。
  fieldErrors?: Record<string, string[]> | undefined;
};

/**
 * Problem の本文を組み立てる。エラーの `message` や `cause` は受け取らないので、
 * 内部情報が本文に混ざる経路はない。キーの順序は wire のバイト列なので変えないこと。
 */
export const buildProblem = (
  context: Context<AppEnv>,
  code: ProblemCode,
  { fieldErrors }: ProblemOptions = {},
): Problem => ({
  type: problemTypes[code],
  title: problemCatalog[code].title,
  status: problemCatalog[code].status,
  code,
  requestId: context.get("requestId"),
  instance: context.req.path,
  ...(fieldErrors === undefined ? {} : { fieldErrors }),
});

type CatalogStatus<C extends ProblemCode> =
  (typeof problemCatalog)[C]["status"];

/**
 * Problem の応答を返す。status の型はコードから決まるので、リテラルのコードを渡せば
 * status もリテラルになり、validation hook の戻り値が Route ごとの 400 の型として残る。
 */
export const problemResponse = <C extends ProblemCode>(
  context: Context<AppEnv>,
  code: C,
  options?: ProblemOptions,
) =>
  context.json(
    buildProblem(context, code, options),
    // 総称型の C で表を引くと TS は status を全コードの union に広げるので、
    // C に対応する status として明示する。外すと hook の 400 が 400 | 401 | ... になる。
    problemCatalog[code].status as CatalogStatus<C>,
    { "Content-Type": "application/problem+json" },
  );
