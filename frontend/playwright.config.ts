import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;
const reuseExistingServer = process.env.PW_REUSE_EXISTING === "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: isCI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command:
        "SHIMLAYER_REPOSITORY=inmemory SHIMLAYER_ADMIN_API_KEY=dev-admin-key SHIMLAYER_CORS_ORIGINS=http://127.0.0.1:4173,http://localhost:4173 python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000",
      url: "http://127.0.0.1:8000/v1/healthz",
      reuseExistingServer,
      cwd: "..",
      timeout: 120_000
    },
    {
      command:
        "VITE_API_URL=http://127.0.0.1:8000 VITE_API_KEY=e2e-key VITE_ADMIN_KEY=dev-admin-key VITE_ADMIN_ROLE=admin VITE_ADMIN_USER=e2e-admin npm run dev -- --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer,
      timeout: 120_000
    }
  ]
});
