# hono-starter-kit

この文書は、コードにある設計とその判断の理由を書きます。計画中で、まだ実装していないものは `docs/roadmap.md` に書きます。

**React + Hono は、認証付きSaaS・業務システム・管理画面・API中心のWebプロダクト**に向いたスターターキットを作りやすい組み合わせです。

ただし、Next.jsのようにフロントエンドの構成が一式決まっているわけではなく、ReactとHonoはいずれも比較的薄いレイヤーです。そのため、スターターキット側でルーティング、データ取得、認証、エラー形式、モジュール境界、デプロイ方式まで標準化することが重要です。React公式もルーティングを必要とする多くのアプリではフレームワークの利用を勧めつつ、Viteなどを使った独自構成も案内しています。そこで今回は、単純な`React + Vite`ではなく、**React RouterのFramework ModeをSPAとして使う構成**を推奨します。([React][1])

# 1. 推奨する全体構成

現在のコードが採用している構成は次のとおりです。フォームライブラリ、外部公開APIのOpenAPI、構造化ログ、非同期処理（SQS）などの未実装の要素は `docs/roadmap.md` にあります。v0.1の受入条件と実装状況は「19. v0.1の実装範囲」に書きます。

| 領域           | 採用                                           |
| -------------- | ---------------------------------------------- |
| UI             | React 19                                       |
| スタイル       | Tailwind CSS 4（ユーティリティファースト）     |
| ビルド         | Vite 8                                         |
| ルーティング   | React Router 8 Framework Mode、SPA設定         |
| サーバー状態   | TanStack Query                                 |
| バリデーション | Zod                                            |
| API            | Hono                                           |
| API契約        | Hono RPC                                       |
| 実行環境       | Node.js 24 LTS                                 |
| DB             | PostgreSQL                                     |
| DBアクセス     | Kysely                                         |
| パッケージ管理 | pnpm workspace                                 |
| テスト         | Vitest、Playwright、PostgreSQL統合テスト       |
| 認証           | Dev Login / OIDC + サーバー側セッション        |
| 可観測性       | OpenTelemetry（Trace）                         |
| インフラ       | Terraform                                      |
| AWS            | S3、CloudFront、ALB、ECS Fargate、RDS、Cognito |
| CI             | GitHub Actions                                 |

現在の公式情報ではReactは19.2、Viteは8が安定版で、Node.jsは24系がLTSです。React Router 8の最低要件はReact 19.2.7以上、Vite 7以上、Node.js 22.22.0以上です。標準のNode.js 24はこの要件を満たします。スターターキットではインストール時の`latest`に任せず、ルートの`pnpm-lock.yaml`と`packageManager`、`devEngines.packageManager`、`engines`で検証済みのパッチバージョンを固定し、RenovateのPull Requestで更新します。([React][2]) ([Vite][21]) ([React Router][22]) ([Node.js][23])

---

# 2. 推奨アーキテクチャ

現在実装済みの縦断スライスは、**軽量なClean/Hexagonal Architecture
（Ports and Adapters）にDDDの一部を組み合わせたDDD-lite**です。Repository
Port、Application Use Case、HTTP/Database Adapter、明示的なComposition Rootを
採用しますが、具体的な必要性がないAggregate、Value Object、Domain Event、汎用
Base Repositoryまでは導入しないため、完全な戦術的DDDではありません。

```text
                           ┌───────────────────┐
                           │ CloudFront        │
                           └──────┬───────┬────┘
                                  │       │
                               /* │       │ /api/* /auth/*
                                  │       │
                        ┌─────────▼─┐   ┌─▼──────────────┐
                        │ S3        │   │ ALB (internal) │
                        │ React SPA │   │ VPC Origin     │
                        └───────────┘   └───────┬────────┘
                                                │
                                        ┌───────▼────────┐     ┌───────────┐
                                        │ Hono API       │────▶│ Cognito   │
                                        │ ECS Fargate    │     │ (OIDC)    │
                                        └───────┬────────┘     └───────────┘
                                                │
                                        ┌───────▼────────┐
                                        │ PostgreSQL     │
                                        │ RDS            │
                                        └────────────────┘
```

Reactの静的ファイルとHono APIを同じCloudFrontドメインに置きます。

Route 53による独自ドメイン、WAF、非同期処理（SQS、Worker、Batch）は未実装です。計画は `docs/roadmap.md` にあります。

```text
https://example.com/          → React
https://example.com/api/*     → Hono
https://example.com/auth/*    → Hono
```

これにより、フロントエンドでは相対URLの`/api`を使用でき、通常はCORS設定が不要になります。Cookieも同一オリジンとして扱いやすくなります。AWSもReact SPAをS3とCloudFrontで配信し、APIを同じCloudFront配下に置く構成を案内しています。([AWS ドキュメント][3])

CloudFrontでは、パスの振り分けだけでなく、Behaviorごとのメソッド、キャッシュ、Origin Request Policyを設計契約として固定します。

| Path Pattern | Origin         | Allowed Methods                              | Cache                               | Originへ転送する値                                     |
| ------------ | -------------- | -------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `/api/*`     | ALB / Hono     | GET、HEAD、OPTIONS、PUT、POST、PATCH、DELETE | `CachingDisabled`                   | 全Query、Session Cookie、`Origin`、必要な`Sec-Fetch-*` |
| `/auth/*`    | ALB / Hono     | GET、HEAD、OPTIONS、PUT、POST、PATCH、DELETE | `CachingDisabled`                   | 全Query、Session Cookie、`Origin`、必要な`Sec-Fetch-*` |
| `/*`         | 非公開S3 + OAC | GET、HEAD                                    | HTMLは短時間、hash assetはimmutable | CookieとQueryは転送しない                              |

CloudFrontのAllowed Methodsは個別メソッドを任意に選ぶ方式ではないため、API/Auth behaviorでは7メソッドすべてを許可し、実際に未対応のメソッドはHonoが405ではなく、どのRouteにも一致しない要求と同じ404（`NOT_FOUND`のProblem）で返します。`/api/*`では認証（と、変更系メソッドならOrigin）の検査が先に効きます。`/auth/callback`の`code`、`state`を含め、API/AuthのQuery StringはすべてALBへ転送します。認証済みGETや`Set-Cookie`を誤って共有キャッシュへ保存しないよう、API/AuthにはCloudFrontの`CachingDisabled`を使用します。([AWS ドキュメント][24])

SPAの直接アクセスを成立させるため、default behaviorのViewer Requestで、拡張子を持たないUIパスを`/index.html`へ書き換えます。このFunctionは`/api/*`と`/auth/*`には関連付けません。これにより`/projects/123`を直接開いた場合もReact Routerへ到達し、存在しない`.js`や画像をHTMLへ書き換える事故も避けます。([AWS ドキュメント][25])

ALBは内部ALB + CloudFront VPC Originとし、CloudFrontを経由しない直接アクセスを許可しません。採用リージョンなどの制約でInternet-facing ALBを使う場合は、CloudFront managed prefix list、CloudFrontだけが付与するSecret Headerの検証、Security Groupを組み合わせてOriginを保護します。([AWS ドキュメント][26])

---

# 3. リポジトリ構成

pnpm workspaceを利用したモノレポにします。pnpmは単一リポジトリ内の複数プロジェクトをWorkspaceとして扱えます。([pnpm][4])

```text
hono-starter-kit/
├── apps/
│   ├── web/                   React Router SPA（Framework Mode、ssr: false）
│   │   ├── app/
│   │   └── e2e/
│   └── api-node/              Node.jsのサーバー、Composition Root、OIDC・OpenTelemetryのAdapter
│       └── src/
├── packages/
│   ├── contracts/             ブラウザへ配布できる公開契約（Zod schema、エラーコード）
│   │   └── src/
│   ├── api-client/            Webが使うHono RPC Client
│   │   └── src/
│   ├── backend/               Hono app・Route・Middleware、Use Case、Port
│   │   └── src/
│   └── database/              Kysely Adapter（Portの実装）とSQL Migration
│       ├── migrations/
│       └── src/
├── docker/                    API imageと開発用imageのDockerfile、RDSのCA bundle
├── infra/
│   └── terraform/
│       ├── bootstrap/         state bucket、ECR、GitHub OIDC用IAM
│       ├── modules/           network、data、ingress、edge、identity、workload
│       └── environments/dev/
├── scripts/                   検証とTerraform実行のTypeScript
├── docs/
│   ├── aws.md
│   ├── configuration.md
│   ├── design.md
│   ├── development.md
│   ├── forking.md
│   └── roadmap.md
├── .github/workflows/
├── compose.yaml
├── pnpm-workspace.yaml
├── package.json
├── renovate.json
├── AGENTS.md
└── README.md
```

`packages/backend/src`は、HTTPの入口とMiddlewareを置く`app/`、機能ごとのUse CaseとPortを置く`modules/`（例: `modules/projects/`）、認証などの横断機能を置く`platform/`に分かれます。RepositoryのPort（`packages/backend/src/modules/projects/project.repository.ts`）はbackendに、そのKysely実装（`packages/database/src/project.repository.kysely.ts`）はdatabaseに置きます。

## パッケージの依存方向

```text
apps/web
    ├── runtime import ──→ packages/api-client
    └── runtime import ──→ packages/contracts

packages/api-client
    ├── runtime import ──→ packages/contracts
    └── type importのみ ─→ packages/backendのPublicAppType

packages/backend
    └── runtime import ──→ packages/contracts

packages/database
    └── type importのみ ─→ packages/backendのPort

apps/api-node（Composition Root）
    ├── runtime import ──→ packages/backend
    └── runtime import ──→ packages/database
```

`packages/database`はbackendのPortを実装し、Hono、Web、`apps/api-node`へ依存しません。PostgreSQL、OIDC Provider、OpenTelemetryのSDKとExporterは外側のAdapterで、`apps/api-node`がそれらを組み立ててbackendへ渡します。

重要なのは、**WebからBackend内部のServiceやRepositoryを直接importさせないこと**です。

