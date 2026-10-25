import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || "3010"}`;

async function initialize(page: Page, theme: "light" | "dark") {
  await page.context().addCookies([{ name: "cv_access_token", value: "e2e-watermark-token", url: baseURL }]);
  await page.context().grantPermissions(["geolocation"], { origin: baseURL });
  await page.context().setGeolocation({ latitude: 50.4452, longitude: -104.6189, accuracy: 5 });
  await page.addInitScript((mode) => {
    localStorage.setItem("cv_access_token", "e2e-watermark-token");
    localStorage.setItem("cv-theme", mode);
  }, theme);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    let body: unknown = { data: [], items: [], enabled: false, configured: false, showBadge: false };
    if (path.endsWith("/user/me")) body = { _id: "e2e-watermark-owner", username: "Watermark QA", email: "qa@example.test", companyName: "Test Company" };
    else if (path.endsWith("/reports/myreports") || path.endsWith("/notifications")) body = [];
    else if (path.endsWith("/reports/dashboard-analytics")) body = { totals: { reports: 0, lots: 0 }, series: [], leaderboard: { entries: [] } };
    else if (path.endsWith("/location/reverse-geocode")) body = { data: { location: "Regina, Saskatchewan, Canada", currency: "CAD" } };
    await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  return errors;
}

for (const theme of ["light", "dark"] as const) {
  for (const form of [{ title: "Asset Report", path: "asset" }, { title: "Lot Listing", path: "lot-listing" }]) {
    test(`${form.title} watermark defaults off with explicit opt-in (${theme})`, async ({ page }, testInfo) => {
      const errors = await initialize(page, theme);
      await page.goto("/dashboard");
      await expect(page).toHaveTitle(/Asset Insight/i);
      await page.getByRole("button", { name: form.title, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/create/${form.path}$`));
      await expect(page.getByRole("heading", { name: form.title, level: 1 })).toBeVisible();
      const watermark = page.getByRole("checkbox", { name: /Apply watermark/i });
      await expect(watermark).not.toBeChecked();
      const label = watermark.locator("xpath=ancestor::label");
      await label.scrollIntoViewIfNeeded();
      await expect(label).toContainText("Off by default");
      await page.screenshot({ path: `/tmp/assetinsight-watermark-${form.path}-${testInfo.project.name}-${theme}.png` });
      await label.click();
      await expect(watermark).toBeChecked();
      await label.click();
      await expect(watermark).not.toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await expect(page.locator("nextjs-dialog, [data-nextjs-dialog]")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}
