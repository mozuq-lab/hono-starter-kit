# ロードマップ

この文書は、計画中で、まだコードにないものを書きます。コードにある設計とその判断の理由は `docs/design.md` に書きます。項目を実装した変更で、その記述を `docs/design.md` へ移し、ここから消します。

各項目は「何を、なぜ、どの版で」だけを書きます。設計の詳細は、実装するときに決めます。版が決まっていないものは「未定」とします。

## GitHub ActionsからAWS OIDCでデプロイする

- 何を: mainへのマージ後に、GitHub ActionsがAWS OIDCでbootstrapのdeploy roleを引き受け、API ImageとReact artifactをデプロイする。
- なぜ: 操作者の手元の認証情報に頼らず、同じ手順で繰り返しデプロイできるようにするため。
- どの版で: 未定。v0.1bの完了条件からは外した。
- 前提:
  - main に限定し、承認者を必須にした GitHub environment を用意する。
  - bootstrap の `create_github_plan_role` と `create_github_deploy_role` を `true` にする。どちらも既定は `false` で、既定では role を作らない。
  - plan role を使う workflow は `pull_request_target` と `workflow_run` を使わない。
  - React の成果物は CI で一度だけ build し、同じ artifact を dev、stg、prod へ昇格する（stg と prod は「インフラと運用」）。今は `pnpm release:web` が手元で HEAD から build して dev に置く。

## Projects Standard Extension

- 何を: Projects Core Sampleを、業務システムで必要になる次の要素まで広げる。
  - Tenant境界（Multi-tenancy）
  - Organizations、RBAC。ロールの検査は`project.policy.ts`に置き、拒否は新しい公開エラーコード`FORBIDDEN`（403）で返す。所有者による絞り込み（repositoryのクエリ）はそのまま残す
  - 監査ログ
  - Transactional Outbox、SQSイベント、Worker処理
- テスト: Policy の unit test、Tenant 境界の DB 統合テスト、権限不足と Worker 処理結果の E2E を足す。
- なぜ: 新しい機能を足すときの参照実装を、認可・監査・非同期処理まで含めて示すため。Core Sampleと分け、未実装の機能をGolden Pathの必須要件に見せない。
- どの版で: v0.2

## Projects 一覧のページング

- 何を: `GET /api/projects?cursor=&limit=` と `{ items, nextCursor? }` の keyset ページング。カーソルは `(created_at, id)` を符号化した不透明な文字列にし、Web は `useInfiniteQuery` で読む。一覧が全件を返すという契約の意味が変わるので、破壊的変更として扱う。
- なぜ: Project が増えると、全件を返す一覧は応答と描画が重くなるため。index `(owner_user_id, created_at desc, id desc)` は既にあり、追加は要らない。
- どの版で: 未定。Projects CRUD の範囲ではページングを意図的に外している。

## 画面の追加の状態

- 何を: 今ある状態（Loading、Empty、Error、Not Found、Form submitting、Optimistic update failure、Session expired、Sign-in failure）に、次の状態を足す。
  - Forbidden（RBAC の `FORBIDDEN` を受けたとき）
  - Maintenance
  - Network offline
  - Partial data failure
- なぜ: 単なる CRUD 画面だけでなく、実際の運用で必要になる失敗状態もサンプルに含めるため。
- どの版で: Forbidden は RBAC と同じ v0.2（「Projects Standard Extension」）。ほかは未定。

## ランタイム設定

- 何を: 環境ごとに変わる公開設定を、SPA が実行時に `GET /api/runtime-config` で取得する。秘密情報は含めない。
- なぜ: API URL などを `VITE_*` で成果物に埋め込まず、同じ成果物を環境をまたいで使うため。今は同一オリジンの相対 URL（`/api`）だけで足りており、環境ごとの公開設定はない。
- どの版で: 未定

## 非同期処理とバッチ