`packages/contracts`はブラウザへ配布可能な公開契約だけを持ち、DB、環境変数、Hono Context、Repositoryへ依存させません。`packages/api-client`はビルド済みの型定義を公開し、WebのTypeScript Serverが巨大なBackend型を毎回再計算しないようにします。HonoのバージョンはWorkspace Catalogなどで1つに揃え、TypeScript Project Referencesでビルド順序を固定します。

共有するのは主に以下です。

- APIの入出力型
- バリデーションスキーマ
- エラーコード
- 列挙値

一方、次のものは共有しません。

- DBの行型
- Kyselyのテーブル型
- Repository
- 認証トークン
- 内部ドメインオブジェクト
- サーバー環境変数

「全部TypeScriptだから全部共有する」という設計にすると、フロントエンドとバックエンドの境界が急速に崩れます。

---

# 4. Hono APIの構造

Honoのルートハンドラーには、HTTP処理だけを置きます。

```text
Hono Route
    ↓
Use Case
    ↓
Repository / Unit of Work / External Adapter
```

具体的には以下の責務分担です（Projectsモジュールの場合）。

| ファイル                                               | 責務                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `project.routes.ts`                                    | HTTP、入力検証、ステータスコード、レスポンス、`actor`の受け渡し                |
| `packages/contracts`                                   | Zodスキーマ、API入出力、公開エラーコード                                       |
| `create-project.ts`など（use case 1つにつき1ファイル） | ユースケース、トランザクション、業務判断                                       |
| `project.errors.ts`                                    | ドメインのエラー（`ApplicationError`を継承し、公開エラーコードを`code`で表す） |
| `project.repository.ts`、`project.unit-of-work.ts`     | Repositoryとトランザクションのport                                             |
| `project.repository.memory.ts`                         | テスト用のインメモリ実装                                                       |
| `packages/database`の`project.repository.kysely.ts`    | PostgreSQL実装                                                                 |
| `project.model.ts`                                     | 内部モデル                                                                     |

次のルールを標準化します。

- Honoの`Context`をuse caseやRepositoryへ渡さない。認証済みの利用者は`actor`として引数で渡す
- Routeから直接Kyselyを呼ばない
- RepositoryからHonoのResponseを返さない
- 資源単位の認可（利用者が自分の資源だけを扱えること）はRepositoryのクエリで行う。画面やRouteの確認はUX上の制御で、セキュリティ境界にしない
- トランザクション境界はuse caseに置く（`ProjectUnitOfWork`）
- 外部APIや時刻、ID生成は依存として注入する
- DIコンテナは使わず、ファクトリー関数で明示的に組み立てる

Projectsのuse caseはすべて`actor`を受け取り、Repositoryはすべてのクエリを`owner_user_id = actor.userId`で絞ります。一覧はSQLで絞るしかないので、取得と更新も同じ場所にそろえ、所有者の判定をRepositoryのクエリ1か所にしています。他人のProjectは「存在しない」ときと同じく`PROJECT_NOT_FOUND`（404）になり、アーカイブ済みやversion不一致の判定にも届かないので、状態を漏らしません。ロールによる検査（RBAC）はまだありません。v0.2で`project.policy.ts`と`FORBIDDEN`として足す計画です（`docs/roadmap.md`の「Projects Standard Extension」）。

組み立ては`apps/api-node/src/composition-root.ts`で行います。

```ts
// repository と unitOfWork は runtime-composition.ts が PostgreSQL か fixture の実装を渡す。
createApp({
  createProject: createCreateProject({ clock, generateId, unitOfWork }),
  updateProject: createUpdateProject({ clock, unitOfWork }),
  listProjects: createListProjects(repository),
  // ...
});

// project.routes.ts
const project = await updateProject({
  ...context.req.valid("json"),
  actor: context.get("actor"),
  id: context.req.valid("param").projectId,
});
```

use caseはHonoに依存しない関数なので、HTTP以外の入口を足すときも同じuse caseを呼べます。

---

# 5. Hono RPCによる型共有

ReactとHonoを同じモノレポで管理する最大の利点は、Hono RPCを使ってAPI型を共有できることです。

```ts
const projectRoutes = new Hono<AppEnv>()
  .get("/", listProjectsHandler)
  .post("/", createProjectValidator, createProjectHandler);

export const app = new Hono<AppEnv>().route("/api/projects", projectRoutes);

export type AppType = typeof app;
```

クライアント側は次のようにします。

```ts
import { hc } from "hono/client";
import type { PublicAppType } from "@starter/backend/app-type";

export const createRpcClient = ({
  baseUrl,
  fetch: fetchImpl,
}: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
}) =>
  hc<PublicAppType>(baseUrl, {
    fetch: fetchImpl,
    init: { credentials: "same-origin" },
  });
```

型共有の方針は次のとおりです。

- **リクエスト**は`hc`とzValidatorで、サーバー定義と照合します。`hc`が独自に守るのは、パス・メソッド・パスパラメータ名の誤りをコンパイル時に見つけることです。JSON本文は、サーバーのvalidatorとapi-clientの入力型が同じ`packages/contracts`のスキーマから来るため、`hc`による照合は実質的な上乗せになりません。
- **応答**は`hc`の推論型ではなく、`packages/contracts`のZodスキーマで実行時に検証した結果を正とします。別バージョンのサーバーや本文を書き換えるプロキシは、推論型では保証できないためです。非2xxは`problemSchema`で検証し、`ApiError`へ正規化します。
- `api-client`が呼ぶエンドポイントは、すべて`hc`経由です。ページ遷移で到達するもの（`/auth/login`など）は`authUrls`でURLを作るだけです。
- `api-client`の公開面はTSDoc付きの明示interfaceで、`hc`の推論型は外に出しません。Route数が増えても公開`.d.ts`とIDEに巨大な推論型を載せないための形です。
- `hc`を残す理由は、Honoスターターとしての手本と一貫性です。安全性の上乗せは上記の早期検出に限られ、同じ誤りはE2Eでも見つかります。
- Cookieは同一オリジンで運ぶため`credentials: "same-origin"`を明示します。RPCの型推論を成立させるには、ルートをチェーンして定義し、クライアントとサーバーの双方でTypeScriptの`strict`を有効にします。([Hono][5])
- グローバルエラーハンドラーやMiddlewareのレスポンス型は、Hono RPCへ自動では追加されません。`PublicAppType`は`AppType`をそのまま公開し、共通エラーの型付けは行いません。Route固有の404（`PROJECT_NOT_FOUND`など）は、use caseが`ApplicationError`を継承したエラーを投げ、`onError`がProblemにします。どのRouteにも一致しない要求は`app.notFound`が`NOT_FOUND`のProblemにします（§9）。

ただし、Reactコンポーネントから直接`hc`を呼び続ける構成にはしません。

```text
React Component
    ↓
Feature Hook
    ↓
TanStack Query
    ↓
api-client
    ↓
Hono RPC（hc）
```

例えば次のようにします（`apps/web/app/features/projects/projects-query.ts`）。`clientLoader`が`ensureQueryData`でQueryを温め、コンポーネントは同じキーを`useQuery`で読みます。

```ts
export const projectsDetailKey = (projectId: string) =>
  ["projects", "detail", projectId] as const;

export const projectsDetailQueryOptions = (
  projectId: string,
  getProject: typeof projectsClient.getProject = (id, options) =>
    projectsClient.getProject(id, options),
) =>
  queryOptions({
    queryKey: projectsDetailKey(projectId),
    queryFn: ({ signal }) => getProject(projectId, { signal }),
  });
```

TanStack Queryはサーバー状態の取得、キャッシュ、再取得、更新処理を担当します。Zustandなどのグローバルストアは、サーバー状態ではなく、複数画面にまたがる純粋なクライアント状態が発生した場合だけ追加します。([TanStack][6])

## OpenAPIとの使い分け

```text
React内部クライアント
    → Hono RPC

外部公開API
モバイルアプリ
他システム連携
    → OpenAPI
```

Honoでは、ZodなどのスキーマからOpenAPIを生成する構成も利用できます。([Hono][7])

したがって、スターターキットでは次のようにします。

- CoreはHono RPC
- `public-api`モジュールを有効にした場合はOpenAPIも生成
- API入出力とDBスキーマを同一視しない
- 公開APIはバージョン管理する

---

# 6. React側の構成

React RouterはFramework Modeを使用し、初期状態ではSSRを無効にします。

```ts
// react-router.config.ts
import type { Config } from "@react-router/dev/config";

export default {
  ssr: false,
} satisfies Config;
```

React RouterのSPA Modeでは、実行時SSRを行わず、ビルド時にSPA用の`index.html`を生成できます。Framework Modeには型付きルートモジュール、コード分割、Loader、Action、スクロール復元、プリレンダリングなどの機能があります。([reactrouter.com][8])

ただし、`ssr: false`は実行時SSRだけを無効にします。root Routeは`index.html`生成時にサーバーレンダリングされるため、初期renderでは`window`などのブラウザ専用APIを参照しません。SPA ModeでもBuild依存として`@react-router/node`を残します。また、通常の`loader`を置けるのは原則としてビルド時に実行されるroot Routeだけです。非root Routeのデータ取得と更新には`clientLoader`、`clientAction`を使います。([reactrouter.com][8])

## Client Loaderの役割

`clientLoader`には何でも入れず、主に次を担当させます。

- 認証済みかの確認
- 必要なQueryのprefetch
- URLパラメーターと検索条件の検証

通常のAPIデータはTanStack Queryを正とします。

`clientLoader`で行う認証確認は、不要な画面を表示しないためのUX上の制御です。セキュリティ境界にはしません。APIは要求ごとにSessionを確かめ、所有者の絞り込みはRepositoryのクエリで行います（§4）。権限による画面の出し分けはありません。他人のProjectはAPIが`PROJECT_NOT_FOUND`（404）で返し、画面はNot Foundとして表示します。ロールによる拒否（`FORBIDDEN`）はv0.2の計画です（`docs/roadmap.md`の「Projects Standard Extension」）。

```text
clientLoader
    ↓
QueryClient.ensureQueryData()
    ↓
Component
    ↓
useQuery()
```

```ts
export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const projectId = projectIdSchema.parse(params.projectId);
  return queryClient.ensureQueryData(projectsDetailQueryOptions(projectId));
}
```

