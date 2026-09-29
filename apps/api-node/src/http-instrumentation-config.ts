import type { HttpInstrumentationConfig } from "@opentelemetry/instrumentation-http";

const urlQueryAttribute = "url.query";
const redactedValue = "REDACTED";

// redactedQueryParams は既定値を置き換えるため、ライブラリ既定の4件も含める。
const redactedQueryParams = [
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Goog-Signature",
  "access_token",
  "client_secret",
  "code",
  "code_verifier",
  "id_token",
  "refresh_token",
  "session_state",
  "state",
  "token",
];

export const redactQueryString = (query: string): string =>
  query
    .split("&")
    .map((parameter) => {
      const separator = parameter.indexOf("=");
      if (separator === -1) return parameter;
      return `${parameter.slice(0, separator)}=${redactedValue}`;
    })
    .join("&");

const queryOf = (requestUrl: string | undefined): string | undefined => {
  const start = (requestUrl ?? "").indexOf("?");
  if (start === -1) return undefined;
  const query = (requestUrl ?? "").slice(start + 1).split("#")[0] ?? "";
  return query === "" ? undefined : query;
};

// instrumentation-http は受信スパンの url.query を無条件で属性化し、redactedQueryParams は
// 送信スパンの url.full にしか効かない。startIncomingSpanHook の戻り値はスパン生成前に
// 計算済み属性へ上書き適用されるため、ここで受信クエリの値を伏せる。
export const createHttpInstrumentationConfig =
  (): HttpInstrumentationConfig => ({
    redactedQueryParams: [...redactedQueryParams],
    startIncomingSpanHook: (request) => {
      const query = queryOf(request.url);
      if (query === undefined) return {};
      return { [urlQueryAttribute]: redactQueryString(query) };
    },
  });
