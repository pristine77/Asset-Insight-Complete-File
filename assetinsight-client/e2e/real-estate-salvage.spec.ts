import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || "3010"}`;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const photo = (name: string) => ({ name, mimeType: "image/png", buffer: pixel });

async function setup(page: Page, theme: "light" | "dark", onSubmit?: (body: Buffer) => Promise<void>) {
  await page.context().addCookies([{ name: "cv_access_token", value: "e2e-token", url: baseURL }]);
  await page.addInitScript((mode) => {
    localStorage.setItem("cv_access_token", "e2e-token");
    localStorage.setItem("cv-theme", mode);
  }, theme);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route(/https:\/\/(assetinsight\.pro|images\.sellsnap\.store)\//, (route) => route.fulfill({ contentType: "image/png", body: pixel }));
  let preview = {
    property_type: "agricultural", property_details: { address: "Regression Farm", land_area_acres: "100" },
    farmland_details: { total_title_acres: 100, cultivated_acres: 0, annual_rent_per_acre: 0 },
    farmland_valuation: { fair_market_value_formatted: "CA$140,000", approaches_used: { direct_comparable: false, income_capitalization: true, cost_approach: true } },
  };
  let saved = false;
  let submitted = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = { data: [], items: [], enabled: false, configured: false, showBadge: false };
    let status = 200;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (path.endsWith("/user/me")) body = { _id: "e2e-owner", username: "Test Appraiser", email: "test@example.test", contactPhone: "1234567890", companyName: "Test Company", companyAddress: "Test address" };
    else if (path.endsWith("/reports/myreports")) body = [];
    else if (path.endsWith("/reports/dashboard-analytics")) body = { totals: { reports: 0, lots: 0 }, series: [], leaderboard: { entries: [] } };
    else if (path.endsWith("/notifications")) body = [];
    else if (path.endsWith("/real-estate")) body = { data: [{ _id: "re-preview", status: "preview", property_type: "agricultural", property_details: preview.property_details, preview_data: preview, imageUrls: [], createdAt: "2026-09-06T12:00:00Z", updatedAt: "2026-09-06T12:00:00Z" }] };
    else if (path.endsWith("/real-estate/preview/re-preview/submit")) { submitted = true; status = 202; body = { message: "Files queued", data: {} }; }
    else if (path.endsWith("/real-estate/preview/re-preview")) {
      if (request.method() === "PUT") { preview = request.postDataJSON().preview_data; saved = true; body = { message: "Saved", data: preview }; }
      else body = { data: { status: "preview", reportId: "re-preview", property_type: "agricultural", language: "en", preview_data: preview, imageUrls: ["https://images.sellsnap.store/existing.png"], extraImageUrls: ["https://assetinsight.pro/map.png"] } };
    } else if (path.endsWith("/salvage") && request.method() === "POST") {
      await onSubmit?.(request.postDataBuffer()!);
      status = 202; body = { message: "Your salvage report is processing in the background", jobId: "salvage-job", phase: "processing" };
    }
    await route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  return { errors, saved: () => saved, submitted: () => submitted };
}

for (const theme of ["light", "dark"] as const) {
  test(`real-estate agricultural review shows all media and saves edits (${theme})`, async ({ page }, testInfo) => {
    const state = await setup(page, theme);
    await page.goto("/previews");
    await expect(page).toHaveURL(/\/previews$/);
    await expect(page).toHaveTitle(/Asset Insight/i);
    await page.getByRole("button", { name: "Review & submit" }).click();
    const dialog = page.getByRole("dialog", { name: "Real Estate Report Preview" });
    await expect(dialog.getByText("agricultural Property")).toBeVisible();
    await expect(dialog.getByPlaceholder("Property address")).toHaveValue("Regression Farm");
    await expect(dialog.getByText("CA$140,000")).toBeAttached();
    await expect(dialog.getByText("Income Capitalization · Cost Approach")).toBeAttached();
    await dialog.getByPlaceholder("Property address").fill("Updated farm address");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect.poll(state.saved).toBe(true);
    await dialog.getByRole("button", { name: "View report-only photo 1" }).click();
    await expect(dialog.getByText("Photo 2 of 2")).toBeVisible();
    await dialog.getByRole("button", { name: "Close photo" }).click();
    await dialog.getByRole("heading", { name: /Farmland Details/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/assetinsight-re-${testInfo.project.name}-${theme}.png` });
    await dialog.getByRole("button", { name: "Submit for Approval" }).click();
    await expect.poll(state.submitted).toBe(true);
    await expect(dialog).not.toBeVisible();
    expect(state.errors).toEqual([]);
  });

  test(`salvage uploads all30 photos with locked confirmation (${theme})`, async ({ page }, testInfo) => {
    let release!: () => void;
    const confirmation = new Promise<void>((resolve) => { release = resolve; });
    let uploaded = false;
    const state = await setup(page, theme, async (body) => {
      const text = body.toString();
      for (let i = 1; i <= 30; i++) expect(text).toContain(`filename="photo-${i}.png"`);
      uploaded = true;
      await confirmation;
    });
    await page.goto("/dashboard");
    await expect(page).toHaveTitle(/Asset Insight/i);
    await page.getByRole("button", { name: "Salvage", exact: true }).click();
    const dialog = page.getByRole("dialog");
    for (const [label, value] of [["File Number", "FILE-1"], ["Claim Number", "CLAIM-1"], ["Policy Number", "POLICY-1"], ["Adjuster Name", "Adjuster"], ["Insured Name", "Insured"], ["Appraiser Comments", "Keep every photo"]]) {
      await dialog.locator("label").filter({ hasText: new RegExp(`^${label}$`) }).locator("..").locator("input,textarea").fill(value);
    }
    await dialog.getByLabel("Salvage images").setInputFiles(Array.from({ length: 30 }, (_, i) => photo(`photo-${i + 1}.png`)));
    await expect(dialog.getByText("Selected: 30/30 photos")).toBeVisible();
    await dialog.getByRole("button", { name: "Create Report" }).click();
    await expect.poll(() => uploaded).toBe(true);
    // Intercepted requests don't emit native XHR upload progress until fulfilled.
    // The component test separately proves the 100% -> confirming transition.
    await expect(dialog.getByRole("status")).toContainText("Uploading salvage report");
    await expect(dialog.getByRole("button", { name: "Close panel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: `/tmp/assetinsight-salvage-${testInfo.project.name}-${theme}.png` });
    release();
    await expect(dialog).not.toBeVisible();
    expect(state.errors).toEqual([]);
  });
}
