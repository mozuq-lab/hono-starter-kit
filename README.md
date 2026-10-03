# Hono Starter Kit

Hono の API と React Router の SPA を PostgreSQL で動かし、AWS（ECS Fargate、CloudFront、RDS、
Cognito）へ載せるための DDD-lite なスターターです。ローカルでは Docker Compose だけで全体が
動きます。

## 構成

React 19、React Router 8（SPA）、TanStack Query、Tailwind CSS 4、Hono、Hono RPC、Zod、Kysely、
PostgreSQL、OpenTelemetry、Terraform を使う pnpm workspace です。

| パス                  | 役割                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `apps/web`            | React Router の SPA。API は `packages/api-client` 経由で呼ぶ     |
| `apps/api-node`       | Node.js のサーバーと組み立て、OIDC と OpenTelemetry のアダプター |
| `packages/contracts`  | ブラウザーへ配布できる公開契約（Zod schema、エラーコード）       |
| `packages/api-client` | Web が使う Hono RPC クライアント                                 |
| `packages/backend`    | Hono のアプリとルート、ユースケース、ポート                      |
| `packages/database`   | Kysely によるポートの実装と SQL マイグレーション                 |
| `infra/terraform`     | AWS の構成                                                       |

依存の向きと、それぞれを選んだ理由は `docs/design.md` にあります。

## クイックスタート

必要なもの: Node.js 24 以降、Docker（Engine または Desktop、Compose と Buildx を含む）。

pnpm がホストに入っていなければ一度だけ入れます。バージョンは問わず、このリポジトリの中では
pnpm が宣言済みの 11.15.1 へ自分を切り替えます。

```sh
npm install --global pnpm
```

依存を入れ、DB を用意して起動します。

```sh
pnpm install --frozen-lockfile
pnpm db:setup
pnpm dev
```

<http://127.0.0.1:5173/projects> を開き、**Sign in** から開発専用の Dev Login でサインインします。
止めるときは `pnpm dev:down` です。DB のデータは残ります。2 回目からは `pnpm dev` だけで
起動できます。

このリポジトリの中で `npm install` などを実行すると `EBADDEVENGINES` で拒否されます。意図した
動作です（理由は `docs/design.md` の「19. v0.1の実装範囲」）。

## よく使うコマンド

| コマンド            | 用途                                                   |
| ------------------- | ------------------------------------------------------ |
| `pnpm dev`          | 開発スタック（PostgreSQL、API、Web、Jaeger）を起動する |
| `pnpm dev:down`     | 開発スタックを止める（DB のデータは残る）              |
| `pnpm db:migrate`   | マイグレーションを適用する。API の起動は適用しない     |
| `pnpm db:seed`      | 初期データの投入だけをやり直す                         |
| `pnpm check`        | 整形、型、lint、単体テスト、ビルド                     |
| `pnpm test:db`      | DB 統合テスト（使い捨ての PostgreSQL で動く）          |
| `pnpm test:e2e`     | 画面の E2E                                             |
| `pnpm check:docker` | Docker での受け入れ検証一式                            |
| `pnpm terraform`    | Docker 上の Terraform（`docs/aws.md`）                 |

トレースは Jaeger UI（<http://127.0.0.1:16686>）の `hono-starter-api` で見られます。

## サンプル: Projects

- `/projects` は稼働中とアーカイブ済みの Project を一覧します。
- `/projects/new` は稼働中の Project を作成します。
- `/projects/:projectId` は詳細を表示し、バージョン安全なリネームに対応し、確認のうえで
  稼働中の Project をアーカイブします。
- このサンプルではアーカイブは取り消せません。アーカイブ済みの Project は読み取り専用の
  ままです。

古いバージョンでの更新は `409` を返し、UI はサーバーが確定した状態へ更新します。各ユーザーは
自分が作成した Project だけを読み書きできます。

## 検証済みの範囲

ローカルで検証済みのもの:

- Compose の開発スタックと本番用 API イメージ（`pnpm check:docker`）
- パブリッククライアントとしての OIDC ログイン（ローカルの HTTPS フィクスチャーに対して）
- 本番設定で `AUTH_PROVIDER=dev` を指定すると API が起動しないこと
- Terraform の provider mock test と、module 間の依存配線

まだ検証していないもの:

- 実 AWS での環境の作成・更新・削除と、`release:api` / `release:web` の実行
- デプロイした環境とプロバイダーに対するスモークテスト
- 実際の IdP（Entra ID、Cognito など）に対するコンフィデンシャルクライアントとしての動作
- 本番の送信先（ADOT 経由の X-Ray）で、500 の `exception` イベントが例外として表示されるか

## ドキュメント

| 文書                    | 内容                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `docs/development.md`   | 開発スタック、DB の操作と作り直し、マイグレーションの書き方、検証   |
| `docs/configuration.md` | 環境変数（API、データベース、認証、テレメトリー）                   |
| `docs/aws.md`           | Terraform、AWS 環境の作成・公開・削除、デプロイ時の失敗とログの見方 |
| `docs/forking.md`       | fork で変える場所、スターターの変更の取り込み方                     |
| `docs/design.md`        | 設計と、それを選んだ理由                                            |
| `docs/roadmap.md`       | 計画中で、まだ実装していないもの                                    |
