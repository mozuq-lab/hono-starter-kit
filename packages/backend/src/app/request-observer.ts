import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppEnv } from "./app-env.js";

/**
 * 1 件の要求の結果。記録やトレースへの反映は外側のアダプタが行う。
 *
 * 生のパス、クエリ、ヘッダは載せない。資格情報や ID が入りうるため、載せるのは
 * route のパターンだけにしている。
 */
export type RequestOutcome = Readonly<{
  requestId: string;
  method: string;
  /** 例: "/api/projects/:projectId"。ハンドラに一致しなかった要求（未知のパス、メソッド違い）は "" */
  route: string;
  status: number;
  durationMs: number;
  /**
   * 想定外の失敗（500）に落ちた値。キーがあるときだけ想定外として扱う。
   * `throw undefined` のような値も記録できるよう、値の有無ではなくキーの有無で判定する。
   */
  unexpectedError?: unknown;
}>;

export type ObserveRequest = (outcome: RequestOutcome) => void;

export const ignoreRequestOutcome: ObserveRequest = () => {};

// app.use の登録は method が "ALL" になる。routePath() は最後に dispatch した middleware の
// pattern（/api/* や *）を返すので使えない。matchedRoutes は dispatch の進み具合に関係なく
// router が一致させた要素をすべて返すため、middleware の中で失敗しても本来のハンドラの
// route が取れる。app.all() のハンドラも除外される点に注意（今のコードにはない）。
const handlerRoute = (context: Context<AppEnv>): string =>
  matchedRoutes(context).findLast((route) => route.method !== "ALL")?.path ??
  "";

export const createRequestObserverMiddleware = (
  observeRequest: ObserveRequest,
): MiddlewareHandler<AppEnv> => {
  return async (context, next) => {
    const startedAt = performance.now();
    const notify = (
      outcome: Pick<RequestOutcome, "status" | "unexpectedError">,
    ) => {
      try {
        observeRequest({
          requestId: context.get("requestId"),
          method: context.req.method,
          route: handlerRoute(context),
          durationMs: performance.now() - startedAt,
          ...outcome,
        });
      } catch {
        // 記録の失敗で応答を壊さない。記録できなかったことを理由に 500 を返すのは本末転倒。
      }
    };

    try {
      await next();
    } catch (thrown) {
      // Error でない値は compose が onError に渡さず再送出する。context.error も
      // context.res も 500 にならないので、最終的にサーバが返す 500 としてここで通知する。
      notify({ status: 500, unexpectedError: thrown });
      throw thrown;
    }

    const { status } = context.res;
    // onError が扱った例外は context.error に残る。404 や 409 のようなドメインの失敗も
    // ここに入るので、想定外として渡すのは 500 系に落ちたものだけにする。
    notify(
      status >= 500 && context.error !== undefined
        ? { status, unexpectedError: context.error }
        : { status },
    );
  };
};
