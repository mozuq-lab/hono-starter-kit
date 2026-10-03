# AWS の構築と運用

Terraform で AWS の環境を作り、API イメージと web 資産を公開し、不要になったら削除するための
手順です。構成と設計の理由は `docs/design.md` の「14. デプロイ方式を2種類用意する」と
「Terraform の実行と運用」にあります。

> 実 AWS で確かめた範囲と、まだ確かめていない手順（環境の削除など）は、README の
> 「検証済みの範囲」にあります。

## 要件

- Docker（Buildx を含む）
- AWS CLI（`release:api`、`release:web` で使う）
- `jq`（`scripts/aws/assume.sh` で一時認証情報を取得する場合）

ホストへの Terraform のインストールは不要です。

## Terraform の実行

`pnpm terraform` は、digest で固定した Terraform 1.15.8 の公式 Docker イメージを直接実行する
薄い入口です。Docker の context・接続先・registry 設定は呼び出し元の設定を引き継ぎます。
`--root` で作業ディレクトリーを選び、その後のコマンドと引数は Terraform にそのまま渡します。

```sh
pnpm terraform -- --root dev version
pnpm terraform:check
```

`--root` は `bootstrap`、`module:network`、`module:data`、`module:ingress`、`module:edge`、
`module:identity`、`module:workload`、`dev`（省略時）から選びます。`apply`、`destroy`、
`show`、`state`、`import` や `-var-file`、`-out` も標準どおり使えます。
コンテナー内の作業ディレクトリーからの相対パスを指定してください。ホストの任意の
絶対パスはコンテナーにマウントされません。`-chdir` の代わりに `--root` を使います。

次の環境変数を既定で設定します。いずれも明示した環境変数を優先します。

- `TF_INPUT=0`: 必須変数が未設定なら入力待ちせずエラーにします。変数は `terraform.tfvars`、
  `-var`、`TF_VAR_*` などで渡してください。対話入力が必要なら `TF_INPUT=1` で上書きできます。
  通常の `apply` / `destroy` の `yes` 確認は残ります。
- `CHECKPOINT_DISABLE=1`: 更新確認をしません。
- `AWS_EC2_METADATA_DISABLED=true`: EC2 メタデータを探索しません。

`terraform:fmt` は整形の検査、`terraform:validate` は構文検証、`terraform:test` は
provider mock test を8 rootに対して実行します。`terraform:check` は各 root の
`fmt -check -recursive`、`init -backend=false -lockfile=readonly`、`validate`、`test` と、
dev root の plan で module 間の依存が保たれているかの検査を実行します。整形を実際に反映する
場合は `pnpm terraform -- --root dev fmt -recursive` のように標準コマンドを使います。

### provider を更新したとき

`.terraform.lock.hcl` には、Terraform を動かす Linux の両アーキテクチャのハッシュを記録します。
`init` が書き足すのは実行した環境のハッシュだけなので、Apple Silicon で更新すると linux_arm64 しか
残らず、amd64 の CI が `-lockfile=readonly` で初期化したあとの `validate` で落ちます。provider の version を変えたら、
8 つの root それぞれで次を実行してください。

```sh
pnpm terraform -- --root dev providers lock -platform=linux_amd64 -platform=linux_arm64
```

### output の値を取り出す

後の手順で使う値は、`terraform output` でいつでも取り出せます。`pnpm -s` にすると pnpm がコマンドの
行を出さないので、値だけを別のコマンドへ渡せます。bootstrap の state はローカルのファイルなので
AWS に問い合わせずに読めますが、dev の state は S3 にあるので認証情報が要ります。

| 使う場面                                              | コマンド                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `release:api` の `--repository-url`                   | `pnpm -s terraform -- --root bootstrap output -raw ecr_repository_url` |
| dev の `api_repository_arn`                           | `pnpm -s terraform -- --root bootstrap output -raw ecr_repository_arn` |
| `release:web` の `--bucket`                           | `pnpm -s terraform -- --root dev output -raw web_bucket_name`          |
| `release:web` の `--distribution-id`                  | `pnpm -s terraform -- --root dev output -raw distribution_id`          |
| `smoke:dev` の `--origin`                             | `pnpm -s terraform -- --root dev output -raw app_origin`               |
| `smoke:dev` の `--alb-dns-name`                       | `pnpm -s terraform -- --root dev output -raw alb_dns_name`             |
| Cognito の User Pool ID（`oidc_issuer` の最後の部分） | `pnpm -s terraform -- --root dev output -raw oidc_issuer`              |

### state のロックが残ったとき

