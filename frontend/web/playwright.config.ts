import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true
  },
  webServer: {
    command:
      "NEXT_PUBLIC_HA_BASE_URL=http://ha.local NEXT_PUBLIC_Z2M_BASE_URL=http://z2m.local npm run build && npx next start -H 127.0.0.1 -p 3100",
    port: 3100,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
