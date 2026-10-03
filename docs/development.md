# ローカル開発

README のクイックスタートで `pnpm dev` が動いたあとに読む文書です。日々の作業で引く順に、
開発スタック、DB、マイグレーションの書き方、検証の順に並べています。

## 開発スタック

`pnpm dev` は Docker Compose で PostgreSQL、API、Web、Jaeger を起動します。`pnpm dev:down` は
スタックを止めますが、PostgreSQL の named volume とデータは残します。

| 公開先     | 既定のポート | 変える環境変数   |
| ---------- | ------------ | ---------------- |
| Web        | 5173         | `WEB_PORT`       |
| API        | 3000         | `API_PORT`       |
| PostgreSQL | 5432         | `POSTGRES_PORT`  |
| Jaeger UI  | 16686        | `JAEGER_UI_PORT` |

すべてループバックインターフェースにだけ公開されます。

### トレースを見る

開発用 Compose は HTTP と PostgreSQL のトレースを自動的に Jaeger へ送ります。
http://127.0.0.1:16686 を開き、サービス `hono-starter-api` を選びます。SERVER span の名前は
`POST /api/projects` のようにルート単位です。OTLP HTTP のポート 4318 は Compose ネットワークの
内側でしか使えず、ホストには公開されません。

## DB の操作

マイグレーションは明示的に実行します。API の起動は適用状態を確かめるだけで、マイグレーションを
実行することはありません。

| コマンド          | 用途                                             |
| ----------------- | ------------------------------------------------ |
| `pnpm db:setup`   | マイグレーションと初期データの投入をまとめて行う |
| `pnpm db:migrate` | 未適用のマイグレーションを適用する               |
| `pnpm db:seed`    | 初期データの投入だけをやり直す                   |

`pnpm db:seed` が作る Project の Alpha は、Dev Login の利用者が所有します。seed より先に
Dev Login でログインしていても、そのとき作られた利用者が所有者になります。seed は開発用です。

### 開発用 DB を作り直す

適用できないマイグレーションに当たったときや、Dev identity を変えたときは、PostgreSQL の
volume だけを消して作り直します。たとえば Project に所有者と作成日時を足した
`0005_add_project_owner_and_created_at.sql` は、`projects` に行がある DB には適用できません。
それより前に作った開発 DB はこの手順で作り直してください。

リポジトリのルートで、`COMPOSE_PROJECT_NAME` を設定せずに実行する前提です。

```sh
pnpm dev:down
docker volume rm hono-starter-kit_postgres_data
pnpm db:setup
```

volume の名前は Compose の project 名（既定ではリポジトリのディレクトリ名）と
`compose.yaml` の `postgres_data` をつないだものです。ディレクトリ名が違う場合は
`docker compose config` の先頭の `name:` で project 名を確かめてください。

`docker compose down -v` は使わないでください。PostgreSQL だけでなく、依存パッケージの
volume（`*_node_modules` と `pnpm_store`）も消えます。

## マイグレーションを書く

`packages/database/migrations/` に番号付きの SQL を足します。適用済みのマイグレーションは
書き換えません。

AWS では、マイグレーションはデプロイ中の旧タスクが動いている横で走ります。runner の上限は
1 本のマイグレーションが 10 分以内に終わる前提で決めているので（`docs/design.md` の
「B. AWS Split Profile」）、次のことに従ってください。

- `statement_timeout` と `lock_timeout` に触れず、`RESET ALL` も使わないでください。runner は、
  これらを含むファイルがあると、何も実行せずに止まります。
- `BEGIN`、`COMMIT`、`ROLLBACK` などでトランザクションを自分で制御しないでください。runner が
  1 本ずつトランザクションで包むので、これらの文を含むファイルも実行前に拒否します
  （PL/pgSQL の本体の `BEGIN … END` は対象外です）。
- 長く走りうる文（大きな表の書き換えや index の作成）を、1 本のマイグレーションに複数入れない
  でください。これは機械的には検出しません。
