# fork するとき

このスターターを fork して自分のアプリにするときに、変える場所と、スターターの変更を後から
取り込むときの注意です。

## 変える場所

| 目的                     | 箇所                                                                        | 備考                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm workspace の名前     | `package.json` の `name`                                                    |                                                                                                                                                                                                                                                                                                    |
| AWS のリソース名の接頭辞 | bootstrap と dev の `terraform.tfvars` の `project`                         | **両 root で同じ値にします。** bootstrap は deploy role の IAM の許可範囲、ECR の名前、state の key を自分の `project` から作るため、dev の値が違うと deploy role での apply が AccessDenied になります。dev の Web 用 S3 bucket 名（`<project>-dev-web`）にも使うので、世界で一意になる値にします |
| state の置き場所         | bootstrap の `state_bucket_name`、dev の `backend.hcl` の `bucket` と `key` | bucket 名は世界で一意にします。`bucket` は `state_bucket_name` と、`key` は bootstrap の IAM が許可する `<project>/dev/terraform.tfstate` とそろえます                                                                                                                                             |
| Cognito の hosted UI     | dev の `domain_prefix`                                                      | 世界で一意にします                                                                                                                                                                                                                                                                                 |
| GitHub OIDC              | bootstrap の `github_owner`、`github_repository`、`github_default_branch`   | plan role と deploy role の信頼条件に使います。role を有効にする条件は `docs/aws.md` の「GitHub Actions 用の role」を参照してください                                                                                                                                                              |
| CI                       | GitHub のリポジトリ設定                                                     | 依存の更新 PR は Renovate の GitHub App をリポジトリに入れたときだけ届きます（`renovate.json` だけでは動きません）。branch protection で `ci.yml` の `check`、`e2e`、`terraform`、`db-integration` を必須にします                                                                                  |

`docker-nightly.yml` のような `schedule` の workflow は、fork では既定で無効です。また GitHub は、
public リポジトリで 60 日間活動がないと `schedule` の workflow を止めます。

dev と bootstrap の `terraform.tfvars` に何を書いても、`pnpm terraform:check` の結果は
変わりません。この2つの root の Terraform テストは、すべての変数をテストファイルの中で
固定しています。

### 変えてもよいもの

Problem の `type` URI の基点 `https://starter.local/problems/` と、Dev ログインの identity の
issuer `urn:starter:dev` も、fork 側の値に変えて構いません。

- `type` URI は `packages/contracts/src/errors/problem.contract.ts` と
  `packages/contracts/src/projects/project.contract.ts` にあります。クライアントは `type` では
  なく `code` で分岐するので、変えても画面は変わりません。URI を完全一致で確かめるテストも
  一緒に変えます。
- `urn:starter:dev` は `packages/backend/src/platform/auth/dev-identity.ts` にあります。変えると
  既存の開発用 DB に seed した Dev identity とは別の identity になるので、`docs/development.md`
  の「開発用 DB を作り直す」の手順で PostgreSQL の volume を作り直してください。関係する
  テストも一緒に変えます。

### 変えなくてよいもの

- Docker 検証の所有ラベルと一時ディレクトリーの名前。
- `@starter/*` のパッケージ scope。
- OpenTelemetry のサービス名 `hono-starter-api`。変える場合は `OTEL_SERVICE_NAME` の既定値
  （`apps/api-node/src/telemetry-config.ts`）、`compose.yaml`、
  `infra/terraform/modules/workload/main.tf`、Jaeger で検索する `scripts/check-docker.ts` と、
  関係するテストを一緒に変えます。`compose.yaml` だけを変えると `pnpm check:docker` が
  落ちます。

## スターターの変更を取り込む

**マイグレーションの番号を確かめてください。** スターターは今後も
`packages/database/migrations/` に番号付きのマイグレーションを足します。fork 側で足した
マイグレーションとスターターのものは、同じ番号になることがあります。同じ番号で名前の違う
マイグレーションが適用済みだと、マイグレーションの実行も API の起動も履歴の食い違いとして
止まります。

データを持つ fork がスターターの `0005_add_project_owner_and_created_at.sql` を取り込むと、
`projects` に行がある限り適用に失敗します。取り込む前に、所有者と作成日時を埋める独自の
マイグレーション（nullable で足す → 埋める → NOT NULL にする）を書いてください。スターターは
この経路を用意していません。

README と `docs/` は fork 側で自由に書き換えて構いません。書き換えた場合、スターターの文書の
変更は取り込まなくても動作に影響しません。
