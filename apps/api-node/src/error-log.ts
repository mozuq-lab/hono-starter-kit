import { isSpanContextValid, trace } from "@opentelemetry/api";
import type { ReportSuppressedError } from "@starter/backend";
import { summarizeError } from "./error-summary.js";

/** 構造化ログの 1 行（JSON）を書き出す。改行は書き出す側が付ける。 */
export type WriteLogLine = (line: string) => void;

// ECS は awslogs で stdout を CloudWatch へ送る。エラーログもアクセスログもここに出す。
export const writeStdoutLine: WriteLogLine = (line) => {
  process.stdout.write(`${line}\n`);
};

/** active span があるときだけ trace ID を返す。trace を無効にしていれば undefined。 */
export const activeTraceId = (): string | undefined => {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext !== undefined && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : undefined;
};

/**
 * 握りつぶした例外を warn の 1 行として書き出す。要約は {@link summarizeError} を通すので、
 * 500 のエラーログと同じ許可リスト（message は型で許可、stack はフレーム行だけ）が効く。
 *
 * requestId は入れない。use case は要求の文脈を知らず、port に ID を通すと backend の
 * use case に HTTP の概念が入るため。trace を有効にしていれば traceId から SERVER span の
 * request.id にたどれる。span には何も付けない。応答は成功しているので、例外付きに見えると
 * 紛らわしい。
 */
export const createSuppressedErrorReporter =
  ({ write }: { write: WriteLogLine }): ReportSuppressedError =>
  ({ operation, error }) => {
    try {
      const traceId = activeTraceId();
      write(
        JSON.stringify({
          level: "warn",
          message: "suppressed error",
          operation,
          ...(traceId === undefined ? {} : { traceId }),
          ...summarizeError(error),
        }),
      );
    } catch {
      // 記録の失敗で本来の処理（応答を成功させること）を落とさない。
    }
  };

/**
 * サーバーやネットワークに切られた DB 接続を warn の 1 行として書き出す。SQLSTATE
 * （25P03 の idle_in_transaction_session_timeout、57P01 の pg_terminate_backend や
 * 再起動など）で原因を見分けられるようにし、接続先を含むドライバの message は
 * {@link summarizeError} の規則で落とす。pool は切れた接続を捨てて張り直すので warn にする。
 * 切断で失敗したクエリは、500 として別に記録される。
 */
export const createDatabaseClientErrorReporter =
  ({ write }: { write: WriteLogLine }) =>
  (error: unknown): void => {
    try {
      write(
        JSON.stringify({
          level: "warn",
          message: "database connection closed",
          ...summarizeError(error),
        }),
      );
    } catch {
      // pg の error イベントの中で投げると uncaughtException になり、プロセスが落ちる。
    }
  };