- 5 分を超える処理は通常のデプロイから分け、別の手順で流してください。

## 長いクエリ

API の `statement_timeout` は 15 秒で、超えた文は SQLSTATE `57014` で失敗します。15 秒より
長くかかる正当なクエリ（集計やエクスポート）は、トランザクションの中で
`SET LOCAL statement_timeout` を使えば、そのトランザクションだけ延ばせます。

```ts
await db.transaction().execute(async (trx) => {
  await sql`set local statement_timeout = '60s'`.execute(trx);
  return trx.selectFrom("projects").selectAll().execute();
});
```

`SET LOCAL` の効果はトランザクションの終わりで消え、pool に戻る接続には残りません。
トランザクションの外で `SET statement_timeout` を使うと、その接続を次に借りた別のリクエストにも
効いてしまうので使わないでください。migrate と seed の CLI の接続には `statement_timeout` を
付けません。ほかの上限値とその理由は `docs/design.md` の「7. DBアクセス」にあります。

## 検証

| コマンド               | 確かめること                                                       | Docker |
| ---------------------- | ------------------------------------------------------------------ | ------ |
| `pnpm check`           | 整形、型、lint、単体テスト、ビルド                                 | 不要   |
| `pnpm test:e2e`        | Playwright による画面の E2E                                        | 不要   |
| `pnpm test:csp`        | 本番ビルドが本番と同じ CSP の下で起動すること                      | 不要   |
| `pnpm test:db`         | DB 統合テスト（使い捨ての PostgreSQL）                             | 必要   |
| `pnpm terraform:check` | Terraform の整形・構文・mock test・module 間の依存                 | 必要   |
| `pnpm check:docker`    | PostgreSQL、API、Web、OIDC、トレース、本番 API イメージ、Terraform | 必要   |

`test:e2e` と `test:csp` を初めて走らせる前に、`pnpm exec playwright install chromium` で
ブラウザーを入れてください。狭いチェックから広いチェックへ進めます。repository やマイグレーションの SQL を変えたら、まず
`pnpm test:db` を回します。

### `pnpm check` の内訳

次の4つをこの順に実行します。個別に走らせることもできます。`pnpm lint` は先に
`pnpm typecheck`（各パッケージと `scripts/` の型検査）を実行してから ESLint を走らせます。

```sh
pnpm format:check
pnpm lint
pnpm test
pnpm build
```

edge function・IAM policy・module 間の配線を Terraform を起動せずに読む node のテストは
`pnpm test` に含まれます。

### OIDC だけを確かめる

ローカルフィクスチャーだけでプロバイダー非依存 OIDC を絞り込んで確認するには、次を使います。

```sh
pnpm exec vitest run apps/api-node/src/auth-config.test.ts apps/api-node/src/session-crypto.test.ts apps/api-node/src/oidc-identity-provider.test.ts packages/backend/src/platform/auth/external-login-cookie.test.ts packages/backend/src/platform/auth/external-login.routes.test.ts apps/api-node/src/composition-root.test.ts apps/api-node/src/runtime-composition.test.ts apps/web/app/routes/authenticated-layout.test.tsx
```

### DB 統合テスト（`pnpm test:db`）

DB 統合テスト（`packages/database/src/*.integration.test.ts`）だけを Docker の使い捨て
PostgreSQL に対して回します。`pnpm dev` の起動は要りません。起動していても開発用の DB には
触れません。

- `hono-starter-kit-dbtest-<pid>-<16hex>` という compose project で postgres だけを空きポートに
  起動し、その中に `starter_test_<16hex>` という DB を作ってテストします。
- 終了時は成否・中断に関係なく、コンテナ・ネットワーク・ボリュームを消し、公開ポートの解放と
  リソースが残っていないことを確かめます。postgres のイメージは共有のキャッシュなので残します。
