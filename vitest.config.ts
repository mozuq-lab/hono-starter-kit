import { configDefaults, defineConfig } from "vitest/config";

const collectionExclude = [
  ...configDefaults.exclude,
  "**/build/**",
  "**/dist/**",
  "**/.react-router/**",
  "**/test-results/**",
  "**/playwright-report/**",
  "**/coverage/**",
  "packages/database/**/*.integration.test.ts",
];

const sharedProjectOptions = {
  exclude: collectionExclude,
  passWithNoTests: false,
  restoreMocks: true,
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "apps/api-node/src/**/*.ts",
        "apps/web/app/**/*.{ts,tsx}",
        // e2e ハーネス(プロセスグループへのシグナル送信・ポート解放待ち)も
        // 回帰を検知したい製品コードなので計測対象に含める。
        "apps/web/e2e/**/*.ts",
        "packages/*/src/**/*.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "**/*.test.{ts,tsx}",
        // *.spec.ts は Playwright だけが実行する。Vitest は読み込まないので、
        // 分母に残すと恒久的に 0% の死重となり、ゲートを実際より緩く見せる。
        "**/*.spec.ts",
        // ルート定義・テスト用フィクスチャ・テストセットアップは製品コードではない。
        "apps/api-node/src/fixtures.ts",
        "apps/api-node/src/testing/**",
        "apps/web/app/routes.ts",
        "apps/web/app/test/**",
      ],
      // Playwright 専用の spec を分母から外したあとの実測
      // (statements 90.16 / branches 85.92 / functions 85.95 / lines 90.54)から
      // 数ポイントの余裕を引いた下限。下回ったら CI を落とす。
      // api-process.ts は Playwright 実行時にだけ通る spawn 経路を持つため、
      // ユニットテストだけでは 100% にならない。
      thresholds: {
        statements: 87,
        branches: 82,
        functions: 83,
        lines: 87,
      },
    },
    projects: [
      {
        test: {
          ...sharedProjectOptions,
          name: "web",
          environment: "jsdom",
          include: ["apps/web/app/**/*.test.{ts,tsx}"],
          setupFiles: ["./apps/web/app/test/setup.ts"],
        },
      },
      {
        test: {
          ...sharedProjectOptions,
          name: "node",
          environment: "node",
          include: [
            "apps/api-node/**/*.test.ts",
            "apps/web/e2e/**/*.test.ts",
            "apps/web/*.test.ts",
            "packages/**/*.test.{ts,tsx}",
          ],
        },
      },
    ],
  },
});