## UIとして最初から用意する状態

- Loading
- Empty
- Error
- Not Found
- Form submitting
- Optimistic update failure
- Session expired

単なるCRUD画面だけでなく、実際の運用で必要になる失敗状態もサンプルに含めます。Forbidden、Maintenance、Network offline、Partial data failureの状態はまだありません。計画は`docs/roadmap.md`の「画面の追加の状態」にあります。

## 環境別設定

Viteの`VITE_*`へAPI URLを埋め込む構成は避けます。

```ts
const apiBaseUrl = "/api";
```

同一オリジンの相対URLを使うので、API URLは成果物に埋め込まれず、同じ成果物をどの環境にも置けます。

現在の環境はdevだけです。`pnpm release:web`がHEADから手元でwebをbuildし、`apps/web/build/client`をweb bucketへ置きます。hash付きassetは`Cache-Control: public,max-age=31536000,immutable`で先に置き（古いassetは消しません）、`index.html`は`no-cache`で最後に置きます。CloudFront Invalidationは、`--distribution-id`を渡したときだけ`/index.html`に対して行います。

環境ごとに変わる公開設定を実行時に取得する`GET /api/runtime-config`と、CIで一度だけbuildした同一artifactをdev、stg、prodへ昇格する運用は未実装です。計画は`docs/roadmap.md`にあります。

---

# 7. DBアクセス

標準はPostgreSQL + Kyselyを推奨します。

KyselyはTypeScript向けの型安全なSQLクエリビルダーで、ORMとしてDB操作を大幅に抽象化するより、SQLの構造を比較的明示的に保てます。([kysely.dev][9])

```ts
const row = await db
  .selectFrom("projects")
  .select(projectColumns)
  .where("id", "=", input.id)
  .where("owner_user_id", "=", input.ownerUserId)
  .executeTakeFirst();
```

標準ルールは以下です。

- マイグレーションはSQLファイルで管理
- API起動時に自動マイグレーションしない（起動時は適用状態を検査するだけ）
- マイグレーションはAPIタスクに同梱したmigrationコンテナで流す（§14B）
- DB型をそのままAPIレスポンスにしない
- 更新系はUse Caseが`ProjectUnitOfWork`を通してトランザクションを張る
- 所有者などの絞り込み条件（今は`ownerUserId`）はRepositoryの引数として必須にする
- 複雑なSQLを無理にRepository汎用メソッドへ押し込まない
- `BaseRepository<T>`のような抽象化を作らない

ECSの水平スケールとRolling Deploy時の新旧Task重複を含め、DB Connection Budgetを先に決めます。

```text
最大接続見積り = API最大Task数 × API pool上限
               + Worker最大Task数 × Worker pool上限
               + Migration / Batch / 運用接続
               + Deploy重複分
```

現在の値は、APIのpool上限が1タスクあたり5本、migrationコンテナが1本です。`desired_count = 1`なので、Deploy重複を含めても十数本に収まります。

この合計をRDSの`max_connections`より十分小さく保ちます。Task数が大きい、Connection burstが激しい、Failover時の接続集中が問題になる場合はRDS ProxyをStandard Moduleとして追加します。([AWS ドキュメント][28])

接続とクエリには上限を付けます。値は配備構成（CloudFrontのorigin read timeout、Secrets Manager、RDSの規模）から決まるので、`apps/api-node/src/database-session-policy.ts`に置きます。`packages/database`は`DatabaseSessionPolicy`の型と、pgの設定への写像だけを持ちます。

| 項目                                  | API  | migrate / seed CLI | 理由                                                                                                                                                     |
| ------------------------------------- | ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pool上限                              | 5    | 1                  | DB Connection Budget                                                                                                                                     |
| `connectionTimeoutMillis`             | 5秒  | 10秒               | TCP・TLS・認証・Secrets Managerからのpassword取得・pool の空き待ちをまとめて打ち切る。未指定だとOSのkeepalive（約2時間）まで止まりうる                   |
| `idleTimeoutMillis`                   | 5分  | 10秒               | 接続を張るたびにSecrets Managerを呼ぶので、低トラフィック時の再接続を減らす                                                                              |
| `statement_timeout`                   | 15秒 | なし               | CloudFrontのorigin read timeout（既定30秒）より前にDB側で止め、詰まったクエリが5本の接続を塞ぎ続けないようにする。migrationはrunnerが1本ずつ上限を付ける |
| `idle_in_transaction_session_timeout` | 30秒 | なし               | rollbackし損ねたトランザクションが行ロックを持ったまま残るのを断つ                                                                                       |

長いクエリは、トランザクション内の`SET LOCAL statement_timeout`で個別に延ばします（`docs/development.md`の「長いクエリ」）。

pg-poolは貸し出し中のclientからidle用のerrorリスナーを外し、Kyselyも付けません。そのままでは、`idle_in_transaction_session_timeout`の発火、RDSの再起動やフェイルオーバー、`pg_terminate_backend`でサーバーが接続を切ると、`uncaughtException`でAPIプロセスごと落ちます。`createDatabaseResources`は`pool.on("connect")`ですべてのclientにerrorリスナーを付けます。APIでは、そのリスナーが§13の要約（`summarizeError`）を通したJSONの1行（`level: "warn"`、`message: "database connection closed"`）を書き、`sqlState`（25P03、57P01など）で原因を見分けられるようにします。接続先を含むドライバのmessageは出しません。切れたclientはrelease時にpoolから外れ、次のリクエストは新しい接続で動きます。

構造化モードのpasswordは、新しい接続を張るたびにSecrets Managerから`AWSCURRENT`を取得します。値はキャッシュせず、取得に失敗したときに前回の値を使うこともしません。SDKのclientはプロセスで1つだけ作って使い回し（認証情報とkeep-aliveの接続をclientが持つため）、DBを閉じたあとに`destroy()`します。migrateとseedのCLIも同じです。

Cloudflare D1などを主対象にする別プロファイルでは、Drizzleへ切り替える余地を残します。DrizzleはPostgreSQLを含むDB接続とマイグレーション管理を提供しています。([Drizzle ORM][10])

---

# 8. 認証・認可

React SPAであっても、ブラウザへアクセストークンを直接保持させないBFF寄りの構成を標準にします。

```text
Dev Login / OIDC Adapter
        ↓
VerifiedIdentity
        ↓
Application Session (PostgreSQL)
        ↓
Actor
```

v0.1aでは、この境界のDev Login、PostgreSQLのApplication Session、Actorを使う
認証Middlewareを実装済みです。v0.1bでは、Provider-neutralなExternal Login Portと
Use Case、PostgreSQLのone-time transaction Adapter、`apps/api-node`が所有する
`openid-client` Adapterを追加しました。Provider固有の処理を境界の外側に閉じ込め、
検証済みの`VerifiedIdentity`だけを共通のSession確立Use Caseへ渡します。これにより、
KeycloakやCognitoへ切り替えても、Application Session、Browser Cookie、認証済み
Request、Projectsの実装は維持できます。

`VerifiedIdentity`のoptional profileはBackend所有のFactoryで公開User契約に照らして
正規化します。`email_verified === true`でもemail形式が不正な場合や、display nameが
空の場合は、そのoptional fieldだけを省略してログインを継続します。Identity解決キーは
引き続き`(issuer, subject)`だけです。

現在のHonoエンドポイントは次のとおりです。

```text
GET  /auth/login
GET  /auth/callback       (OIDC mode only)
POST /auth/logout
GET  /auth/provider-logout
GET  /api/me
```

OIDC AdapterはAuthorization Code Flow + PKCE S256を実装します。既定はpublic clientで、
任意の`OIDC_CLIENT_SECRET`を設定したときだけToken Endpointへ`client_secret_basic`で
クライアント認証します（PKCEは併用）。secretは前後に空白・改行があれば起動時に拒否し、
ログやtraceには出しません。実IdP（Entra ID、Cognitoなど）に対するconfidential clientの
動作は未検証です。ログイン開始時に、推測不能で一回限りの
`state`、`nonce`、`code_verifier`を生成します。PostgreSQLへ保存するのはそれぞれの
SHA-256 hash、検証済みの相対遷移先、作成・失効時刻だけです。rawのnonceと
`code_verifier`は短命なHttpOnly Cookieに保持し、rawの`state`はProviderとの
request/callback round tripでのみ使います。Callbackでは次をすべて確認してから
ログインを成立させます。

- `state`が一致し、未使用で、有効期限内である
- PKCEの`code_verifier`をToken Endpointへ提示する
- ID Tokenの署名、`iss`、`aud`、`exp`、`nonce`を確認する
- Redirect URIはIdPへ事前登録した完全一致のURIだけを使う
- ログイン後の遷移先は検証済みの同一オリジン相対パスに限定し、`/auth`とその配下を除外する
- 認証成功時に既存Session IDを破棄して新しいIDを発行する

OIDC login transactionとSessionは別テーブルにし、`state`やSession IDは平文で保存せずhash化します。IdPのAccess TokenやRefresh Tokenが不要なら保存しません。外部Resource Server呼び出しのため保存する場合はKMSで保護した鍵によるenvelope encryption、最小scope、Refresh Token rotationを追加要件とします。([OAuth Security BCP][27])

productionのlogin transaction Cookieは
`__Secure-oidc-transaction; HttpOnly; Secure; SameSite=Lax;
Path=/auth/callback`です。Application Session CookieとはPathと寿命を分離し、Callbackの
成功・失敗を問わず同じ属性で削除します。OIDC discovery、JWKS、Token requestには
5秒のtotal deadlineを設定し、Provider tokenをAdapter外やApplication Sessionへ渡しません。

ログイン完了後、HonoはランダムなセッションIDをCookieへ設定します。

```text
Name=__Host-session
HttpOnly
Secure
SameSite=Lax
Path=/
Domain属性なし
```

これはHTTPSを使うproductionの契約です。plain HTTPのdevelopment/testでは、
`__Host-` Prefixと`Secure`属性を使用できないため、Cookie名を`session`とし、
`Secure`だけを外します。`HttpOnly`、`SameSite=Lax`、`Path=/`、Domain属性なしは
維持します。

