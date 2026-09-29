// 設定検証と実行時強制が同じ判定を使うよう、ここを唯一の定義とする。
// 引数は URL が正規化した hostname（IPv6 は角括弧付き、小文字）を前提にする。
export const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
