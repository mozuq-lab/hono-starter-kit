# Hono Starter Kit

設計上の判断とその根拠は `docs/design.md` に、計画中でまだ実装していないものは `docs/roadmap.md` にまとめてあります。

## 要件

- Node.js 24 以降
- pnpm 11.15.1
- Docker Engine または Docker Desktop
- Docker Compose
- Docker Buildx

`scripts/aws/assume.sh` で一時認証情報を取得する場合は、ホストに AWS CLI と `jq` も必要です。

## 初回起動

pnpm がホストに入っていなければ一度だけ入れてください。入れるバージョンは問わず、
このリポジトリの中では pnpm が宣言済みの 11.15.1 へ自分を切り替えます。

```sh
npm install --global pnpm
```

このリポジトリの中で `npm install` などを実行すると、`EBADDEVENGINES` で拒否されます。
意図した動作です（理由は `docs/design.md` の「19. v0.1の実装範囲」）。

```sh
pnpm install --frozen-lockfile
pnpm db:setup
pnpm dev
```

http://127.0.0.1:5173/projects を開き、**Sign in** から開発専用の Dev Login フローを
使います。初回セットアップ以降の日常的な操作は次のとおりです。

```sh
pnpm dev
```

1. http://127.0.0.1:5173/projects を開く。
2. **Sign in** をたどる。
3. 終わったら `pnpm dev:down` でスタックを止める。

公開ポートはいずれも環境変数で変えられます。`WEB_PORT`（既定 5173）、`API_PORT`
（既定 3000）、`POSTGRES_PORT`（既定 5432）、`JAEGER_UI_PORT`（既定 16686）で、すべて
ループバックインターフェースにだけ公開されます。

通常の開発には PostgreSQL が必要です。データベースのマイグレーションは明示的に実行
します。`db:setup` がマイグレーションと初期データ投入をまとめて行い、以降のスキーマ変更は
`pnpm db:migrate` を使います。初期データの投入だけをやり直すなら `pnpm db:seed` です。
API の起動がマイグレーションを実行することはありません。

Project に所有者と作成日時を足したマイグレーション
（`0005_add_project_owner_and_created_at.sql`）は、`projects` に行がある DB には適用できません。
それより前に作った開発 DB は、PostgreSQL の volume だけを消して作り直してください。
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

## データベース接続

接続設定には2つのモードがあり、**混ぜて指定すると起動に失敗します**。URL 1本で渡す
`DATABASE_URL` モードと、項目ごとに渡す構造化モードのどちらかです。ローカル開発は前者、
AWS の ECS タスクは後者を使います。

| 名前                    | 契約                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | URL モード。スキームは `postgresql://` または `postgres://` のみ。development では既定値 `postgresql://starter:starter@127.0.0.1:5432/starter` があるので省略できます。production では省略すると起動に失敗します |
| `PGHOST`                | 構造化モード。空文字と制御文字を拒否します                                                                                                                                                                       |
| `PGPORT`                | 構造化モード。10進整数で 1 以上 65535 以下                                                                                                                                                                       |
| `PGDATABASE`            | 構造化モード。空文字と制御文字を拒否します                                                                                                                                                                       |
| `PGUSER`                | 構造化モード                                                                                                                                                                                                     |
| `PGPASSWORD`            | 構造化モード。固定 password。`PGPASSWORD_SECRET_ARN` と同時には指定できません                                                                                                                                    |
| `PGPASSWORD_SECRET_ARN` | 構造化モード。接続を新設するたびに最新 password を取得する Secrets Manager ARN。`PGPASSWORD` と排他的です                                                                                                        |
| `PGSSLROOTCERT`         | 構造化モード。読み取り可能な PEM バンドルのパス。中身は完全な PEM 証明書だけでなければならず、余分な文字が混じっていれば起動に失敗します                                                                         |

`PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGSSLROOTCERT` と、
`PGPASSWORD` / `PGPASSWORD_SECRET_ARN` のどちらか一方が必要です。`PG*` の
どれか1つでも設定された状態で `DATABASE_URL` も設定すると、どちらを使うか推測せずに起動を
止めます。構造化モードの TLS はサーバー証明書の検証を必ず有効にします。無効にする設定は
ありません。

