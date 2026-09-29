/**
 * ログと span に出してよい形に要約した例外。ログにも span にも、この要約だけを出す。
 */
export type ErrorSummary = Readonly<{
  errorName: string;
  /** message を許可した型のときだけ入る。 */
  errorMessage?: string;
  /** PostgreSQL のエラー（pg の DatabaseError）のときだけ入る。 */
  sqlState?: string;
  /** stack のうち、ヘッダ（`name: message`）を落とした後のフレーム行だけ。 */
  stackFrames: string[];
}>;

// バグの類の型だけ message を許す。それ以外（接続エラーの "connect ECONNREFUSED 10.x.x.x:5432"、
// pool の待ち時間切れ、IdP のエラー、pg の "invalid input syntax for type uuid: \"…\"" など）は
// 接続先や入力値を含むので型名だけを出す。SyntaxError も外す。V8 の JSON.parse は入力の先頭を
// message に引用する（`Unexpected token 'S', "SECRET_VAL"... is not valid JSON`）ため。
// 型を足すときは、その message が接続先や入力値を含まないことを確かめること。
const messageAllowedTypes = [TypeError, RangeError, ReferenceError] as const;

// 許可した型でも、Node の ERR_INVALID_ARG_* は受け取った値を "Received …" として含み、
// undici はヘッダや URL を含むことがある。原因の特定に要るのは先頭なので長さで切る。
const errorMessageMaxLength = 200;

const sqlStatePattern = /^[0-9A-Z]{5}$/;
const stackFramePattern = /^\s+at /;
// name は任意に書き換えられるので、識別子の形をしたものだけを型名として扱う。
// 改行や空白を含む name でログの 1 行を壊したり、値を運んだりさせない。
const errorNamePattern = /^[A-Za-z_$][\w$]{0,99}$/;

const attempt = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

// pg の DatabaseError は name に protocol のメッセージ名 "error" を入れるので、name では
// 判定できない。SQLSTATE の形の code と severity の両方を持つことで見分ける。
const readSqlState = (error: Error): string | undefined =>
  attempt(() => {
    const { code, severity } = error as { code?: unknown; severity?: unknown };
    return typeof code === "string" &&
      sqlStatePattern.test(code) &&
      typeof severity === "string"
      ? code
      : undefined;
  }, undefined);

const readErrorName = (error: Error): string =>
  attempt(() => {
    const { name } = error;
    return typeof name === "string" && errorNamePattern.test(name)
      ? name
      : "Error";
  }, "Error");

// V8 の stack は `name: message`（message が空なら name だけ）のヘッダの後にフレームを並べる。
// ヘッダの終わりは、上書きできる toString ではなく message そのものから求める。toString が
// 行数を少なく返すと、message に仕込んだ "    at …" の行がフレームとして残ってしまう。
// stack が今の message で始まっていない（生成後に message を書き換えた Error など）なら
// ヘッダの終わりが分からないので undefined を返し、フレームを捨てる。
const stackHeaderEnd = (stack: string, error: Error): number | undefined => {
  const message = String(error.message);
  if (message === "") {
    const { name } = error;
    const headerLineCount = (typeof name === "string" ? name : "Error").split(
      "\n",
    ).length;
    const lines = stack.split("\n");
    return lines.slice(0, headerLineCount).join("\n").length;
  }
  const marker = `: ${message}`;
  const index = stack.indexOf(marker);
  if (index === -1 || stack.slice(0, index).includes("\n")) return undefined;
  return index + marker.length;
};

// ヘッダを落とした残りのうち、/^\s+at / に一致する行だけを残す。取りこぼしは漏洩ではなく
// 情報の欠落なので、読めないときや形が合わないときはフレームを捨てる側に倒す。
const readStackFrames = (error: Error): string[] =>
  attempt(() => {
    const { stack } = error;
    if (typeof stack !== "string") return [];
    const headerEnd = stackHeaderEnd(stack, error);
    if (headerEnd === undefined) return [];
    return stack
      .slice(headerEnd)
      .split("\n")
      .filter((line) => stackFramePattern.test(line))
      .map((line) => line.trim());
  }, []);

/**
 * 例外を、ログと span に出してよい要約にする。
 *
 * `cause`、`AggregateError.errors`、その他の任意のプロパティは読まない。oauth4webapi の
 * エラーの cause には IdP の応答が入り、ドライバのエラーは接続先を抱えるため。
 */
export const summarizeError = (error: unknown): ErrorSummary => {
  if (!(error instanceof Error)) {
    return { errorName: typeof error, stackFrames: [] };
  }

  const stackFrames = readStackFrames(error);
  const sqlState = readSqlState(error);
  if (sqlState !== undefined) {
    return { errorName: "DatabaseError", sqlState, stackFrames };
  }

  const errorName = readErrorName(error);
  const errorMessage = messageAllowedTypes.some((type) => error instanceof type)
    ? attempt(
        () => String(error.message).slice(0, errorMessageMaxLength),
        undefined,
      )
    : undefined;
  return errorMessage === undefined
    ? { errorName, stackFrames }
    : { errorName, errorMessage, stackFrames };
};
