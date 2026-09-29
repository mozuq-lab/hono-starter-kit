import { defineConfig, devices } from "@playwright/test";

import { resolveApiPort } from "./e2e/api-process.js";

// API ポートは E2E_API_PORT を単一の情報源とし、dev サーバのプロキシ先と
// ハーネスが起動する API を必ず一致させる。
const apiPort = String(resolveApiPort(process.env));

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/*.csp.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    env: { E2E_API_PORT: apiPort },
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