workload モジュールが ECS タスクへ渡すのは構造化モードです。`PGHOST`、`PGPORT`、
`PGDATABASE`、`PGSSLROOTCERT`（`/app/certs/global-bundle.pem`）は平文の環境変数として
渡します。`PGUSER` はタスク定義の `secrets` 経由で、RDS が管理する
マスターユーザーシークレットから読みます。password は `PGPASSWORD_SECRET_ARN` と
`AWS_REGION` を使い、新規 DB 接続時に `AWSCURRENT` を取得します。タスクを再起動しなくても
RDS の password rotation に追従できます。runtime role の読取権限は対象 secret に限定します。
このシークレットはオペレーターが作るものではありません。

API プロセスとマイグレーションの実行には、次の任意の設定があります。

| 名前                   | 契約                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | API の待ち受けポート。10進整数で 1 以上 65535 以下。既定は 3000                                                   |
| `HOST`                 | 待ち受けアドレス。`127.0.0.1`（既定）または `0.0.0.0` のみ。ほかの値は拒否します                                  |
| `MIGRATIONS_DIRECTORY` | マイグレーション SQL の置き場所。production イメージは `/app/migrations` を焼き込んであるので、通常は設定しません |

### タイムアウトと長いクエリ

API の接続の上限値とその理由は `docs/design.md` の「7. DBアクセス」にあります。
API の `statement_timeout` は 15 秒で、超えた文は SQLSTATE `57014` で失敗します。

15 秒より長くかかる正当なクエリ（集計やエクスポート）は、トランザクションの中で
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
付けません（migration は次のとおり runner が 1 本ずつ上限を付けます）。

### マイグレーションの上限と再試行

AWS では、マイグレーションは ECS タスクが起動するたびに sidecar として走ります。runner の
上限と再試行の設計は `docs/design.md` の「B. AWS Split Profile」にあります。

- ロック待ちで失敗した（`55P03`）ときだけ、そのトランザクションを 1・2・4・8 秒の間隔で
  最大 5 回まで実行し直します。使い切ると
  「Database migration could not acquire a table lock after 5 attempts.」で止まります。
  DB が落ち着いてから再デプロイしてください。
- 5 分を超えた文は「Database migration exceeded its statement timeout.」で止まります。
- 先行の migrator を待つ時間には、「未適用のマイグレーションの本数 × 10 分」（最低 10 分）の
  上限があります。超えると
  「Database migration waited too long for another migrator to finish.」で止まり、
  migration コンテナが終了コード 1 で終わって API コンテナは起動しません。先行のタスクが
  固まっているので、そのタスクを止めるか、`pg_terminate_backend` で先行のセッションを
  切ってから再デプロイしてください。

この上限は、1 本のマイグレーションが 10 分以内に終わる前提で決めています。前提を守るため、
次のことに従ってください。

- マイグレーションの SQL で `statement_timeout` と `lock_timeout` に触れず、`RESET ALL` も
  使わないでください。runner は、これらを含むファイルがあると、何も実行せずに止まります。
- `BEGIN`、`COMMIT`、`ROLLBACK` などでトランザクションを自分で制御しないでください。runner が
  1 本ずつトランザクションで包むので、これらの文を含むファイルも実行前に拒否します
  （PL/pgSQL の本体の `BEGIN … END` は対象外です）。
- 長く走りうる文（大きな表の書き換えや index の作成）を、1 本のマイグレーションに複数入れない
  でください。これは機械的には検出しません。
- 5 分を超える処理は通常のデプロイから分け、別の手順で流してください。

## 認証

認証の構造、セッションと Cookie、サインアウトの流れは `docs/design.md` の「8. 認証・認可」に
あります。ローカル開発は Dev Login を既定にしています。OIDC を使うには、次の非機密な認証環境変数を設定します。任意の
クライアントシークレットについては表の後で説明します。

