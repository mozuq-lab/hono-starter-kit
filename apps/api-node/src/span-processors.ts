import { tracing } from "@opentelemetry/sdk-node";

const pgInstrumentationScope = "@opentelemetry/instrumentation-pg";

// PgInstrumentation は失敗したクエリや接続の span の status に、ドライバの err.message を
// そのまま入れる。接続エラーは接続先（host:port）を、型変換のエラーは利用者の入力値を含む。
// 例外イベントはライブラリが型名と SQLSTATE だけに伏せており、error.type 属性にもコードが
// 載るので、status からは message だけを落とす。終了後の span は書き換えられないので、
// 開始時に setStatus を包む。
const pgStatusRedactor: tracing.SpanProcessor = {
  onStart(span) {
    if (span.instrumentationScope.name !== pgInstrumentationScope) return;
    const setStatus = span.setStatus.bind(span);
    span.setStatus = (status) => setStatus({ code: status.code });
  },
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/** 送信前に機密を落とす処理を、exporter へ渡す BatchSpanProcessor より前に並べる。 */
export const createSpanProcessors = (
  exporter: tracing.SpanExporter,
): tracing.SpanProcessor[] => [
  pgStatusRedactor,
  new tracing.BatchSpanProcessor(exporter),
];