WebのSign outは、まず`POST /auth/logout`でApplication Sessionを失効し、Query cacheを
消去してから固定の`GET /auth/provider-logout`へtop-level navigationします。OIDC時は
事前設定されたProvider logout URLへ、Dev Auth時は`/login`へ303 redirectします。API
responseやquery stringからlogout redirect先を受け取りません。非secret環境変数
`OIDC_LOGOUT_REDIRECT_PARAMETER`は`logout_uri`（default、Cognito）または
`post_logout_redirect_uri`（Keycloak / standard RP-Initiated Logout）だけを受け付けます。
どちらの方式でもpublic `client_id`と固定の`<APP_ORIGIN>/login`を送ります。

セッション本体はPostgreSQLへ保存します。

```text
sessions
├── id_hash
├── user_id
├── absolute_expires_at
├── idle_expires_at
├── created_at
├── last_accessed_at
├── revoked_at
└── provider_session_id
```

Sessionにはabsolute timeoutとidle timeoutの両方を設けます。`last_accessed_at`は毎Requestで更新せず、一定間隔にまとめて不要なDB writeを抑えます。ログアウト時はローカルSessionを必ず失効し、要件に応じてIdPのRP-Initiated LogoutやBack-Channel Logoutを追加します。

ログアウトと再ログイン時の前Sessionの失効は、`revoked_at`を埋めずにsession行を削除します。
さらに、Session確立に成功した後、idle期限（`idle_expires_at <= now`）を過ぎたSessionを
期限の古い順に最大100行削除します。idle期限は絶対期限より後にならない（CHECK制約）ので、絶対期限切れの行も
これで消えます。削除は既存の部分index `sessions_active_expiry_idx`を使い、
`for update skip locked`で同時のログインどうしが行ロックを待たないようにします。スケジューラは
使いません。掃除の失敗ではログインを止めず、`operation: "auth.session-cleanup"`のwarnログ
として1行記録します。`revoked_at`列は、落とすmigrationを足していないので残っています
（部分index `sessions_active_expiry_idx`の条件も`revoked_at is null`のままです）。値の入った行は認証で
拒否します。

認証後はHonoのMiddlewareが次の情報をContextへ設定します。

```ts
type Actor = {
  userId: string;
  roles: string[];
};
```

`tenantId`はまだありません。Tenant境界はv0.2で足す計画です（`docs/roadmap.md`）。`roles`はDev IdentityとOIDCのどちらでも設定されますが、今はどの判断にも使っていません（OIDCでは空です）。

Hono ContextをUse Caseへ直接渡さず、必要なActor情報だけを引数として渡します。

```ts
await updateProject({ actor, id, name, version });
```

Projectsでは、各利用者は自分が作成したProjectだけを読み書きできます。所有者はRepositoryのクエリで絞り、他人のProjectは存在しないProjectと同じ`PROJECT_NOT_FOUND`（404）になります（§4）。これは資源単位の認可の型を示すためのもので、チームで共有するアプリにforkするなら、Repositoryの絞り込み条件を共有の規則に置き換えます。

HonoにはCookie Helper、Secure Headers、CSRF Middlewareなどがあります。CSRF Middlewareはunsafe methodのうちHTMLフォームから送信できるContent-Typeを対象にOriginと`Sec-Fetch-Site`を確認するため、スターターキットではJSON更新APIも含めてOriginを確認する追加Middlewareを用意します。unsafe methodで`Origin`を確認できないRequestは原則拒否し、ブラウザ以外のクライアントを許可する場合は別の認証方式またはCSRF Tokenを要求します。([Hono][11])

ローカル開発用の簡易ログインは実装済みですが、`AUTH_PROVIDER=dev`を
`NODE_ENV=production`で指定した場合は起動時エラーになります。productionで匿名や
Dev IdentityへFallbackする経路はありません。

---

# 9. エラー形式

APIエラーを全モジュールで統一します。

形式はRFC 9457のProblem Detailsを基礎とし、`Content-Type: application/problem+json`で返します。`type`は安定した識別URI、`code`はクライアント分岐に使う安定した機械可読コードとします。([RFC 9457][30])

```json
{
  "type": "https://starter.local/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "code": "VALIDATION_ERROR",
  "requestId": "0198...",
  "instance": "/api/projects",
  "fieldErrors": {
    "name": ["Project name is required."]
  }
}
```

分類は HTTP status で表し、`code` はクライアントが分岐に使う粒度で付けます。同じ 409 でも、Web は `PROJECT_ARCHIVED` と `PROJECT_VERSION_CONFLICT` で表示する文言と入力の下書きの扱いを変えるため、別のコードにしています。

今あるコードは次の 2 種類です。

| 種類                                          | コード                     | status |
| --------------------------------------------- | -------------------------- | ------ |
| プラットフォーム（どの API からでも返り得る） | `VALIDATION_ERROR`         | 400    |
|                                               | `UNAUTHENTICATED`          | 401    |
|                                               | `ORIGIN_NOT_ALLOWED`       | 403    |
|                                               | `NOT_FOUND`                | 404    |
|                                               | `PAYLOAD_TOO_LARGE`        | 413    |
|                                               | `INTERNAL_ERROR`           | 500    |
| モジュール固有（`<MODULE>_<REASON>` の形）    | `PROJECT_NOT_FOUND`        | 404    |
|                                               | `PROJECT_ARCHIVED`         | 409    |
|                                               | `PROJECT_VERSION_CONFLICT` | 409    |

`NOT_FOUND` は、要求したパスやメソッドに対応する API がないことを表します。特定の資源が見つからないことはモジュールのコード（`PROJECT_NOT_FOUND`）で表し、`NOT_FOUND` とは分けます。

`FORBIDDEN`、`CONFLICT`、`RATE_LIMITED`、`EXTERNAL_SERVICE_ERROR` は、今はありません。`FORBIDDEN`、`RATE_LIMITED`、`EXTERNAL_SERVICE_ERROR` は、発行する箇所ができた時点でプラットフォームのコードに足します。発行元のないコードは登録しません。登録すると、画面の網羅分岐に到達しない文言が増えるためです。

Problem を返すのは次の 5 か所です。

- Hono のグローバルエラーハンドラー（`onError`）。ドメインのエラーと、壊れた JSON 本文（`VALIDATION_ERROR`）と、それ以外の例外（`INTERNAL_ERROR`）
- `app.notFound`。どのルートにも一致しない要求とメソッド違い（`NOT_FOUND`）
- `bodyLimit` の `onError`。100 KiB を超える本文（`PAYLOAD_TOO_LARGE`）
- 認証と Origin の middleware（`UNAUTHENTICATED`、`ORIGIN_NOT_ALLOWED`）
- 入力検証の hook（`VALIDATION_ERROR`）

内部例外や SQL エラーは `onError` で `INTERNAL_ERROR` に変換し、`message` や `cause` はクライアントへ返しません。

コードと status の持ち場所は次のとおりです。

- `type` の URI は `packages/contracts` が持ちます。プラットフォームのコードは `errors/problem.contract.ts` の `platformProblemTypes`、Projects のコードは `projects/project.contract.ts` の `projectProblemTypes` です。`errors/problem-registry.ts` がこれらを合成し、`problemTypes`、`ProblemCode`、`isKnownProblemCode` を出します。合成を `problem.contract.ts` で行わないのは、`errors → projects → errors` の循環 import を避けるためです。
- HTTP status と title は、`packages/backend/src/app/problem.ts` の表 `problemCatalog` が持ちます。`satisfies Record<ProblemCode, …>` なので、契約のコードの書き忘れも、契約にないコードの登録もコンパイルエラーになります。応答は `problemResponse` で組み立て、`Content-Type` もここで付けます。
- ドメインのエラーは `packages/backend/src/platform/errors/application-error.ts` の `ApplicationError` を継承し、`code`（と、入力検証なら `fieldErrors`）だけを持ちます。use case は HTTP を知らないので、status は持たせません。ドメインのコードが契約に含まれることは、backend の型テストで確かめます。
- `onError` でドメインのエラーを Problem にする分岐は、`ApplicationError` で契約にあるコードを持つものを扱う 1 つだけです。モジュールを足しても、この分岐は変えません。契約にないコードや、`code` を持つ別のエラー（pg の SQLSTATE など）は `INTERNAL_ERROR` に落ちます。ほかに、壊れた JSON 本文で Hono の validator が投げる `HTTPException`（400、`Malformed JSON in request body`）を `VALIDATION_ERROR` にする分岐があります。

画面は、自モジュールの API が返し得るコード（Projects なら `ProjectProblemCode` = プラットフォームのコード + `PROJECT_*`）を網羅 switch で扱います。プラットフォームのコードが増えると、すべての画面が文言を書くまでコンパイルエラーになります。これは意図した動きです。別モジュールのコードは網羅の対象外で、届いても既定の表示（title と Request ID）に落ちます。

モジュールを足すときは、次の順に編集します（例は `tasks`）。`onError` と既存モジュールの画面は変えません。

1. contracts の `tasks/task.contract.ts` に `taskProblemTypes`（`TASK_<REASON>` の URI）と、`TaskProblemCode`（プラットフォームのコードを含む）、`isTaskProblemCode` を定義し、TSDoc を付ける。
2. `errors/problem-registry.ts` の `problemTypes` に `taskProblemTypes` を合成する。`contracts.test.ts` の、コードが重ならないことを確かめるテストと、URI の完全一致のテストに加える。
3. backend の `problemCatalog` に、コードごとに status と title の行を足す。`problem.test.ts` の wire の表にも同じ値を足す。まだ使っていない status なら、`problem.ts` の `ProblemStatus` にも足す。`PublicAppType` は `AppType` そのもので、非 2xx は api-client が `problemSchema` で実行時に検証するので、`app/app-type.ts` は変えない。
4. ドメインのエラーを `ApplicationError` の継承で書き、`TaskErrorCode` を export して、`problem.test.ts` の型テストで `ProblemCode` に含まれることを確かめる。
5. 画面の網羅 switch は `TaskProblemCode` を対象にし、`isTaskProblemCode` で絞り込む。

成功応答のステータスコードは、Hono RPCの型に載るよう`c.json()`で明示します。([Hono][5])