| 名前                                 | 契約                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                           | 本番 Cookie と HTTPS 契約を有効にするには `production`                                                               |
| `AUTH_PROVIDER`                      | `oidc` を指定                                                                                                        |
| `APP_ORIGIN`                         | アプリケーションの HTTP(S) オリジンそのもの。本番は HTTPS 必須                                                       |
| `OIDC_ISSUER`                        | ディスカバリーの issuer URL。本番は HTTPS 必須                                                                       |
| `OIDC_CLIENT_ID`                     | IdP に登録したクライアントの識別子（パブリック・コンフィデンシャルのどちらでもよい）                                 |
| `OIDC_LOGOUT_ENDPOINT`               | プロバイダーのログアウト URL。クレデンシャル・クエリ・フラグメントを含めない                                         |
| `OIDC_LOGOUT_REDIRECT_PARAMETER`     | 任意。`logout_uri`（既定、Cognito）または `post_logout_redirect_uri`（Keycloak / 標準の RP-Initiated Logout）        |
| `OIDC_LOGIN_TRANSACTION_TTL_SECONDS` | 任意の整数。60 以上 600 以下。既定は 600                                                                             |
| `SESSION_ABSOLUTE_TTL_SECONDS`       | 任意。アプリケーションセッションの絶対寿命。既定は 604800、上限は Cookie の Max-Age 上限に合わせた 34560000（400日） |
| `SESSION_IDLE_TTL_SECONDS`           | 任意のアイドル寿命。既定は 86400 で、絶対寿命を超えられない                                                          |
| `SESSION_TOUCH_INTERVAL_SECONDS`     | 任意のタッチ間隔。既定は 300 で、アイドル TTL より小さくなければならない                                             |

`OIDC_CLIENT_SECRET` は任意です。設定しなければパブリッククライアント（PKCE だけ）として
動きます。設定すると、token endpoint へ `client_secret_basic` でクライアント認証します。
その場合も PKCE は併用します。空の値や、前後に空白・改行がある値は、起動時に設定エラーに
なります。IdP の discovery の `token_endpoint_auth_methods_supported` に `client_secret_basic`
が載っていない場合は、ログイン開始時に失敗します。値は秘密情報として注入してください。
アプリはこの値をログにも trace にも出しません。同梱の AWS 構成（Cognito）はパブリック
クライアントのままで、この変数を配線していません。実際の IdP（Entra ID、Cognito など）に
対するコンフィデンシャルクライアントとしての動作は、まだ検証していません。
コールバック URI は `<APP_ORIGIN>/auth/callback`、ログアウト後の URI は
`<APP_ORIGIN>/login` に固定されています。平文 HTTP の OIDC はループバックでの開発と
テストフィクスチャーでしか許可されません。本番はアプリケーション・issuer・ログアウト
エンドポイントのすべてに HTTPS を要求します。

本番の Cookie の `Max-Age` は、`__Host-session` が `SESSION_ABSOLUTE_TTL_SECONDS`、
`__Secure-oidc-transaction` が `OIDC_LOGIN_TRANSACTION_TTL_SECONDS` と同じ値になります。

Dev 認証は本番では禁止です。`AUTH_PROVIDER=dev` と `NODE_ENV=production` を同時に設定
すると、匿名や開発用の identity にフォールバックせず、API の起動そのものが失敗します。

## 可観測性

```text
pnpm dev
Jaeger UI: http://127.0.0.1:16686
サービス名: hono-starter-api
```

開発用 Compose は HTTP と PostgreSQL のトレースを自動的に Jaeger へ送ります。OTLP HTTP の
ポート 4318 は Compose ネットワークの内側でしか使えず、ホストには公開されません。Jaeger UI
もループバックインターフェースにだけ公開されます。

`NODE_ENV=test` は、他のどのテレメトリー設定より先にテレメトリーを無効化します。本番では、
トレースエクスポーターを省略するか `none` にした場合、`OTEL_EXPORTER_OTLP_ENDPOINT` が
無ければテレメトリーは無効のままです。エンドポイントなしで `otlp` エクスポーターを要求
すると起動に失敗します。対応する OTLP プロトコルは `http/protobuf` だけです。

- `OTEL_TRACES_EXPORTER`: 省略するとエンドポイントの有無で有効化を判断します。`otlp` に
  するとエンドポイントを必須にし、`none` にするとテレメトリーを無効化します。それ以外の
  値は拒否されます。
- `OTEL_EXPORTER_OTLP_ENDPOINT`: コレクターのベース URL を絶対 HTTP / HTTPS で指定します。
  指定するとエクスポーターが `none` でない限りテレメトリーが有効になり、ランタイムが
  `/v1/traces` を付け足します。
- `OTEL_EXPORTER_OTLP_PROTOCOL`: テレメトリーが有効なときは、省略するか `http/protobuf` を
  指定します。それ以外の値は拒否されます。
- `OTEL_SERVICE_NAME`: テレメトリーが有効なときに使う任意のサービス名。既定は
  `hono-starter-api` です。

