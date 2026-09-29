import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.csp.spec.ts",
  workers: 1,
  use: { ...devices["Desktop Chrome"] },
});
