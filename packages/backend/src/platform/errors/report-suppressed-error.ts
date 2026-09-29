/**
 * 応答には影響させずに記録だけ残す失敗。応答は成功させるが運用者には見せたい処理
 * （古いセッションの掃除など）が使う。500 の経路には乗らないので、要求の観測とは別の口にする。
 *
 * `operation` は "<領域>.<処理>" の固定文字列（例: "auth.session-cleanup"）。入力値や ID を
 * 混ぜると、記録が資格情報や個人に紐づく値の漏れ口になる。
 */
export type SuppressedErrorEvent = Readonly<{
  operation: string;
  error: unknown;
}>;

/** 実装は例外を投げてはならない。記録の失敗で本来の処理を落とさないため。 */
export type ReportSuppressedError = (event: SuppressedErrorEvent) => void;

export const ignoreSuppressedError: ReportSuppressedError = () => {};