500 になった要求などのログの形式と、何を出さないかは `docs/design.md` の「13. 可観測性」に
あります。

## Projects サンプル

- `/projects` は稼働中とアーカイブ済みの Project を一覧します。
- `/projects/new` は稼働中の Project を作成します。
- `/projects/:projectId` は詳細を表示し、バージョン安全なリネームに対応し、確認のうえで
  稼働中の Project をアーカイブします。
- このサンプルではアーカイブは取り消せません。アーカイブ済みの Project は読み取り専用の
  ままです。

古いバージョンでの更新は `409` を返し、UI はサーバーが確定した状態へ更新します。

各ユーザーは自分が作成した Project だけを読み書きできます（設計は `docs/design.md` の
「8. 認証・認可」）。

`pnpm db:seed` が作る Alpha は、Dev Login の利用者が所有します。seed より先に Dev Login で
ログインしていても、そのとき作られた利用者が所有者になります。seed は開発用です。

## 停止

```sh
pnpm dev:down
```

`dev:down` は開発スタックを止めますが、PostgreSQL の named volume とデータはそのまま
残します。データベースを削除することはありません。

## Terraform

`pnpm terraform` は、digest で固定した Terraform 1.15.8 の公式 Docker イメージを
直接実行する薄い入口です。ホストへの Terraform インストールは不要で、Docker の context・
接続先・registry 設定は呼び出し元の設定を引き継ぎます。`--root` で作業ディレクトリーを
選び、その後のコマンドと引数は Terraform にそのまま渡します。

```sh
pnpm terraform -- --root dev version
pnpm terraform:check
```

`--root` は `bootstrap`、`module:network`、`module:data`、`module:ingress`、`module:edge`、
`module:identity`、`module:workload`、`dev`（省略時）から選びます。`apply`、`destroy`、
`show`、`state`、`import` や `-var-file`、`-out` も標準どおり使えます。
コンテナー内の作業ディレクトリーからの相対パスを指定してください。ホストの任意の
絶対パスはコンテナーにマウントされません。`-chdir` の代わりに `--root` を使います。

`TF_INPUT=0` を既定にし、必須変数が未設定なら入力待ちせずエラーにします。変数は
`terraform.tfvars`、`-var`、`TF_VAR_*` などで渡してください。変数の対話入力が必要な場合は
`TF_INPUT=1` で上書きできます。通常の `apply` / `destroy` の `yes` 確認は残ります。
更新確認の `CHECKPOINT_DISABLE=1` と EC2 メタデータ探索の `AWS_EC2_METADATA_DISABLED=true`
も既定にします。いずれも明示した環境変数を優先します。

`terraform:fmt` は整形の検査、`terraform:validate` は構文検証、`terraform:test` は
provider mock test を8 rootに対して実行します。`terraform:check` は各 root の
`fmt -check -recursive`、`init -backend=false -lockfile=readonly`、`validate`、`test` と、
dev root の plan で module 間の依存が保たれているかの検査を実行します。edge function・IAM policy・
module 間の配線を Terraform を起動せずに読む node のテストは `pnpm test` に含まれます。整形を実際に反映する場合は
`pnpm terraform -- --root dev fmt -recursive` のように標準コマンドを使います。

### AWS インフラの作成・更新

初回は次の設定例をコピーし、対象アカウントと環境に合わせて編集します。

```sh
cp infra/terraform/bootstrap/terraform.tfvars.example infra/terraform/bootstrap/terraform.tfvars
cp infra/terraform/environments/dev/backend.hcl.example infra/terraform/environments/dev/backend.hcl
cp infra/terraform/environments/dev/terraform.tfvars.example infra/terraform/environments/dev/terraform.tfvars
```

両 root の `aws_account_id` は必須で、AWS Provider の `allowed_account_ids` に渡されます。
S3 backend は別に認証するため、`backend.hcl` の `allowed_account_ids` にも対象アカウントを
指定します。dev の `api_repository_arn` には bootstrap の output `ecr_repository_arn` を、
`api_image` にはそのリポジトリーへ push した API イメージの digest 固定参照を、`adot_image`
には公式 ADOT イメージの digest 固定参照を設定します。API イメージの push と web 資産の
配置は、後述の `pnpm release:api` と `pnpm release:web` で行います。