---

# 10. 非同期処理とバッチ

未実装です。計画は `docs/roadmap.md` へ移しました。

---

# 11. ローカル開発

現在のデフォルトローカルプロファイルは**Docker Compose**です。

```text
Docker Compose
├── PostgreSQL（永続Named Volume）
├── Hono API
└── Vite / React Router Web
```

Viteから`/api`と`/auth`をCompose内部のHono APIへProxyします。

```ts
server: {
  proxy: {
    '/api': 'http://api:3000',
    '/auth': 'http://api:3000',
  },
}
```

そのためローカルでも、本番と同じく同一オリジンに近い形で開発できます。

最初の起動では依存関係をインストールし、明示的にMigrationとSeedを実行してから
3サービスを起動します。

```bash
pnpm install --frozen-lockfile
pnpm db:setup
pnpm dev
```

以後は`pnpm dev`でPostgreSQL、Hono API、Webを起動します。API起動時に
Migrationは自動実行せず、Schema変更後は`pnpm db:migrate`を明示的に
実行します。`pnpm dev:down`はサービスを停止しますがPostgreSQLのNamed
Volumeは削除しないため、開発データは再起動後も残ります。Production API Imageの
OIDC起動とlogin/callbackはowned HTTPS fixtureに対してローカル検証済みです。一方、
AWS Deployment Infrastructure、deployed Cognito/Keycloak連携、deployed smokeは
未検証です。

---

# 12. テスト

## Unit Test

Vitestで以下をテストします。

- Use Case（`modules/projects/create-project.ts`や`platform/auth/establish-session.ts`など）
- ドメインの純粋関数（Project名の正規化など）
- バリデーション（`packages/contracts`のスキーマ）
- ReactのHookや純粋関数

Policyはまだありません（§2で導入しないとしたValue Objectも同じです）。ロールの検査を置く`project.policy.ts`とそのテストは、v0.2の計画です（`docs/roadmap.md`の「Projects Standard Extension」）。

## API Test

Honoは実際のTCPポートを開かずに`app.request()`でテストできます。また、`testClient()`を使うとHonoのルート型を利用した型安全なテストも可能です。([Hono][13])

```ts
const response = await app.request("/api/projects", {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    name: "Example",
  }),
});
```

## DB Integration Test

`pnpm test:db` で、DB統合テスト（`packages/database/src/*.integration.test.ts`）だけを単独で回します。`scripts/test-database.ts` が次の順に進めます。

1. 使い捨てのcompose project（`hono-starter-kit-dbtest-<pid>-<16hex>`）で、`compose.yaml` の `postgres` だけを `POSTGRES_PORT=0` で起動する。イメージの参照はcomposeと自動で一致し、開発用postgresの5432ともぶつからない。
2. ホストからTCPで、最終的な資格情報で `starter` DBに接続できるまで待つ。コンテナ内の `pg_isready` は使わない。postgresのentrypointは初期化中にunix socketだけで待ち受ける一時サーバーを動かすので、その間に準備完了と誤判定することがあるためです。
3. `docker compose -p <project> exec -T postgres createdb` で、一意な名前（`starter_test_<16hex>`）のDBを作る。ポートは経由しない。
4. そのDBを指す `DATABASE_URL` で、ホストのVitestを実行する。
5. 成功・失敗・中断（SIGINT/SIGTERM）のいずれでも、`down -v --remove-orphans` でコンテナ・network・volumeを消し、公開ポートが解放されたことと、projectのラベルが付いたリソースが残っていないことを確かめる。postgresのイメージは共有のキャッシュなので消さない。

`pnpm check:docker` も同じDB名の方式で、compose networkの中の `db-test` からDB統合テストを回します。こちらはcomposeのhealthcheckに頼るので、`createdb` を1秒間隔で最大10回再試行し、再試行で「already exists」が返ったら前の試行が成功していたとみなします。

**開発用DBを消さないためのguard。** 開発用postgresも `127.0.0.1` に同じ資格情報で公開されているので、ホストとポートでは区別できません。区別はDB名が担います。`packages/database/src/database-test-support.ts` は、次がすべて揃わないと接続を開きません。

- `STARTER_DATABASE_TEST_PROJECT` が所有するproject名（`hono-starter-kit-(test|dbtest)-<pid>-<16hex>`）である。
- `STARTER_DATABASE_TEST_NAME` が `starter_test_<16hex>` の形で、`DATABASE_URL` のDB名と一致する。開発用の `starter` はこの形に当てはまらない。
- `DATABASE_URL` のホストとポートが `postgres:5432`（`check:docker`）か `127.0.0.1:<port>`（`test:db`）で、queryもhashも付いていない。

さらに、`drop schema` などの破壊的な文の直前に `select current_database()` がその名前と一致することを確かめます。ポートの解決を誤って開発用postgresに繋いでも、そこにはその名前のDBが無いので、接続の時点で「database does not exist」になり、どの文も実行されません。

テストの分離は次のとおりです。

- テストファイルは同じDBを共有するので、並行には走らせない（`vitest.database.config.ts` の `fileParallelism: false`）。
- public schemaを使うファイルは、テストごとに `beforeEach` でpublic schemaを作り直す。repositoryとtransactionのテスト（projects、auth-sessions、external-login-transactions）は、続けて最新までmigrationを当ててから始める。migrationのテスト（migrations）は、migrationの適用そのものを確かめるので、空のschemaから始める。
- 固有のmigration履歴や行を作るファイル（database-timeouts、auth-session-cleanup）は、public以外の専用schemaで動く。このschemaは `beforeAll` で作り直し、`afterAll` で消す。どちらの操作の前にも `current_database()` を確かめる。
- Transaction rollbackによる分離は使わない。同時実行を確かめるテストが複数の接続を使うので、1つのtransactionに収まらないためです。

対象は以下です。

- Repository（所有者による絞り込みを含む）
- マイグレーション
- 制約
- トランザクション
- 同時更新
- ロック
- NULLの扱い

Tenant境界のテストは、Tenant境界を足すv0.2で加えます（`docs/roadmap.md`）。

## E2E Test

Playwrightで次を確認します。

- ログインと、ログアウト後の保護
- 一覧（Loading、Empty、APIエラーからのRetryを含む）
- 作成
- 更新（楽観的更新の反映と、古いversionでの巻き戻し）
- アーカイブ（サンプルは削除せずアーカイブします）
- 本番CSPでのhydrate（`production.csp.spec.ts`）

セッション切れ（401）でログインへ送る動きは、E2Eではなく`authenticated-layout`や`query-client`などのVitestで確かめます。権限不足（`FORBIDDEN`）とWorkerの処理結果は、それぞれv0.2のRBACとJobsで加えます（`docs/roadmap.md`）。

PlaywrightはChromium、Firefox、WebKitを同じAPIで操作でき、Actionabilityを満たすまで自動待機する機能を持ちます。([Playwright][14])

## Deployed Smoke Test

ローカルのVite Proxyでは検出できないCloudFront、ALB、Cookie、Cache Policyの不整合を、dev環境へのデプロイ後に確認します。

- `/projects/example`への直接アクセスが`index.html`を200で返す
- 存在しない`.js`や画像は`index.html`ではなく404を返す
- `/auth/callback`へQuery Stringが転送される
- POST、PATCH、DELETEがCloudFront経由で到達する
- 異なる2Sessionの`/api/me`が共有キャッシュされない
- SPAとAPIの双方へ期待するSecurity Headerが付与される
- ALBのOriginへInternetから直接アクセスできない

---

# 13. 可観測性

Honoのmiddlewareは次の順序で置いています（`packages/backend/src/app/create-app.ts`）。

```text
requestId             独自（X-Request-Idを検証して引き継ぎ、SERVER spanにrequest.idを付ける）
observeRequest        独自（要求ごとに1回、結果をapi-nodeへ通知する）
bodyLimit             Hono組み込み（100 KiB。超えたら413 PAYLOAD_TOO_LARGE）
authentication        独自（/api/*）
origin                独自（/api/*と/auth/*。書き込みのOriginを確かめる）
onError               app.onError（ドメインのエラーはProblem、それ以外は500 INTERNAL_ERROR）
notFound              app.notFound（404 NOT_FOUND）
```

`bodyLimit`は認証より前に置き、未認証の要求にもセッションの参照より先に上限を効かせます。
HonoのJSON検証も`@hono/node-server`も本文を丸ごと読み、既定の上限を持たないためです。
上限は定数（`requestBodyLimitBytes`）で、環境変数では変えられません。全ルートに先に掛かるので、
これより大きな本文を受けるルートを足すときは、この定数か適用範囲を変える必要があります。

Honoの`secureHeaders`と`timeout`は使いません。

- `secureHeaders`([Hono][15]): AWS Split ProfileではReactのHTMLとassetはS3から返るため、
  Honoの`secureHeaders`はSPAへ適用されません。CloudFrontのdefault behaviorとAPI/Auth behaviorの
  両方にResponse Headers Policyを付け、HSTS、CSP、`X-Content-Type-Options`、frame制御、
  Referrer Policyを付与しています。([AWS ドキュメント][29])
- `timeout`: 応答を先に返すだけで、走っているDBクエリは止めないためです。

本番SPA buildでは、React Routerが生成するinline起動scriptを内容hash付きassetへ外部化し、
CloudFrontの`script-src 'self'`を維持します。外部化したscriptの`async`は除去し、Reactの
hydration対象から読み飛ばされないようにします。`pnpm test:csp`は本番buildと同じCSPを使って
画面の起動と未許可inline scriptの遮断を検証します。

## 想定外エラーの記録

500（`onError`の最後の分岐、またはErrorでない値のthrow）になった要求は、backendの
`observeRequest` portを通してapi-nodeが記録します。backendはOpenTelemetryもログの形式も
知りません。記録はstdoutへのJSON 1行で、ECSでは`awslogs`がCloudWatch Logsへ送ります。

```json
{
  "level": "error",
  "message": "unexpected error",
  "requestId": "0198...",
  "traceId": "abc...",
  "method": "PATCH",
  "route": "/api/projects/:projectId",
  "status": 500,
  "errorName": "TypeError",
  "errorMessage": "Cannot read properties of undefined (reading 'name')",
  "stackFrames": ["at toProjectDto (file:///app/api.mjs:123:45)"]
}
```

