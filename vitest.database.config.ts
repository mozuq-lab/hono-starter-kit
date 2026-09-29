import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/database/**/*.integration.test.ts"],
    // どのファイルも同じ DB の public スキーマを作り直し、同じ advisory lock を取り合うので、
    // ファイルを並行に走らせると互いの状態を壊す。
    fileParallelism: false,
    passWithNoTests: false,
    restoreMocks: true,
  },
});