bootstrap は GitHub Actions 用の plan role と deploy role、両者が共有する read 用 managed
policy、OIDC provider を既定では作りません。使う workflow ができた時点で、
`terraform.tfvars` の `create_github_plan_role` と `create_github_deploy_role` を `true` に
します。どちらか一方でも有効にすると共有 policy が作られ、`create_github_oidc_provider = true`
のときは OIDC provider も作られます。

- plan role: plan を実行する workflow があり、`pull_request_target` と `workflow_run` を使わないこと。
- deploy role: deploy workflow と、main に限定し承認者を必須にした GitHub environment があること。

認証にはホストの `~/.aws` と `AWS_PROFILE` を使えます。AssumeRole と MFA を対話的に使う
場合は `source scripts/aws/assume.sh` で一時認証情報を取得します。環境変数にある認証情報は
一時的な権限 `0600` のプロファイルへ書き出し、共有プロファイルと同様に読み取り専用で
コンテナーへ渡します。認証情報を Docker の引数や環境変数へ展開せず、一時ファイルは
終了・失敗・中断後に削除します。ロールの選択は AWS のプロファイルと IAM に委ねます。

```sh
pnpm terraform -- --root bootstrap init
pnpm terraform -- --root bootstrap plan
pnpm terraform -- --root bootstrap apply

pnpm terraform -- --root dev init -backend-config=backend.hcl
pnpm terraform -- --root dev plan
pnpm terraform -- --root dev apply
```

`apply` は実行時点の plan を再生成して表示し、Terraform 標準の `yes` 確認を求めます。
確認した plan を保存して使う場合も標準機能を利用できます。

```sh
pnpm terraform -- --root dev plan -out=plan.tfplan
pnpm terraform -- --root dev show plan.tfplan
pnpm terraform -- --root dev apply plan.tfplan
```

**保存済み plan を指定した `apply` は追加確認なしで実行されます。** 独自 manifest、Git の
clean チェック、現在の commit との照合はありません。plan と state には機微情報が含まれる
ため Git に追加しないでください。bootstrap の state はローカル、dev の state は
versioning と locking を有効にした S3 に保存します。bootstrap のローカル state は
Terraform 標準のバックアップも含めて管理し、別途安全に保管してください。

実 AWS での作成・更新・削除は未検証です。ローカルの受け入れ検証は、空の AWS ディレクトリーと
provider mock を使い、実 AWS のアカウント照合やサービスの挙動を証明するものではありません。

### API イメージと web 資産の公開

ホストに AWS CLI と Docker（buildx）が必要です。どちらの script も、作業ツリーに未コミットの
変更があると止まります。緊急時は `--allow-dirty` で続行でき、API イメージの tag に `-dirty-<UTC>`
が付きます。

```sh
pnpm release:api -- --repository-url <bootstrap の output ecr_repository_url>
pnpm terraform -- --root dev apply

pnpm release:web -- --bucket <dev の output web_bucket_name> --distribution-id <dev の output distribution_id>
```

`release:api` は linux/amd64 の API イメージを build し、そのイメージが本番設定で
`AUTH_PROVIDER=dev` を拒否することを確かめてから `release-<commit>` の tag で ECR へ push します。
同じ tag がすでにあれば build せず、その digest を使います。registry から読み直した digest を
dev の `terraform.tfvars` の `api_image` に書くので、続けて `apply` で ECS を切り替えます
（`terraform.tfvars` がなければ、設定すべき値を表示するだけです）。

`release:web` は HEAD から web を build し直し、hash 付きの asset、`index.html`（`no-cache`）、
配信中の commit を示す `release.json` の順に web bucket へ置きます。`--distribution-id` を
渡したときだけ `/index.html` の CloudFront Invalidation を行います。

両 script とも、実 AWS での実行は未検証です。

### AWS インフラの削除

`terraform:teardown` は開発環境の保護解除と削除を補助します。Terraform 標準の確認付き
`apply` / `destroy` を使い、保存 plan や独自の確認文字列は管理しません。

```sh
pnpm terraform:teardown -- --root dev unprotect
pnpm terraform:teardown -- --root dev destroy
pnpm terraform:teardown -- --root bootstrap unprotect
pnpm terraform:teardown -- --root bootstrap destroy
```