- `traceId`はトレースが有効なときだけ入ります。
- `route`はルートのパターンです。生のパス、クエリ、ヘッダは出しません。ハンドラに一致
  しない要求（未知のパス、メソッド違い）では`""`になります。routeは`matchedRoutes`のうち
  `app.use`以外の最後の要素から取るので、認証middlewareの中で起きた500でも本来のハンドラの
  routeが残ります。
- 例外の要約は`apps/api-node/src/error-summary.ts`の1か所で作り、ログとSERVER spanには
  その出力だけを出します（CLIENT spanの例外は下記）。接続先や入力値、IdPの応答を出さないための許可リストです。
  - `errorMessage`は`TypeError`、`RangeError`、`ReferenceError`のときだけ、先頭200文字まで
    入ります。それ以外は型名だけです。接続エラーのmessageは接続先を、`JSON.parse`の
    `SyntaxError`は入力の先頭を含むためです。
  - pgの`DatabaseError`は`errorName`を`"DatabaseError"`に固定し、messageの代わりにSQLSTATEを
    `sqlState`に入れます。
  - `stackFrames`は、stackの先頭からヘッダ（`name: message`）をmessageそのものから求めて
    落とし、残りのうち`/^\s+at /`に一致する行だけです。messageに仕込んだ偽のフレーム行も
    落ちます。ヘッダが今のmessageと合わないときはフレームを捨てます。
  - `cause`、`AggregateError.errors`、その他の任意のプロパティは読みません。
- 404や409のようなドメインのエラーと、401、413は想定内なので記録しません。

同じ要約は、SERVER spanの`exception`イベント（`exception.type`、許可した型だけ
`exception.message`、`exception.stacktrace`）にも付けます。`recordException`はmessageと
stackを無条件に載せるので使いません。本番の送信先（ADOT経由のX-Ray）でこのイベントが例外と
して表示されるかは未検証です。表示されなくても、CloudWatch LogsのJSONからRequest IDで
たどれます。

この要約が掛かるのは、api-nodeが書くログとSERVER spanだけです。`PgInstrumentation`が作る
CLIENT spanは、クエリや接続が失敗するとspanのstatusのmessageにドライバの`message`をそのまま
載せます（`exception`イベントのほうは型名とSQLSTATEだけに伏せられます）。接続先を含み得る
既知の制約で、今は手当てしていません。

応答は成功させるが失敗は残したい処理は、backendの`ReportSuppressedError` portを依存に
受け取ります。api-nodeの`createSuppressedErrorReporter`が同じ要約を`"level": "warn"`、
`"message": "suppressed error"`、呼び出し側の固定文字列`operation`と一緒に1行出します。
use caseは要求の文脈を持たないので`requestId`は入らず、trace有効時の`traceId`だけが入ります。
spanには何も付けません。

アクセスログ（1要求1行）は出しません。トレースを有効にしていればspanで足り、CloudWatch Logsの
取り込み料金を増やさないためです。ALBとCloudFrontのアクセスログも有効にしていません。

## OpenTelemetry

`apps/api-node`は`HttpInstrumentation`と`PgInstrumentation`だけを登録し、トレースだけを
OTLP（`http/protobuf`）で送ります。メトリクスとログはOpenTelemetryでは送りません。

- `HttpInstrumentation`はCommonJSの`require("http")`に掛かって`http.Server.prototype.emit`を
  包みます。ESMで動くランタイム（tsxの開発サーバと、esbuildでESMに束ねた本番のbundle）では
  `http`をrequireする者がいるとは限らないので、SDKの起動後に`http`をCommonJSで1回読み、
  ESMの`@hono/node-server`のserverにも効かせています。
- SERVER spanは`HttpInstrumentation`が作る1つだけです。`observeRequest`がRPC metadataに
  routeを入れるので、spanの名前は`POST /api/projects`のように「メソッド route」になります。
  routeが`""`の要求はメソッドだけの名前になります。
- 受信クエリの値は`url.query`で伏せ、pgはバインド値を載せません。
- ローカルはComposeのJaegerへ、AWSはADOTのsidecar経由でX-Rayへ送ります。
- `pnpm check:docker`は、`traceparent`を付けた要求についてJaegerで「サービスのSERVER spanが
  ちょうど1つ」「`request.id`が付き、trace IDを引き継いでいる」「名前がroute付き」を確かめ
  ます。計装が外れるか、SERVER spanを二重に作るとここで落ちます。

OpenTelemetryのNode.js向けログ機能は公式ドキュメント上でも開発途上とされているため、構造化
ログは独立して出力し、`traceId`で関連付けます。([OpenTelemetry][16])

APIのエンドポイントは`GET /healthz`だけです。ALBのTarget Groupのhealth checkとComposeの
healthcheckが使います。CloudFrontの公開パス（`/api`、`/api/*`、`/auth`、`/auth/*`）には含めず、
外からは呼べません。

---

# 14. デプロイ方式を2種類用意する

## A. Single Container Profile

未実装です。計画は `docs/roadmap.md` へ移しました。現在のデプロイ方式は次のAWS Split Profileだけです。

## B. AWS Split Profile

```text
React → S3 + CloudFront
Hono  → ALB + ECS
```

こちらを通常プロダクト向けの標準とします。

- 静的ファイルはCloudFrontで配信
- APIだけをECSでスケール
- フロントとAPIを個別デプロイ
- `/api/*`はCloudFrontからALBへ転送
- S3はOACで非公開化

AWSはS3オリジンへのアクセス制御にはOACを推奨しています。([AWS ドキュメント][18])

WebとAPIを個別デプロイするため、API変更とDB Schema変更は原則として後方互換にします。

```text
Release N
1. 追加的なDB Migrationを適用する
2. APIへ新フィールド・新エンドポイントを追加してデプロイする
3. Reactの同一artifactを昇格する
4. 旧契約の利用状況を計測する

Release N+1以降
5. 互換期間の終了と利用ゼロを確認する
6. 旧APIと旧DB列・制約を削除する
```

既に開かれているブラウザやRolling Deploy中の旧ECS Taskが残るため、旧API削除と破壊的Migrationは同じReleaseへ含めません。大規模なindex作成やtable rewriteは通常のDeploy Taskから分離します。

Migrationは、ECSタスク定義の`essential = false`のmigrationコンテナとして、**タスクが起動するたびに**走ります。APIコンテナは`dependsOn { condition = "SUCCESS" }`でその完了を待ちます。デプロイでもスケールアウトでも障害からの再起動でも走り、常に旧タスクが本番のトラフィックを捌いている最中に走ります。複数のタスクが同時に起動すれば、migrator同士がadvisory lockを取り合います。ロック戦略はこの前提から決めています（`packages/database/src/migration-runner.ts`）。

- **DDLのロック待ち:** 各migrationのトランザクションで`SET LOCAL lock_timeout = '5s'`と`statement_timeout = '5min'`を設定する。DDLが旧タスクの長いクエリの後ろで`ACCESS EXCLUSIVE`を待ち、その後ろにAPIのクエリが並んでテーブル全体が止まるのを防ぐ。
- **再試行:** DDLの段階で`55P03`（lock timeout）になったときだけ、そのトランザクションを1・2・4・8秒の間隔で最大5回やり直す。旧タスクとの一時的な衝突でデプロイが落ちないようにする。ほかのSQLSTATEは再試行しない。
- **advisory lockの待ち:** 後続のmigratorは、先行が残りを流し切るまで待つ。上限は「lockを取る前に数えた未適用の本数 × 1本あたりの最長時間W（10分）」で、最低10分。Wは、長く走る文1つ（5分）＋ロック待ち（5秒 × ロック取得の回数 × 5回）＋バックオフ15秒の約7分に余裕を持たせた値。上限を`lock_timeout`で付け、lockを取ったらすぐ`reset`する。上限に達したら、DDLの`55P03`とは別の専用メッセージで、再試行せずに失敗する。上限がなければ、先行が接続を保ったまま固まったとき、後続は際限なく待ち続ける（ECSに`startTimeout`がないので、その間デプロイも進まずcircuit breakerも発火しない）。先行の接続が切れているのにサーバーが気づかない場合も、OSのkeepalive（約2時間）までlockが解放されない。
- **前提の保護:** 次のSQLを含むmigrationは、runnerがlockを取る前に拒否する。`statement_timeout`・`lock_timeout`への言及と`RESET ALL`（上限を延ばしたり外したりするとWの前提が崩れる）、トランザクションを制御する文（`BEGIN`・`COMMIT`・`ROLLBACK`・`START TRANSACTION`・`END`など。runnerのトランザクションの外に出ると、55P03の再試行で確定済みの文をもう一度流すことになる）。後者はコメント・文字列・dollar quoteの中を読み飛ばして文の先頭だけを見るので、PL/pgSQLの本体の`BEGIN … END`は拒否しない。長く走る文を1本に複数入れないことは、`docs/development.md`で求めるだけで機械的には検出しない。
- **失敗の見え方:** migrate CLIは、ロック待ちの上限・再試行の使い切り・statement timeoutの3つを固定の英文で出し、ドライバのmessageは出さない。migrationコンテナが終了コード1で終わるとAPIコンテナは起動せず、失敗が続けばdeployment circuit breakerがロールバックする。Rollbackは原則として旧アプリが新Schemaでも動くことによって成立させ、安易なdown migrationへ依存しません。

---

# 15. Honoのマルチランタイム対応

現在の実装はNode.jsだけです。Node.js以外のランタイムへの対応は `docs/roadmap.md` へ移しました。

---

# 16. CI/CD

GitHub Actionsの定義は `.github/workflows/` にあります。**GitHub上ではまだ一度も実行していません。** この節は定義した構成の記述であり、緑になることの確認は、リポジトリをpushして最初のPRとworkflow_dispatchを走らせたときに行います。

## Pull Requestとmainへのpush（`ci.yml`）

次の4ジョブを並行して回します。