`apply` が途中で止まる（Ctrl-C、端末を閉じた、Docker が止まった）と、S3 の state のロックが残り、
次の操作が `Error acquiring the state lock` で止まります。ほかに `pnpm terraform` を実行している
端末が無いこと（`docker ps --filter label=hono-starter.terraform.owner` が空であること）を確かめてから、
エラーに出たロックの ID を指定して外します。`pnpm terraform` は入力待ちをしない設定なので、確認に
答えられるよう `TF_INPUT=1` を付けます。

```sh
TF_INPUT=1 pnpm terraform -- --root dev force-unlock <Lock Info の ID>
```

外した後は、`apply` の前に `plan` で、途中まで作られたリソースが state にあるかを確かめます。

## 環境を作る・更新する

初回は、bootstrap → API イメージの公開 → dev → web 資産の公開 → 確認、の順に進めます。dev は
API イメージの digest が無いと plan できないので、API イメージを dev より先に公開します。

### 1. 設定ファイルを用意する

次の設定例をコピーし、対象アカウントと環境に合わせて編集します。

```sh
cp infra/terraform/bootstrap/terraform.tfvars.example infra/terraform/bootstrap/terraform.tfvars
cp infra/terraform/environments/dev/backend.hcl.example infra/terraform/environments/dev/backend.hcl
cp infra/terraform/environments/dev/terraform.tfvars.example infra/terraform/environments/dev/terraform.tfvars
```

- 両 root の `aws_account_id` は必須で、AWS Provider の `allowed_account_ids` に渡されます。
- S3 backend は別に認証するため、`backend.hcl` の `allowed_account_ids` にも同じアカウントを
  指定します。認証情報のアカウントと違うと、`init` が `AWS account ID not allowed` で止まります。
- dev の `api_repository_arn`・`api_image`・`adot_image` は、手順 4 で埋めます。設定例にコメントアウトした
  行があるので、値を決めたら `#` を外します（`api_image` は `release:api` が書き込みます）。どれも dev の
  `terraform.tfvars` に書く値で、bootstrap の `terraform.tfvars` には書きません。

fork したリポジトリで変える値（`project`、bucket 名など）は `docs/forking.md` にあります。

### GitHub Actions 用の role

bootstrap は GitHub Actions 用の plan role と deploy role、両者が共有する read 用 managed
policy、OIDC provider を既定では作りません。使う workflow ができた時点で、
`terraform.tfvars` の `create_github_plan_role` と `create_github_deploy_role` を `true` に
します。どちらか一方でも有効にすると共有 policy が作られ、`create_github_oidc_provider = true`
のときは OIDC provider も作られます。GitHub の OIDC provider は 1 つのアカウントに同じ URL で
1 つしか作れないので、既にある場合は `create_github_oidc_provider = false` にして
`github_oidc_provider_arn` に既存の ARN を指定します（`aws iam list-open-id-connect-providers` で
確かめられます）。

- plan role: plan を実行する workflow があり、`pull_request_target` と `workflow_run` を使わないこと。
- deploy role: deploy workflow と、main に限定し承認者を必須にした GitHub environment があること。

### 2. 認証する

ホストの `~/.aws` と `AWS_PROFILE` を使えます。AssumeRole と MFA を対話的に使う場合は
`source scripts/aws/assume.sh` で一時認証情報を取得します。ロールの選択は AWS の
プロファイルと IAM に委ねます。

環境変数にある認証情報は一時的な権限 `0600` のプロファイルへ書き出し、共有プロファイルと
同様に読み取り専用でコンテナーへ渡します。認証情報を Docker の引数や環境変数へ展開せず、
一時ファイルは終了・失敗・中断後に削除します。`release:api`・`release:web` と Cognito の操作は、
コンテナーではなくホストの AWS CLI で動きます。

### 3. bootstrap を適用する

```sh
pnpm terraform -- --root bootstrap init
pnpm terraform -- --root bootstrap plan
pnpm terraform -- --root bootstrap apply
```

### 4. API イメージを公開し、dev の値を埋める

`api_repository_arn` を dev の `terraform.tfvars` に書きます。

```sh
pnpm -s terraform -- --root bootstrap output -raw ecr_repository_arn
```

API イメージを ECR へ公開します。`release:api` は、push したイメージの digest を dev の
`terraform.tfvars` の `api_image` に書き込みます（行が無ければ足します）。

```sh
pnpm release:api -- --repository-url "$(pnpm -s terraform -- --root bootstrap output -raw ecr_repository_url)"
```

