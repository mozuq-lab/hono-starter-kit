/**
 * HTTP 層が Problem へ写すドメインのエラー。
 *
 * HTTP status は持たせない。use case は HTTP を知らない設計なので、コードから status と
 * title への対応は HTTP 層（`app/problem.ts` の表）が持つ。`code` が contracts の
 * ProblemCode に含まれることは、ドメインを contracts に依存させないよう型テストで確かめる。
 * 含まれないコードは `onError` で 500 に落ち、そのコードはクライアントに出ない。
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  // declare にしておくと、持たないサブクラスのインスタンスに undefined の自前プロパティが
  // 生えない（exactOptionalPropertyTypes の「キーが無い」と実体を揃える）。
  declare readonly fieldErrors?: Record<string, string[]>;
}
