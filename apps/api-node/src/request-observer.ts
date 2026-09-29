import { context, trace } from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";
import type { ObserveRequest } from "@starter/backend";
import { activeTraceId, type WriteLogLine } from "./error-log.js";
import { summarizeError } from "./error-summary.js";

/**
 * 要求の結果を trace とログへ反映する。
 *
 * - route があれば HttpInstrumentation の RPC metadata に入れる。応答の完了時に計装が
 *   `http.route` を付け、SERVER span の名前を "<method> <route>" に変える。
 * - 想定外の失敗は、active span の `exception` イベントと、error の JSON 1 行にする。
 *
 * 生のパス、クエリ、ヘッダは出さない。資格情報や ID が入りうるため、出すのは route の
 * パターンだけにする。
 */
export const createRequestObserver =
  ({ write }: { write: WriteLogLine }): ObserveRequest =>
  (outcome) => {
    // route が "" のとき（未知のパス、メソッド違い）は設定せず、span 名をメソッドだけに残す。
    if (outcome.route !== "") {
      const rpcMetadata = getRPCMetadata(context.active());
      if (rpcMetadata?.type === RPCType.HTTP) rpcMetadata.route = outcome.route;
    }

    if (!("unexpectedError" in outcome)) return;

    const summary = summarizeError(outcome.unexpectedError);
    // recordException は message と stack を無条件に載せるので使わない。status の説明文も
    // 使わない。HttpInstrumentation が応答の完了時に setStatus({ code }) で上書きするため。
    // 属性ではなく exception という名前のイベントにするのは OTel の意味規約に沿う形で、
    // X-Ray が例外として扱う見込みが最も高いため（X-Ray での見え方は未検証）。
    trace.getActiveSpan()?.addEvent("exception", {
      "exception.type": summary.errorName,
      ...(summary.errorMessage === undefined
        ? {}
        : { "exception.message": summary.errorMessage }),
      "exception.stacktrace": summary.stackFrames.join("\n"),
    });

    const traceId = activeTraceId();
    write(
      JSON.stringify({
        level: "error",
        message: "unexpected error",
        requestId: outcome.requestId,
        ...(traceId === undefined ? {} : { traceId }),
        method: outcome.method,
        route: outcome.route,
        status: outcome.status,
        ...summary,
      }),
    );
  };