`adot_image` には、公式 ADOT コレクターのイメージを digest で固定して書きます。バージョンは
[GitHub のリリース](https://github.com/aws-observability/aws-otel-collector/releases) か
[ECR Public Gallery](https://gallery.ecr.aws/aws-observability/aws-otel-collector) で選び、
digest を調べます。

```sh
docker buildx imagetools inspect public.ecr.aws/aws-observability/aws-otel-collector:<バージョンのタグ>
```

出力の先頭の `Digest:`（amd64 と arm64 をまとめた index の digest）を使います。ECS のタスクは
`X86_64` で動き、ECS が index から amd64 のイメージを選びます。

```hcl
adot_image = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:<64 桁>"
```

タグではなく digest で固定するのは、同じタグが後から別のイメージを指しても、デプロイするものが
変わらないようにするためです。

### 5. dev を適用する

```sh
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
clean チェック、現在の commit との照合はありません。

plan と state には機微情報が含まれるため Git に追加しないでください。bootstrap の state は
ローカル、dev の state は versioning と locking を有効にした S3 に保存します。bootstrap の
ローカル state は Terraform 標準のバックアップも含めて管理し、別途安全に保管してください。

### 6. web 資産を公開する

```sh
pnpm release:web -- --bucket "$(pnpm -s terraform -- --root dev output -raw web_bucket_name)" \
  --distribution-id "$(pnpm -s terraform -- --root dev output -raw distribution_id)"
```

## API と web を更新する

2 回目以降は、変更した側だけを公開します。API は `release:api` の後に dev の `apply` で ECS を
新しいイメージへ切り替え、web は `release:web` だけで切り替わります。

```sh
pnpm release:api -- --repository-url "$(pnpm -s terraform -- --root bootstrap output -raw ecr_repository_url)"
pnpm terraform -- --root dev apply

pnpm release:web -- --bucket "$(pnpm -s terraform -- --root dev output -raw web_bucket_name)" \
  --distribution-id "$(pnpm -s terraform -- --root dev output -raw distribution_id)"
```

どちらの script も、作業ツリーに未コミットの変更があると止まります。緊急時は `--allow-dirty` で
続行でき、API イメージの tag に `-dirty-<UTC>` が付きます。

`release:api` は linux/amd64 の API イメージを build し、そのイメージが本番設定で
`AUTH_PROVIDER=dev` を拒否することを確かめてから `release-<commit>` の tag で ECR へ push します。
同じ tag がすでにあれば build せず、その digest を使います。registry から読み直した digest を
dev の `terraform.tfvars` の `api_image` に書きます（`terraform.tfvars` がなければ、設定すべき値を
表示するだけです）。

`release:web` は lockfile どおりに依存を入れ直してから（`pnpm install --frozen-lockfile`）HEAD から
web を build し直し、hash 付きの asset、`index.html`（`no-cache`）、配信中の commit を示す
`release.json` の順に web bucket へ置きます。`--distribution-id` を渡したときだけ `/index.html` の
CloudFront Invalidation を行います。

## デプロイを確かめる

`release:web` まで終えたら、smoke test で CloudFront・ALB・キャッシュポリシーの設定を確かめます。
秘密情報は使いません。

```sh
pnpm smoke:dev -- --origin "$(pnpm -s terraform -- --root dev output -raw app_origin)" \
  --alb-dns-name "$(pnpm -s terraform -- --root dev output -raw alb_dns_name)"
```

項目ごとに PASS / FAIL を表示し、1 つでも FAIL なら終了コード 1 で終わります。検査の項目と、検査
しないものは `docs/design.md` の「Deployed Smoke Test」にあります。

### Cognito のユーザーを作ってサインインする

User Pool は自己登録を受け付けない（管理者だけがユーザーを作れる）設定で、ログイン名はメール
アドレス、パスワードは 14 文字以上で大文字・小文字・数字・記号をすべて含む必要があります。招待
メールを送らずにユーザーを作り、最初から使えるパスワードを設定します（zsh の書き方です）。

```sh
ISSUER="$(pnpm -s terraform -- --root dev output -raw oidc_issuer)"
USER_POOL_ID="${ISSUER##*/}"
EMAIL="you@example.com"

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

read -rs "PASSWORD?Password: "; echo
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --password "$PASSWORD" \
  --permanent
unset PASSWORD
```

- `email_verified=true` にするのは、アプリが確認済みのメールアドレスだけをプロフィールに取り込むため。
- `--password` に渡した値は、コマンドの実行中だけ同じマシンの他のプロセスから見え得ます。避けたい
  場合は `admin-set-user-password` を省き、`admin-create-user` に `--message-action SUPPRESS` の代わりに
  `--temporary-password` を渡して、初回ログイン時に Cognito の画面でパスワードを決めます。
- 実行する認証情報には `cognito-idp:AdminCreateUser` と `cognito-idp:AdminSetUserPassword` の権限が要ります。
- AWS CLI の既定のリージョンが dev の `aws_region` と違う場合は、各コマンドに `--region` を付けます。

`<app_origin>/projects` を開き、**Sign in** からこのメールアドレスとパスワードでサインインします。
ユーザーを消すときは `aws cognito-idp admin-delete-user --user-pool-id "$USER_POOL_ID" --username "$EMAIL"`
を使います。

## マイグレーションが失敗したとき

マイグレーションは ECS タスクが起動するたびに sidecar として走ります。失敗すると migration
コンテナが終了コード 1 で終わり、API コンテナは起動しません。ロック待ちで失敗した（`55P03`）
ときは、runner がそのトランザクションを 1・2・4・8 秒の間隔で最大 5 回まで実行し直してから
止まります。

| メッセージ                                                            | 原因                                                                         | 対処                                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Database migration could not acquire a table lock after 5 attempts.` | 旧タスクのクエリなどとテーブルロックを取り合い、再試行を使い切った           | DB が落ち着いてから再デプロイする                                                                                     |
| `Database migration exceeded its statement timeout.`                  | 1 文が 5 分を超えた                                                          | その処理を通常のデプロイから分ける（`docs/development.md` の「マイグレーションを書く」）                              |
| `Database migration waited too long for another migrator to finish.`  | 先行の migrator が「未適用の本数 × 10 分」（最低 10 分）を超えても終わらない | 先行のタスクが固まっている。そのタスクを止めるか、`pg_terminate_backend` で先行のセッションを切ってから再デプロイする |

## ログの見方

API は stdout へ JSON を 1 行ずつ出し、ECS では CloudWatch Logs に届きます。アクセスログは
出しません。調べるときは `message` で絞ります。

| `message`                    | `level` | 出る場面                                                                                                                                                                 |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unexpected error`           | `error` | 要求が 500 になった。`requestId` と、トレース有効時は `traceId` が入る                                                                                                   |
| `suppressed error`           | `warn`  | 応答は成功させたが失敗は残した処理。`operation`（例: `auth.session-cleanup`、OIDC の callback の失敗なら `auth.external-login-callback` とその下の理由）で処理を見分ける |
| `database connection closed` | `warn`  | サーバーが DB 接続を切った（再起動、フェイルオーバーなど）。`sqlState`（`25P03`、`57P01` など）で原因を見分ける。API は落ちず、次の要求は新しい接続で動く                |

各フィールドの中身と、何を出さないかは `docs/design.md` の「13. 可観測性」にあります。

起動の失敗（`API startup failed: …`）、停止の失敗（`API shutdown failed: …`）、未捕捉の例外
（`Uncaught exception. …` / `Unhandled rejection. …`）は、JSON ではなくプレーンテキストの 1 行で
stderr に出ます。`message` で絞ると見落とすので、ECS のタスクが止まったときはこの行も確かめて
ください。

## 環境を削除する

`terraform:teardown` は開発環境の保護解除と削除を補助します。Terraform 標準の確認付き
`apply` / `destroy` を使い、保存 plan や独自の確認文字列は管理しません。

```sh
pnpm terraform:teardown -- --root dev unprotect
pnpm terraform:teardown -- --root dev destroy
pnpm terraform:teardown -- --root bootstrap unprotect
pnpm terraform:teardown -- --root bootstrap destroy
```

この補助は **RDS の最終スナップショットを作成せず、S3 のオブジェクトと ECR のイメージも
削除する** 設定で保護を解除します。残すデータがある場合は事前にバックアップしてください。
解除用の変数を普段の `terraform.tfvars` に残さず、途中で削除を取りやめた場合は通常の
`apply` で保護を戻してください。

bootstrap の保護解除・削除の前に `dev state pull` で確認し、リソースが残っていれば停止します。
dev のリソースが残っている間に state 保存先の S3 を消さないためです。dev の backend を
初期化してから使ってください。

- state が未作成、または resources が空の場合は撤去へ進みます。
- 取得に失敗した場合や応答が不正な場合は停止し、対象 root と再確認用の
  `pnpm terraform -- --root dev state list` を表示します。内部で捕捉した state や診断は
  自動表示しません。backend の初期化と AWS の認証・権限を確認してください。
- cleanup も失敗した場合は、元の失敗と cleanup の失敗を併記します。

認証期限の独自制限や自動ロールバックはありません。失敗・中断時は Terraform の診断と state を
確認し、認証を更新して必要な操作を再実行します。

削除順序の検査はこの補助コマンドに限ります。`pnpm terraform -- --root bootstrap destroy`
など標準コマンドを直接使う場合は、操作者が順序を管理します。
