import { defineConfig } from "@playwright/test";

const apiKey = "restaurant-os-playwright-e2e-key-2026-0001";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  outputDir: "./test-results/playwright",
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start:e2e",
    url: "http://127.0.0.1:4317/api/health",
    env: { PORT: "4317", ONBOARDING_API_KEY: apiKey },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