bootstrap の保護解除・削除の前に `dev state pull` で確認し、リソースが残っていれば停止します。
dev の backend を初期化してから使ってください。state が未作成、または resources が空の場合は
撤去へ進みます。取得に失敗した場合や応答が不正な場合は停止します。
この順序は、dev のリソースが残っている間に state 保存先の S3 を消さないためです。
取得失敗時は対象 root と再確認用の `pnpm terraform -- --root dev state list` を表示します。
内部で捕捉した state や診断は自動表示しません。backend の初期化と AWS の認証・権限を
確認してください。cleanup も失敗した場合は、元の失敗と cleanup の失敗を併記します。

この補助は **RDS の最終スナップショットを作成せず、S3 のオブジェクトと ECR のイメージも
削除する** 設定で保護を解除します。残すデータがある場合は事前にバックアップしてください。
解除用の変数を普段の `terraform.tfvars` に残さず、途中で削除を取りやめた場合は通常の
`apply` で保護を戻してください。認証期限の独自制限や自動ロールバックはありません。
失敗・中断時は Terraform の診断と state を確認し、認証を更新して必要な操作を再実行します。

削除順序の検査はこの補助コマンドに限ります。`pnpm terraform -- --root bootstrap destroy`
など標準コマンドを直接使う場合は、操作者が順序を管理します。

## 検証

```sh
pnpm check
pnpm test:e2e
pnpm test:csp
pnpm test:db
pnpm check:docker
```

`pnpm check` は次の4つをこの順に実行します。個別に走らせることもできます。`pnpm lint` は
先に `pnpm typecheck`（各パッケージと `scripts/` の型検査）を実行してから ESLint を走らせます。

```sh
pnpm format:check
pnpm lint
pnpm test
pnpm build
```

ローカルフィクスチャーだけでプロバイダー非依存 OIDC を絞り込んで確認するには、次を使います。

```sh
pnpm exec vitest run apps/api-node/src/auth-config.test.ts apps/api-node/src/session-crypto.test.ts apps/api-node/src/oidc-identity-provider.test.ts packages/backend/src/platform/auth/external-login-cookie.test.ts packages/backend/src/platform/auth/external-login.routes.test.ts apps/api-node/src/composition-root.test.ts apps/api-node/src/runtime-composition.test.ts apps/web/app/routes/authenticated-layout.test.tsx
```

RDS の CA バンドルは `docker/certs` にベンダリングしてあります。`pnpm rds-ca:check` が
その内容を検証し、`pnpm rds-ca:refresh` が AWS の公式トラストストアから取り直します。

`pnpm test:db` は DB 統合テスト（`packages/database/src/*.integration.test.ts`）だけを
Docker の使い捨て PostgreSQL に対して回します。Docker が必要ですが、`pnpm dev` の起動は
要りません。起動していても開発用の DB には触れません。repository や migration の SQL を
変えたときの狭いチェックとして使ってください。

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

`pnpm check:docker` は Docker で PostgreSQL、API、Web、OIDC、トレース、本番用 API
イメージを検証します。Terraform については追跡対象のソース・lock・テストだけを一時領域へ
コピーし、空の AWS ディレクトリーと固定イメージで8 rootの `init -backend=false
-lockfile=readonly`、`validate`、provider mock `test` と plan の依存配線を検証します。
通常の運用はこの検証用コピーを使わず、作業中の Terraform ファイルをそのまま実行します。

検証で作成したコンテナー・イメージ・一時ディレクトリーは、成功・失敗・中断後に削除して
残留を確認します。既存のキャッシュや他のリソースは対象にしません。アプリケーション側も
所有するコンテナー・ネットワーク・ボリューム・イメージ・TLS ディレクトリー・公開ポートを
後片付けします。この受け入れ検証は実際の backend や AWS API を利用しません。

Compose スタックはローカル開発と検証のためのものです。AWS へデプロイしたインフラと、
デプロイ済みプロバイダーへのスモークテストは未実施のままです。API イメージ自体は今でも
ビルドでき、次のオペレーターコマンドで開発用アダプターを手動で動かせます。

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

マイグレーションは API の起動前に、独立したオペレーター操作として実行してください。API の
起動はマイグレーションの適用状態を検証するだけで、マイグレーションを実行することは
ありません。この Mac ローカルの Docker Desktop の例では、`host.docker.internal` がホスト上の
PostgreSQL へ到達するためのホスト名です。

上の development モードの API コマンドは、ローカルイメージのゴールデンパスにすぎません。
最後のコマンドは本番でのフェイルクローズ動作を示すものです。本番で開発用の identity
アダプターを指定されたイメージは、起動を拒否します。本番 OIDC には、マイグレーション済みの
PostgreSQL データベースと、上に書いた HTTPS の OIDC 設定が必要です。決定的なローカル
production イメージの証明には `pnpm check:docker` を使ってください。

