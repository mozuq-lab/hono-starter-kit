# リポジトリ指示書

## アーキテクチャ

このスターターは実用的な DDD-lite を採用し、Clean / Hexagonal の依存方向に従います。
ドメインおよびアプリケーションのポリシーは、モデルとポートに依存します。`packages/backend` は、それらのポートとともに HTTP アダプター（Hono アプリ、ルート、ミドルウェア）を所有します。PostgreSQL / Kysely、アイデンティティプロバイダー、OpenTelemetry、Docker は外側のアダプターであり、`apps/api-node` で組み立てられます。`apps/api-node` はサーバーとそのランタイムも所有します。

## パッケージ境界

- `packages/contracts` は、ブラウザセーフな公開ワイヤ契約です。
- `apps/web` は `packages/api-client` を経由して呼び出します。バックエンドやデータベースのコードを直接 import しません。
- `packages/backend` はアプリケーションの振る舞いとポートを所有します。データベースアダプターを import しません。
- `packages/database` はバックエンドのポートを実装します。Hono や Web のコードに依存しません。
  テスト以外では `@starter/backend` を型としてのみ import します。値の import は lint で拒否されます。
- OpenTelemetry の SDK / exporter / instrumentation コードは `apps/api-node` に属します。
- `apps/api-node` の外で `@opentelemetry/api` を使用できるのは `packages/backend/src/app/request-id.ts` のみです。

## スクリプト

- `scripts/` は、型を除去して `node` が直接実行する TypeScript です。ビルドステップがないため、`scripts/` 内の相対 import には `.ts` 拡張子を付けます — ディスク上に存在するファイル名をそのまま指定する必要があります。コンパイルされるパッケージ側は、`tsc` が `dist` に出力するため、引き続き `.js` で import します。
- `scripts/tsconfig.json` は `erasableSyntaxOnly` を設定しています。`enum`、`namespace`、パラメータープロパティは型除去では実行できないため、実行時ではなくコンパイル時に拒否されます。

## コードコメント

- コメントは日本語で書きます。英語のままにするのは、それが自然な形である場合のみです：ツール指示（`@ts-expect-error`、`@vitest-environment`）、生成ファイル、仕様やエラーメッセージからの引用。
- コードの動作を言い換えないでください。コードだけでは復元できないことのみを書きます：制約が存在する理由、定数の導出方法、防御対象の攻撃や障害モード、削除すると何が壊れるか。
- 説明は名前、エラーメッセージ、テストケース名で表現することを優先します。どれにも載せられない場合にコメントを追加します。
- `packages/contracts` と `packages/api-client` のすべての公開シンボルに TSDoc を付けます。これらは定義ファイルを開くのではなく、呼び出し元でエディタのホバー経由で読まれます。

## データベースと認証

- 順序付きの SQL マイグレーションを追加します。適用済みのマイグレーションは書き換えません。
- API 起動時はマイグレーションの状態を確認しますが、適用は決して行いません。
- `AUTH_PROVIDER=dev` は開発専用であり、本番環境では fail closed（安全側に閉じる）しなければなりません。
- 認証情報、Authorization / Cookie ヘッダー、生セッション、プロバイダートークンをログやトレースに出力しません。

## ドキュメント

- `docs/design.md` は、コードに存在する設計と、それが選ばれた理由を記述します。
- 未実装の計画は `docs/roadmap.md` に置きます。それを実装する変更で `docs/design.md` に移します。
- `README.md` は入口です。概要、クイックスタート、よく使うコマンド、検証済みの範囲、文書の地図だけを書きます。検証状況は README の「検証済みの範囲」に集めます。
- 手順と設定値は読者ごとの文書に書きます。開発は `docs/development.md`、環境変数は `docs/configuration.md`、AWS の運用は `docs/aws.md`、fork は `docs/forking.md` です。
- 1 つの事実は 1 か所にだけ書き、ほかの文書からはリンクします。理由は `docs/design.md`、手順と設定値は上の文書が持ちます。

## テストとデリバリー

- 振る舞いの変更は、失敗するテストから始め、通る最小の変更を実装します。
- リポジトリ全体のチェックの前に、狭い単位 / 境界チェックを実行します。データベースアダプターとマイグレーションの場合、狭いチェックは `pnpm test:db` です。
- Docker 検証では、所有する正確な名前を使い、成功・失敗・中断にかかわらず、コンテナー、ネットワーク、ボリューム、イメージ、公開ポートをクリーンアップします。
- README と `docs/` の文書（`docs/roadmap.md` を除く）は、実行可能な受け入れチェックが通った後にのみ更新します。
