import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true
  },
  webServer: {
    command: "PORT=3100 HOSTNAME=127.0.0.1 NODE_ENV=development npm run serve",
    port: 3100,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