```text
check           pnpm check（format・lint・typecheck・dependency-boundary-check・unit-test・build）
e2e             Playwright（pnpm test:e2e と pnpm test:csp）。失敗時はtest-resultsを7日間保存
terraform       pnpm terraform:check（fmt・validate・test。AWS認証は不要）
db-integration  pnpm test:db（runnerのDockerで使い捨てのpostgresを起動し、DB統合テストを回す）
```

- 権限は `contents: read` だけです。`id-token: write` は付けません。AWSには触れません。
- actionはすべてcommit SHAで固定し、`actions/checkout` は `persist-credentials: false` にします。`pull_request_target` と `workflow_run` は使いません。これらは `scripts/github-workflows.test.ts` が固定します。
- Node.jsは `.node-version`、pnpmは `package.json` の `packageManager` から決めます。Corepackは使いません。
- PRの実行は新しいpushで取り消し、mainへのpushは取り消しません。
- `terraform-plan` はPRでは実行しません。実AWSへの認証が要るためです。

## 夜間（`docker-nightly.yml`）

`schedule` と `workflow_dispatch` で `pnpm check:docker` だけを実行します。Docker上のDB・Compose・Terraformの検証で、`ci.yml` とconcurrencyのgroupを分けています。

## 依存の自動更新（`renovate.json`）

`minimumReleaseAge` を必須にし、関係するversionは `terraform`・`pnpm`・`node`・`terraform-providers` のgroupで1つのPRにまとめます。

## 計画中で、まだ無いもの

- `secret-scan`、`container-scan`
- main マージ後のデプロイのパイプライン。ローカルからのrelease手順を別に定めます。
- GitHub ActionsからAWSへのOIDC接続。bootstrapのplan roleとdeploy roleは、`create_github_plan_role` と `create_github_deploy_role` で有効にします。既定は無効で、使うworkflowができるまで作りません。

依存方向の検証は、`scripts/dependency-boundaries.test.ts` とESLintの規則が担います。

---

# 17. Coreと追加モジュール

## Core

スターターキット本体に含まれ、実装済みのものです。

| モジュール      | 内容                                                           |
| --------------- | -------------------------------------------------------------- |
| Config          | 環境変数の検証。不正な値や矛盾する組み合わせは起動時に拒否する |
| Errors          | 統一エラー形式（Problem Details）                              |
| Request ID      | `X-Request-Id`の受け取りと発行、Traceへの付与                  |
| Telemetry       | OpenTelemetry（HTTPとPostgreSQLのTrace）                       |
| Database        | PostgreSQL、Kysely、SQL Migration                              |
| Auth Interface  | Provider非依存の認証Port                                       |
| Dev Auth        | ローカル専用認証                                               |
| OIDC            | Authorization Code + PKCE（Keycloak、Cognito等）               |
| Sessions        | PostgreSQLのサーバー側Session                                  |
| API Client      | Hono RPC                                                       |
| Health          | `/healthz`（ALBのhealth check）                                |
| Sample          | Projects（縦断的な参照実装）                                   |
| Tests           | Unit、API、DB、E2E                                             |
| CI              | GitHub Actions                                                 |
| AI Instructions | `AGENTS.md`                                                    |

未実装のCore（構造化ログ、readiness、Architecture・ADR・Runbookなど）と、Standard Module、Optional Moduleは `docs/roadmap.md` にあります。

---

# 18. サンプル機能

単純なTodoより、`Projects`モジュールを縦断的な参照実装にします。v0.2で計画しているProjects Standard Extension（Tenant境界、RBAC、監査ログ、Outbox、SQS、Worker）は `docs/roadmap.md` にあります。

```text
Projects Core Sample（v0.1）
├── 一覧（作成日時の新しい順）
├── 詳細
├── 作成
├── 更新
├── アーカイブ
├── 所有者による絞り込み
├── 楽観的更新
├── DB Transaction
├── Hono RPC
├── API Test
├── DB Integration Test
└── Playwright E2E
```

各ProjectはSessionの利用者を所有者（`owner_user_id`）として作成され、所有者だけが一覧・取得・更新・アーカイブできます（§4、§8）。

一覧は作成日時の新しい順（`created_at desc, id desc`）です。`id`は同時刻の行の並びを決めるための補助キーです。`created_at`は作成後に変わらないので、Webは書き込み後に一覧のキャッシュを並べ替えません。作成したProjectは先頭に足し、更新・アーカイブ・再取得したProjectはその位置で置き換えます。サーバーの照合順序をクライアントで再現する比較関数を持たずに済み、ヘッダーから一覧に戻ったときも再取得を待たずに正しい順で表示されます。一覧にページングはありません（計画は`docs/roadmap.md`）。

`created_at`と`owner_user_id`はNOT NULLで、defaultを持ちません（`0005_add_project_owner_and_created_at.sql`）。値は常にアプリが入れ、入れ忘れはDBが拒否します。`updated_at >= created_at`もCHECK制約で守ります。既存の行を埋める手順を持たないので、`projects`に行があるDBにはこのmigrationを適用できません。

これを新規モジュール作成時のGolden Pathにします。

```text
新しい機能を追加する
    ↓
Projectsモジュールを参考にする
    ↓
Contract
    ↓
Use Case
    ↓
Repository
    ↓
Route
    ↓
Query Hook
    ↓
UI
    ↓
Tests
```

---

# 19. v0.1の実装範囲

v0.1は次の2 Milestoneに分け、Local Golden Pathを確立してからAWSへ進みます。

## v0.1a Local Golden Path

1. React Router SPAが起動し、非root Routeは`clientLoader`を使う（実装済み）
2. Hono APIがNode.jsで起動する（実装済み）
3. Vite Proxy経由で`/api`へアクセスできる（実装済み）
4. リクエストの型が`hc`でサーバー定義と照合され、応答はcontractsで実行時に検証される（実装済み）
5. PostgreSQLとKyselyが動く（実装済み）
6. SQL Migrationがfresh DBと旧Schemaからのupgradeで動く（実装済み。ただし`0005`は`owner_user_id`と`created_at`を既定値なしの`not null`で足すので、`projects`が空のDBでしか適用できません）
7. Projects Core SampleのCRUDが動く（実装済み）
8. ローカル用ログインとPostgreSQL Sessionが動く（実装済み）
9. Unit、API、DB、E2Eテストが動く（実装済み）
10. OpenTelemetryのTraceがJaegerに表示される（実装済み）
11. Hono APIのDockerイメージを作れる（実装済み）
12. `AGENTS.md`に従った機能追加をdependency-boundary-checkで検証できる（実装済み）

### 実装状況（2026-08-09）

上記12項目はすべて実装済みです。Projects Core Sampleのlist/detail/create/update/archive、確認済みサーバー状態だけを反映するoptimistic UI、PostgreSQL transaction、`0001`から`0002`へのupgrade migration、provider-neutralなLocal AuthとPostgreSQL Session、Jaegerで確認できるHTTP/PostgreSQL Trace、non-root production image、`AGENTS.md`のdependency boundaryをLocal Golden Pathとして検証できます。

Provider-neutral OIDCのローカル実装検証はv0.1bへ移しました。Organizations、RBAC、
AWS deployment、production collectors、deployed identity configurationは引き続き
v0.1b/v0.2の作業です。

## v0.1b AWS Split Profile

1. Provider-neutral OIDC Authorization Code + PKCEのproduction境界をローカル検証できる
2. TerraformでAWS dev環境を作れる
3. 非公開S3 + OAC、CloudFront、内部ALB + VPC Origin、ECS、RDSへデプロイできる
4. `/api/*`、`/auth/*`へCachingDisabledと必要なOrigin Request Policyが設定される
5. SPA deep link rewriteとResponse Headers Policyが設定される
6. API ImageとReact artifactを一度だけBuildして昇格できる
7. Deployed Smoke Testがすべて成功する

GitHub ActionsからAWS OIDCでデプロイすることは、v0.1bの完了条件から外しました。計画は `docs/roadmap.md` にあります。

### OIDC実装状況（2026-08-10）

上記1はローカル検証済みです。Provider-neutralなBackend Port/Use Case、raw protocol値を
保存しないPostgreSQL transaction Adapter、`apps/api-node`に限定した`openid-client` Adapter、
production Cookie、固定Provider logout、local HTTPS fixtureを使うproduction image
login/callbackとredactionを実行可能な受入テストで確認しました。

上記2はローカルのTerraform foundation codeとprovider mock testまで実装しましたが、AWS
dev環境を実際に作成していないため未完了です。上記3〜7のAWS apply、実際の
Cognito/Keycloakなどとのdeployed integration、CloudFront/ALB経由のCookie・Callback・
cache behavior、ECS/delivery workflow、Deployed Smoke Testも未実施です。これらを
ローカルfixtureの成功から検証済みとは扱いません。Organizations/RBAC、監査ログ、
SQS/Worker/Outbox、マルチテナントはv0.2のProjects Standard Extensionです（`docs/roadmap.md`）。

### Terraform の実行と運用（2026-09-08）

個人・小規模開発で保守するため、Terraform の標準機能を中心に構成します。
`scripts/terraform.ts` は digest 固定の公式 Terraform 1.15.8 イメージを `docker run --rm`
で起動し、8つの論理 root を作業ディレクトリーへ対応付けます。サブコマンド・引数・標準の
確認・終了コードを引き継ぎ、host UID/GID で作業中のファイルを直接利用します。
`TF_INPUT=0` を既定にして未設定変数での入力待ちを避け、通常の apply/destroy の確認は残します。
`CHECKPOINT_DISABLE=1` と `AWS_EC2_METADATA_DISABLED=true` も既定とし、明示した環境変数を
優先します。Docker acceptance は AWS/source を隔離し、呼び出し元の Docker context・接続先・
registry 設定を引き継ぎます。
専用 Compose、独自 deploy コマンド、Git clean 制約、ソースの不変 snapshot、plan manifest、
commit binding、plan の自動消費、独自 state backup と STS 残存時間の規則は廃止しました。