- テストは `DATABASE_URL` の DB 名が `STARTER_DATABASE_TEST_NAME`（`starter_test_<16hex>`）と
  一致しないと接続を開きません。開発用の DB 名 `starter` を指すと、何もせずに拒否します。

接続先を故意に開発用 postgres に向けても、開発用 DB が消えないことは次の手順で確かめられます
（`pnpm dev` で開発用 postgres を起動した状態で実行します）。

```sh
# DB 名が開発用の starter なので、接続を開く前に guard が拒否する
DATABASE_URL=postgresql://starter:starter@127.0.0.1:5432/starter \
STARTER_DATABASE_TEST_NAME=starter_test_0123456789abcdef \
STARTER_DATABASE_TEST_PROJECT=hono-starter-kit-dbtest-1-0123456789abcdef \
pnpm exec vitest --config vitest.database.config.ts run

# guard は通るが、開発用 postgres にはこの名前の DB が無いので「database does not exist」で止まる
DATABASE_URL=postgresql://starter:starter@127.0.0.1:5432/starter_test_0123456789abcdef \
STARTER_DATABASE_TEST_NAME=starter_test_0123456789abcdef \
STARTER_DATABASE_TEST_PROJECT=hono-starter-kit-dbtest-1-0123456789abcdef \
pnpm exec vitest --config vitest.database.config.ts run
```

### Docker の受け入れ検証（`pnpm check:docker`）

Docker で PostgreSQL、API、Web、OIDC、トレース、本番用 API イメージを検証します。Terraform に
ついては追跡対象のソース・lock・テストだけを一時領域へコピーし、空の AWS ディレクトリーと
固定イメージで8 rootの `init -backend=false -lockfile=readonly`、`validate`、provider mock
`test` と plan の依存配線を検証します。通常の運用はこの検証用コピーを使わず、作業中の
Terraform ファイルをそのまま実行します。

検証で作成したコンテナー・イメージ・一時ディレクトリーは、成功・失敗・中断後に削除して
残留を確認します。既存のキャッシュや他のリソースは対象にしません。アプリケーション側も
所有するコンテナー・ネットワーク・ボリューム・イメージ・TLS ディレクトリー・公開ポートを
後片付けします。この受け入れ検証は実際の backend や AWS API を利用しません。

## 本番イメージを手で動かす

API イメージはローカルでビルドし、開発用アダプターで動かせます。決定的なローカル production
イメージの証明には `pnpm check:docker` を使ってください。

```bash
docker build -f docker/api.Dockerfile -t hono-starter-kit-api:local .

docker run --rm \
  -e DATABASE_URL=postgresql://starter:starter@host.docker.internal:5432/starter \
  hono-starter-kit-api:local \
  node /app/migrate.mjs

docker run --rm -p 127.0.0.1:3000:3000 \
  -e NODE_ENV=development \
  -e DATABASE_URL=postgresql://starter:starter@host.docker.internal:5432/starter \
  -e AUTH_PROVIDER=dev \
  -e APP_ORIGIN=http://127.0.0.1:3000 \
  hono-starter-kit-api:local

docker run --rm --network none \
  -e NODE_ENV=production \
  -e AUTH_PROVIDER=dev \
  hono-starter-kit-api:local
```

- 2 つ目のコマンド（マイグレーション）は、API の起動前に独立した操作として実行します。
- `host.docker.internal` は、Docker Desktop でホスト上の PostgreSQL へ到達するためのホスト名です。
- 最後のコマンドは本番でのフェイルクローズを示すもので、開発用の identity アダプターを
  指定されたイメージは起動を拒否します。

本番 OIDC で動かすには、マイグレーション済みの PostgreSQL と、`docs/configuration.md` の
「認証」にある HTTPS の OIDC 設定が必要です。

## 依存の更新

RDS の CA バンドルは `docker/certs` にベンダリングしてあります。`pnpm rds-ca:check` が
その内容を検証し、`pnpm rds-ca:refresh` が AWS の公式トラストストアから取り直します。
