import type { DatabaseSessionPolicy } from "@starter/database";

// API の pool の方針。値の根拠が配備構成（CloudFront、Secrets Manager、RDS の規模）にあるので、
// DB アダプタではなく composition 側に置く。
export const apiSessionPolicy: DatabaseSessionPolicy = {
  // タスク 1 つあたりの接続数。DB の接続数の予算は 5 × タスク数で見積もる。
  maxConnections: 5,
  // TCP の確立、TLS と認証、Secrets Manager からの password の取得、pool の空き待ちの
  // すべてを含む予算。未指定だと、応答しない DB や Secrets Manager の前で起動時の
  // select 1 もリクエストも OS の keepalive（約 2 時間）まで止まる。
  // タイマーが切れても裏の Secrets Manager の呼び出しは止まらないが、結果は捨てられる。
  connectionTimeoutMillis: 5_000,
  // 接続を張り直すたびに Secrets Manager を呼ぶので、低トラフィック時の再接続を減らす。
  // 1 タスク最大 5 本なので、残しておくコストは小さい。
  idleTimeoutMillis: 5 * 60_000,
  // CloudFront の origin read timeout の既定値 30 秒より十分短くし、利用者が 504 を
  // 受け取る前に DB 側で止めて接続を返す。長いクエリはトランザクション内の
  // SET LOCAL statement_timeout で個別に延ばす。
  statementTimeoutMillis: 15_000,
  // rollback し損ねたトランザクションが行ロックを持ったまま残るのを断つ。発火すると
  // サーバーが接続を切るので、createDatabaseResources が各接続に付ける error リスナーが前提。
  idleInTransactionSessionTimeoutMillis: 30_000,
};

// migrate / seed の CLI の方針。migration の上限は migration-runner が SET LOCAL で
// トランザクションごとに付けるので、セッションには付けない（API の 15 秒が DDL に効かないように）。
export const migrationSessionPolicy: DatabaseSessionPolicy = {
  maxConnections: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  statementTimeoutMillis: false,
  idleInTransactionSessionTimeoutMillis: false,
};