Terraform 本体と Provider の version 制約・lock、S3 state locking と versioning は維持します。
bootstrap/dev の必須 `aws_account_id` を Provider の `allowed_account_ids` に渡し、別の認証を
行う S3 backend にも対象アカウントを設定します。ロールは AWS profile と IAM で管理します。
共有 AWS ディレクトリーは read-only mount、環境変数による credentials は mode `0600` の
一時プロファイルで渡し、終了・失敗・中断後に削除します。Docker cleanup は所有ラベルと
完全一致名で対象を限定します。これらはローカル操作者の補助で、IAM の権限境界に代わるもの
ではありません。任意のホストプロセスや編集された Terraform に対する隔離は提供しません。

`terraform:teardown` は `unprotect` と `destroy` の小さな補助です。bootstrap の操作前に
`dev state pull` で確認し、state が未作成、または resources が空の場合だけ先へ進みます。
リソースの残存・取得失敗・不正な応答では停止し、dev の state 保存先を先に削除しないための
手順を保ちます。state 取得失敗時は捕捉した診断を表示せず、対象 root と state list による
再確認コマンドを案内します。cleanup 失敗時も元のエラーと終了コードを保持します。
保護解除は標準の確認付き apply へ変数を渡し、削除は標準の確認付き
destroy へ委ねます。RDS final snapshot は省略し、S3 objects と ECR images も削除するため、
必要なデータは操作者が先に保管します。標準コマンドの直接実行時には、この補助の順序検査は
働きません。保存 plan の apply は Terraform 本来の追加確認なしの動作です。

bootstrap state/IAM、network・data・ingress・edge・identity・workload と dev root の構成は
維持しています。workload は digest 固定の API image、構造化した RDS TLS 設定、migration
成功後の API 起動、trace-only ADOT sidecar、execution/runtime IAM role の分離を維持します。
RDS password はタスク起動時に固定せず、`PGPASSWORD_SECRET_ARN`を使って新規接続ごとに
Secrets Managerの`AWSCURRENT`を取得します。取得失敗時のSDK診断やsecret本文はログに
残しません。idle接続の切断はPoolで処理し、APIプロセスを終了させず再接続を許します。

検証には wrapper の公開 CLI、終了・中断、認証情報受渡し、所有リソースの後片付けのテストと、
8 root の native provider mock test、IAM policy、module 間の配線検査を使います。Docker の
受け入れ検証だけが安全な追跡ソースを一時領域へコピーし、空の AWS ディレクトリーで実行します。
ローカル state / plan は利用でき、Git への追加を検査で拒否します。文章の固定表現や独自
manifest の実装構造を守るテストは保守対象から外しました。

実 AWS の identity / backend / plan / apply / destroy、ECR publication、ECS/RDS/Cognito/
CloudFront/ADOT/X-Ray と deployed smoke は未検証です。ローカル Docker の受け入れ結果で
それらの完了を主張しません。現行の操作手順は `docs/aws.md` を参照してください。

### Corepackへの依存の解消（2026-08-15）

pnpmのバージョン供給をCorepackからpnpm自身へ移しました。Corepackはnode 14.19.0から
25.0.0未満までしかNode.jsに同梱されないため、これに依存している限りNode 26 LTSへ
移行できませんでした。`engines.node`の上限`<25`はこの制約と結びついていたため撤廃し、
`>=24`にしています。

pnpm 11は`packageManager`と`devEngines.packageManager`を自分で読み、宣言された
バージョンへ切り替えます。したがって固定の厳密さは変わりません。ルートmanifestは
`packageManager`に`pnpm@11.15.1`、`devEngines.packageManager`に同じバージョンと
`onFail: download`を宣言し、両者が食い違わないことをテストで固定しています。開発用
imageとAPI imageはCorepackでprepareする代わりに`npm install --global pnpm@11.15.1`で
pnpmを入れます。API imageからはCorepackのshimを解決するためだけに存在していた
`PNPM_HOME`とそのPATH追加も削除しました。

引き換えに、ホストには実体のpnpmがPATH上に必要になります。Corepack経由で起動した
場合は入れ子のpnpmがPATHに現れないため、READMEのクイックスタートに`npm install --global pnpm`を
一度だけ実行する手順を追加しました。入れるバージョンは任意で、以後は宣言した
11.15.1へpnpm自身が切り替えます。npmが実際に入れたパッケージが11.15.0でも、その
バイナリをこのリポジトリ内で実行すると11.15.1を報告することを確認済みです。

`devEngines.packageManager`はnpmも解釈します。npmは自身の名前と一致しない宣言を
見つけるとプロジェクト単位のコマンドを`EBADDEVENGINES`で拒否するため、このリポジトリ
内では`npm ls`のような操作が失敗します。これは意図した効果で、pnpm workspaceに対して
誤って`npm install`を実行し二つ目のlockfileを作る事故を防ぎます。`npm --version`と
`npm install --global`は影響を受けないため、READMEのbootstrap手順は成立します。
両imageの`npm install --global pnpm@11.15.1`もmanifestをCOPYする前に実行されるため
影響を受けません。

この変更はローカルで検証済みです。`pnpm test`、`pnpm lint`、`pnpm build`に加えて
`pnpm check:docker`が完走し、Terraform 8 rootのDocker acceptance、Composeゴールデン
パス、変更後のapi.DockerfileからビルドしたProduction ImageのOIDC flow、非root UID/GID、
root所有CAの保護、各fail-closed拒否まで確認しています。なお`engines.node`の上限を
外したことはNode 26での動作を主張しません。手元にはNode 24.14.0しか無く、Node 25以降
での実行は未検証です。Docker imageは引き続き`node:24.14.0-bookworm-slim`に固定です。

---

# 20. Next.js + Go案との比較

| 観点           | React + Hono             | Next.js + Go                   |
| -------------- | ------------------------ | ------------------------------ |
| 言語           | フルスタックTypeScript   | TypeScript + Go                |
| 初期開発速度   | 高い                     | やや準備が必要                 |
| 型共有         | Hono RPCで容易           | OpenAPI生成が中心              |
| フロント       | SPAが標準                | SSR、RSCを利用可能             |
| API            | 軽量、柔軟               | バックエンドとして独立性が高い |
| 境界管理       | 意識的な制約が必要       | 言語・リポジトリ境界が自然     |
| Worker         | TypeScriptで共有しやすい | Goコードを共有しやすい         |
| SEO            | 別途SSR等を検討          | Next.jsが得意                  |
| デプロイ       | 静的Web + Node API       | Next.js + Goの2サービス        |
| 小規模チーム   | 特に向いている           | やや構成が重い                 |
| 複数専門チーム | 境界設計が重要           | 分業しやすい                   |

React + Hono案が特に合うのは、以下のようなケースです。

- ログイン後が中心のSaaS
- 管理画面
- 業務アプリケーション
- API中心のプロダクト
- 小規模から中規模のチーム
- AIコーディングエージェントを多用する
- フロントとバックエンドをTypeScriptで統一したい
- SSRやReact Server Componentsが必須ではない

一方、公開ページのSEOや動的SSRがプロダクトの中心なら、React + Honoで独自SSR基盤を作るより、Next.jsやReact RouterのSSR構成を使う方が安全です。

---

# 現時点での推奨像

このスターターキットの中心は、次の構成です。

```text
React Router SPA
        │
        ▼
TanStack Query
        │
        ▼
Hono RPC Client
        │
        ▼
Hono Route
        │
        ▼
Use Case
        │
        ▼
Kysely Repository
        │
        ▼
PostgreSQL
```

AWSでは次の形です。

```text
React       → S3 + CloudFront
Hono API    → ECS Fargate
Database    → RDS PostgreSQL
Deploy      → 手元の pnpm terraform（Terraform）と pnpm release:api / pnpm release:web
```

WorkerとBatch（v0.2）は未実装で、計画は`docs/roadmap.md`の「非同期処理とバッチ」にあります。GitHub Actionsからのデプロイは未定です（同「GitHub ActionsからAWS OIDCでデプロイする」）。

叩き台としては、**React Router SPA + Hono Node.js + Hono RPC + PostgreSQL/Kysely + pnpmモノレポ + AWS Split Deployment**を標準経路にするのが、開発速度、型安全性、運用性、将来拡張のバランスがよい構成です。

[1]: https://react.dev/learn/build-a-react-app-from-scratch "Build a React app from Scratch"
[2]: https://react.dev/versions "React Versions"
[3]: https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/deploy-a-react-based-single-page-application-to-amazon-s3-and-cloudfront.html "Deploy a React-based single-page application"
[4]: https://pnpm.io/workspaces "Workspace"
[5]: https://hono.dev/docs/guides/rpc "RPC"
[6]: https://tanstack.com/query/latest/docs/framework/react/guides/does-this-replace-client-state "Does TanStack Query replace client state managers?"
[7]: https://hono.dev/examples/hono-openapi "Hono OpenAPI"
[8]: https://reactrouter.com/how-to/spa "Single Page App (SPA)"
[9]: https://kysely.dev/ "Kysely"
[10]: https://orm.drizzle.team/docs/migrations "Migrations - Drizzle ORM"
[11]: https://hono.dev/docs/middleware/builtin/csrf "CSRF Protection"
[13]: https://hono.dev/docs/helpers/testing "Testing Helper"
[14]: https://playwright.dev/ "Playwright"
[15]: https://hono.dev/docs/middleware/builtin/secure-headers "Secure Headers Middleware"
[16]: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/ "OpenTelemetry Node.js"
[18]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html "Restrict access to an Amazon S3 origin"
[21]: https://vite.dev/blog/announcing-vite8 "Vite 8"
[22]: https://reactrouter.com/upgrading/v7 "Updating from React Router v7"
[23]: https://nodejs.org/en/about/previous-releases "Node.js Releases"
[24]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html "CloudFront custom origin behavior"
[25]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/example_cloudfront_functions_url_rewrite_single_page_apps_section.html "CloudFront SPA URL rewrite"
[26]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html "CloudFront VPC origins"
[27]: https://www.rfc-editor.org/rfc/rfc9700.html "OAuth 2.0 Security Best Current Practice"
[28]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html "Amazon RDS Proxy"
[29]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/modifying-response-headers.html "CloudFront response headers policies"
[30]: https://www.rfc-editor.org/rfc/rfc9457.html "Problem Details for HTTP APIs"