- 何を: API、Worker（ECS Service + SQS）、Batch（EventBridge Scheduler + ECS RunTask）が、同じApplication層とDomain層を使う。
- なぜ: 業務ロジックをWorkerやBatchに再実装しないため。定期処理は常駐APIのCronに置かず、EventBridge SchedulerからECS RunTaskを起動する。
- どの版で: v0.2
- 前提として決めていること:
  - HTTP Request、SQS Event、Batch Commandは開始条件とActorが違うので、入口ごとにUse CaseまたはHandlerを用意する。人間の`Actor`とシステム実行の`SystemActor`を区別し、Workerだから認可を省く、という暗黙の規則は作らない。
  - SQSメッセージは`eventId`、`eventType`、`occurredAt`、`tenantId`、`aggregateId`、`schemaVersion`、`payload`を持つ。
  - DB更新の結果として必ず発行するEventは、Transactional Outboxで送る。送信と処理はat-least-onceなので、送信側と受信側の両方で`eventId`により冪等にする。喪失を許すbest-effortのEventだけは直接送ってよいが、契約と監視にそう明記する。
  - 冪等性、リトライ、DLQ、メッセージのversion、処理時間の上限、失敗ログ、Trace Contextの伝播を扱う。

## Single Container Profile

- 何を: Reactのビルド結果をHonoから配信し、`/api/*`・`/auth/*`とWebを1つのコンテナで動かす。`/api/*`と`/auth/*`に一致しない拡張子なしのPathは`index.html`へfallbackし、存在しないassetは404にする。Security HeaderとCache-Controlは、AWS Split Profileと同じ契約をHono側で実装する。
- なぜ: 小規模なプロダクトでは、1コンテナで済み、WebとAPIを同時にロールバックでき、CloudFrontとS3の設定が要らないため。標準の本番構成は、引き続きAWS Split Profileとする。
- どの版で: 未定

## Node.js以外のランタイム

- 何を: Cloudflare WorkersやAWS Lambdaを、追加のプロファイルとして用意する。
- なぜ: HonoのRouteはWeb Standards上で共通化できるが、PostgreSQL Driver、Queue、Object Storage、Secret、Telemetry Exporter、AsyncLocalStorage、コネクションプールなどはランタイムごとに違う。これらをAdapterとして分けてから対応する。最初から全ランタイムを目指すと、最小公倍数の設計に引っ張られるので、Node.jsを標準のランタイムにしている。
- どの版で: 未定

## 未実装のCore

`docs/design.md`「17. Coreと追加モジュール」の表に載せていない、Coreとして予定しているもの。

| 項目     | 内容                                                            | 版   |
| -------- | --------------------------------------------------------------- | ---- |
| Logging  | JSONの構造化ログ（アクセスログ）。`traceId`でTraceと関連付ける  | 未定 |
| Health   | readinessと`/version`。現在あるのはliveness相当の`/healthz`だけ | 未定 |
| Config   | 環境変数の検証をZodのschemaでまとめる。現在は手書きの検証       | 未定 |
| Docs     | Architecture、ADR、Runbook                                      | 未定 |
| フォーム | React Hook Form。現在のフォームはライブラリを使っていない       | 未定 |

## 追加モジュール

必要に応じて有効にするもの。版はいずれも未定です。

### Standard Module

| モジュール    | 内容                     |
| ------------- | ------------------------ |
| Organizations | 組織、所属               |
| RBAC          | ロール・権限             |
| Audit         | 監査ログ                 |
| Jobs          | SQS、Worker、DLQ、Outbox |
| Email         | SES、テンプレート        |
| Files         | S3、署名付きURL          |
| Batch         | EventBridge Scheduler    |
| Feature Flags | 段階公開                 |
| Multi-tenancy | Tenant境界               |

### Optional Module

- Stripe等の課金
- Public API、OpenAPI
- Webhook
- API Key
- Redis
- OpenSearch
- AI/LLM
- Analytics/GTM
- Realtime/WebSocket

## インフラと運用

- 何を:
  - Route 53による独自ドメインと、CloudFrontのWAF
  - dev以外の環境（stg、prod）
  - 運用のダッシュボード、アラート、Runbook
- なぜ: 現在のTerraformはdev環境だけを作り、CloudFrontの既定の証明書とドメインを使っている。本番運用にはこれらが要る。
- どの版で: 未定
