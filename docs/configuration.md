# 設定（環境変数）

API と migrate / seed の CLI が読む環境変数の一覧です。`pnpm dev` では `compose.yaml` が開発用の値を
設定するので、ローカル開発で設定するものはありません。値の検証に失敗した設定は、どれも起動時に
エラーになります。各設定がなぜそうなっているかは `docs/design.md` にあります。

- [API プロセス](#api-プロセス)
- [データベース](#データベース)
- [認証](#認証)
- [テレメトリー](#テレメトリー)

## API プロセス

| 名前                   | 契約                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | API の待ち受けポート。10進整数で 1 以上 65535 以下。既定は 3000                                                   |
| `HOST`                 | 待ち受けアドレス。`127.0.0.1`（既定）または `0.0.0.0` のみ。ほかの値は拒否します                                  |
| `MIGRATIONS_DIRECTORY` | マイグレーション SQL の置き場所。production イメージは `/app/migrations` を焼き込んであるので、通常は設定しません |

## データベース

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

構造化モードでは `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGSSLROOTCERT` と、
`PGPASSWORD` / `PGPASSWORD_SECRET_ARN` のどちらか一方が必要です。`PG*` のどれか1つでも
設定された状態で `DATABASE_URL` も設定すると、どちらを使うか推測せずに起動を止めます。
構造化モードの TLS はサーバー証明書の検証を必ず有効にします。無効にする設定はありません。

### AWS での値

workload モジュールが ECS タスクへ渡すのは構造化モードです。`PGHOST`、`PGPORT`、
`PGDATABASE`、`PGSSLROOTCERT`（`/app/certs/global-bundle.pem`）は平文の環境変数として
渡します。`PGUSER` はタスク定義の `secrets` 経由で、RDS が管理する
マスターユーザーシークレットから読みます。password は `PGPASSWORD_SECRET_ARN` と
`AWS_REGION` を使い、新規 DB 接続時に `AWSCURRENT` を取得します。タスクを再起動しなくても
RDS の password rotation に追従できます。runtime role の読取権限は対象 secret に限定します。
このシークレットはオペレーターが作るものではありません。

## 認証

`AUTH_PROVIDER=dev` は開発専用です。`NODE_ENV=production` と同時に設定すると、匿名や
開発用の identity にフォールバックせず、API の起動そのものが失敗します。

OIDC を使うには、次の非機密な環境変数を設定します。

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

本番の Cookie の `Max-Age` は、`__Host-session` が `SESSION_ABSOLUTE_TTL_SECONDS`、
`__Secure-oidc-transaction` が `OIDC_LOGIN_TRANSACTION_TTL_SECONDS` と同じ値になります。

IdP に登録する URI は固定です。コールバック URI は `<APP_ORIGIN>/auth/callback`、ログアウト後の
URI は `<APP_ORIGIN>/login` です。平文 HTTP の OIDC はループバックでの開発とテスト
フィクスチャーでしか許可されません。本番はアプリケーション・issuer・ログアウト
エンドポイントのすべてに HTTPS を要求します。

### クライアントシークレット

`OIDC_CLIENT_SECRET` は任意です。設定しなければパブリッククライアント（PKCE だけ）として
動きます。設定すると、token endpoint へ `client_secret_basic` でクライアント認証します。
その場合も PKCE は併用します。

- 値は秘密情報として注入してください。アプリはこの値をログにも trace にも出しません。
- 空の値や、前後に空白・改行がある値は、起動時に設定エラーになります。
- IdP の discovery の `token_endpoint_auth_methods_supported` に `client_secret_basic` が
  載っていない場合は、ログイン開始時に失敗します。
- 同梱の AWS 構成（Cognito）はパブリッククライアントのままで、この変数を配線していません。

## テレメトリー

`NODE_ENV=test` は、他のどのテレメトリー設定より先にテレメトリーを無効化します。本番では、
トレースエクスポーターを省略するか `none` にした場合、`OTEL_EXPORTER_OTLP_ENDPOINT` が
無ければテレメトリーは無効のままです。エンドポイントなしで `otlp` エクスポーターを要求
すると起動に失敗します。対応する OTLP プロトコルは `http/protobuf` だけです。

| 名前                          | 契約                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_TRACES_EXPORTER`        | 省略するとエンドポイントの有無で有効化を判断します。`otlp` にするとエンドポイントを必須にし、`none` にするとテレメトリーを無効化します。それ以外の値は拒否されます      |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | コレクターのベース URL を絶対 HTTP / HTTPS で指定します。指定するとエクスポーターが `none` でない限りテレメトリーが有効になり、ランタイムが `/v1/traces` を付け足します |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | テレメトリーが有効なときは、省略するか `http/protobuf` を指定します。それ以外の値は拒否されます                                                                         |
| `OTEL_SERVICE_NAME`           | テレメトリーが有効なときに使う任意のサービス名。既定は `hono-starter-api` です                                                                                          |
