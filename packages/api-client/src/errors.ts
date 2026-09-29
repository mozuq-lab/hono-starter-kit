import type { Problem } from "@starter/contracts";

/**
 * サーバが契約どおりの Problem を返したときの例外。つまり「想定内の失敗」を表す。
 *
 * `message` は `problem.title` なのでそのままユーザに見せる文面には向かない。
 * 分岐には {@link code} を使い、`isKnownProblemCode` で絞り込んでから扱うこと。
 */
export class ApiError extends Error {
  readonly name = "ApiError";

  constructor(readonly problem: Problem) {
    super(problem.title);
  }

  /** HTTP ステータス。 */
  get status() {
    return this.problem.status;
  }

  /** 分岐に使うエラーコード。既知かどうかは `isKnownProblemCode` で判定する。 */
  get code() {
    return this.problem.code;
  }

  /** サーバ側のログと突き合わせるための ID。問い合わせにはこれを添える。 */
  get requestId() {
    return this.problem.requestId;
  }
}

/**
 * 応答が契約に一致しなかったときの例外。Problem として解釈できないエラー本文、
 * スキーマに合わない成功応答、想定外の成功ステータスがこれになる。
 *
 * {@link ApiError} と違い、サーバの不具合か配信経路の異常を示す。
 * コードで回復させず、そのまま失敗として扱うこと。
 */
export class UnexpectedApiResponseError extends Error {
  readonly name = "UnexpectedApiResponseError";

  constructor(readonly status: number) {
    super(`API response did not match its contract (status ${status})`);
  }
}