## fork するとき

fork したリポジトリで変える場所は次のとおりです。

| 目的                     | 箇所                                                                        | 備考                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm workspace の名前     | `package.json` の `name`                                                    |                                                                                                                                                                                                                                                                                                    |
| AWS のリソース名の接頭辞 | bootstrap と dev の `terraform.tfvars` の `project`                         | **両 root で同じ値にします。** bootstrap は deploy role の IAM の許可範囲、ECR の名前、state の key を自分の `project` から作るため、dev の値が違うと deploy role での apply が AccessDenied になります。dev の Web 用 S3 bucket 名（`<project>-dev-web`）にも使うので、世界で一意になる値にします |
| state の置き場所         | bootstrap の `state_bucket_name`、dev の `backend.hcl` の `bucket` と `key` | bucket 名は世界で一意にします。`bucket` は `state_bucket_name` と、`key` は bootstrap の IAM が許可する `<project>/dev/terraform.tfstate` とそろえます                                                                                                                                             |
| Cognito の hosted UI     | dev の `domain_prefix`                                                      | 世界で一意にします                                                                                                                                                                                                                                                                                 |
| GitHub OIDC              | bootstrap の `github_owner`、`github_repository`、`github_default_branch`   | plan role と deploy role の信頼条件に使います。role を有効にする条件は「AWS インフラの作成・更新」を参照してください                                                                                                                                                                               |
| CI                       | GitHub のリポジトリ設定                                                     | 依存の更新 PR は Renovate の GitHub App をリポジトリに入れたときだけ届きます（`renovate.json` だけでは動きません）。branch protection で `ci.yml` の `check`、`e2e`、`terraform`、`db-integration` を必須にします                                                                                  |

`docker-nightly.yml` のような `schedule` の workflow は、fork では既定で無効です。また GitHub は、
public リポジトリで 60 日間活動がないと `schedule` の workflow を止めます。

Problem の `type` URI の基点 `https://starter.local/problems/` と、Dev ログインの identity の
issuer `urn:starter:dev` も、fork 側の値に変えて構いません。

- `type` URI は `packages/contracts/src/errors/problem.contract.ts` と
  `packages/contracts/src/projects/project.contract.ts` にあります。クライアントは `type` では
  なく `code` で分岐するので、変えても画面は変わりません。URI を完全一致で確かめるテストも
  一緒に変えます。
- `urn:starter:dev` は `packages/backend/src/platform/auth/dev-identity.ts` にあります。変えると
  既存の開発用 DB に seed した Dev identity とは別の identity になるので、「初回起動」の手順で
  PostgreSQL の volume を作り直してください。関係するテストも一緒に変えます。

次のものは変えなくて構いません。

- Docker 検証の所有ラベルと一時ディレクトリーの名前。
- `@starter/*` のパッケージ scope。
- OpenTelemetry のサービス名 `hono-starter-api`。変える場合は `OTEL_SERVICE_NAME` の既定値
  （`apps/api-node/src/telemetry-config.ts`）、`compose.yaml`、
  `infra/terraform/modules/workload/main.tf`、Jaeger で検索する `scripts/check-docker.ts` と、
  関係するテストを一緒に変えます。`compose.yaml` だけを変えると `pnpm check:docker` が
  落ちます。

dev と bootstrap の `terraform.tfvars` に何を書いても、`pnpm terraform:check` の結果は
変わりません。この2つの root の Terraform テストは、すべての変数をテストファイルの中で
固定しています。

マイグレーションの番号に注意してください。スターターは今後も
`packages/database/migrations/` に番号付きのマイグレーションを足します。fork 側で足した
マイグレーションとスターターのものは、同じ番号になることがあります。スターターの変更を
取り込むときは番号を確かめてください。同じ番号で名前の違うマイグレーションが適用済みだと、
マイグレーションの実行も API の起動も履歴の食い違いとして止まります。

データを持つ fork がスターターの `0005_add_project_owner_and_created_at.sql` を取り込むと、
`projects` に行がある限り適用に失敗します。取り込む前に、所有者と作成日時を埋める独自の
マイグレーション（nullable で足す → 埋める → NOT NULL にする）を書いてください。スターターは
この経路を用意していません。
