import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "3010";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 35_000,
  expect: {
    timeout: 8_000,
  },
  reporter: [["list"]],
  outputDir: ".playwright-output",
  use: {
    baseURL,
    browserName: "chromium",
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: `npm run dev -- -p ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: "scaled-desktop",
      use: {
        viewport: { width: 1535, height: 694 },
      },
    },
    {
      name: "desktop",
      use: {
        viewport: { width: 1366, height: 768 },
      },
    },
    {
      name: "tablet",
      use: {
        viewport: { width: 1024, height: 768 },
      },
    },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "mobile-landscape",
      use: {
        viewport: { width: 844, height: 390 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
