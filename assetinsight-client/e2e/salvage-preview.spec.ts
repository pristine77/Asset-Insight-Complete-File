import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || "3010"}`;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

async function setup(page: Page, theme: "light" | "dark") {
  await page.context().addCookies([{ name: "cv_access_token", value: "isolated-salvage-test", url: baseURL }]);
  await page.addInitScript((mode) => {
    localStorage.setItem("cv_access_token", "isolated-salvage-test");
    localStorage.setItem("cv-theme", mode);
  }, theme);
  const errors: string[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const downloads: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  let snapshot = {
    _id: "salvage-1", reportId: "salvage-1", file_number: "CLAIM-157", revision: 2,
    status: "preview", workflow_stage: "preview_ready", workflow_message: "Review your saved details before creating report files.",
    workflow_progress_percent: 100, files_generating: false, files_ready: false, downloadable: false,
    createdAt: "2026-09-07T10:00:00Z", currency: "CAD",
    imageUrls: ["https://assetinsight.pro/test-main.jpg", "https://images.sellsnap.store/test-original.jpg"],
    preview_data: {
      file_number: "CLAIM-157", claim_number: "CLAIM-157", policy_number: "POLICY-01", report_date: "2026-09-07", date_received: "2026-09-06",
      date_of_loss: "2026-09-04", reported_loss_type: "Collision", insured_name: "Example owner", year: "2020", make: "Ford", item_model: "F-150", vin: "1FTTEST00000000001",
      appraiser_comments: "Original damage notes", cause_of_loss_summary: "Front bumper damage", currency: "CAD",
      valuation: { fairMarketValue: "CA$10,000", confidence_level: "Medium", summary: "Based on comparable vehicles" },
      repair_items: [{ name: "Front bumper", quantity: 1, unit_price: 500, line_total: 500 }],
      labour_breakdown: [{ task: "Replace bumper", hours: 2, rate_per_hour: 100, line_total: 200 }],
    },
    files: {} as Record<string, string>,
  };
  await page.route(/https:\/\/(assetinsight\.pro|images\.sellsnap\.store)\//, (route) => route.fulfill({ contentType: "image/png", body: pixel }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    let body: unknown = { data: [], items: [], enabled: false, configured: false, showBadge: false };
    let status = 200;
    if (path.endsWith("/user/me")) body = { _id: "isolated-owner", username: "Test Appraiser", email: "test@example.test" };
    else if (path.endsWith("/notifications") || path.endsWith("/reports/myreports")) body = [];
    else if (path.endsWith("/salvage")) body = { data: [snapshot] };
    else if (path.endsWith("/salvage/salvage-1/preview")) {
      if (method === "PATCH") {
        const payload = request.postDataJSON();
        writes.push({ method, path, body: payload });
        expect(payload.baseRevision).toBe(snapshot.revision);
        expect(payload.data.imageUrls).toBeUndefined();
        snapshot = { ...snapshot, preview_data: payload.data, revision: snapshot.revision + 1 };
      }
      body = { data: snapshot };
    } else if (path.endsWith("/salvage/salvage-1/submit")) {
      const payload = request.postDataJSON();
      writes.push({ method, path, body: payload });
      expect(payload.baseRevision).toBe(snapshot.revision);
      snapshot = { ...snapshot, status: "processing", workflow_stage: "generating_files", workflow_message: "Creating report files", files_generating: true, workflow_progress_percent: 45 };
      status = 202; body = { jobId: "files-1", reportId: "salvage-1", data: snapshot };
    } else if (/\/reports\/(pdf-id|docx-id|xlsx-id|zip-id)\/download$/.test(path)) {
      downloads.push(path);
      return route.fulfill({ contentType: "application/octet-stream", headers: { "access-control-allow-origin": "*", "content-disposition": 'attachment; filename="salvage-test.pdf"' }, body: Buffer.from("isolated generated file fixture") });
    }
    await route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  return {
    errors, writes, downloads,
    ready: () => {
      snapshot = { ...snapshot, status: "approved", workflow_stage: "ready", workflow_message: "Report approved and released", files_generating: false, files_ready: true, downloadable: true, workflow_progress_percent: 100, files: { pdf: "pdf-id", docx: "docx-id", xlsx: "xlsx-id", images: "zip-id" } };
    },
  };
}

for (const theme of ["light", "dark"] as const) {
  test(`salvage full-page review saves, submits and downloads only ready files (${theme})`, async ({ page }, testInfo) => {
    const state = await setup(page, theme);
    await page.goto("/previews");
    await page.getByRole("button", { name: "Review report", exact: true }).click();
    await expect(page).toHaveURL(/\/salvage\/preview\/salvage-1$/);
    await expect(page).toHaveTitle(/Asset Insight/i);
    await expect(page.getByRole("heading", { name: "Salvage report preview" })).toBeVisible();
    await expect(page.getByLabel("Appraiser comments")).toHaveValue("Original damage notes");
    await expect(page.getByRole("main", { name: "Salvage report workspace" }).getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Failed to load previews", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "PDF", exact: true })).toBeDisabled();
    expect(await page.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/assetinsight-salvage-preview-${testInfo.project.name}-${theme}.png` });
    await page.getByLabel("Appraiser comments").fill("Reviewed on web\nPreserve both lines");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("Saved revision 3")).toBeVisible();
    expect(state.writes).toHaveLength(1);
    await page.getByRole("button", { name: "View photo 2" }).click();
    await expect(page.getByRole("dialog", { name: "Report photo viewer" })).toContainText("Photo 2 of 2");
    await page.getByRole("button", { name: "Close photo" }).click();
    await page.getByRole("button", { name: "Submit report", exact: true }).click();
    await expect(page).toHaveURL(/\/salvage\/status\/salvage-1$/);
    await expect(page.getByRole("progressbar", { name: "Salvage processing progress" })).toHaveAttribute("value", "45");
    await expect(page.getByRole("button", { name: "PDF", exact: true })).toHaveCount(0);
    expect(state.writes).toHaveLength(2);
    state.ready();
    await page.getByRole("button", { name: "Refresh progress", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open preview", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/\/salvage\/status\/salvage-1$/);
    await page.getByRole("button", { name: "Open preview", exact: true }).click();
    await expect(page.getByRole("button", { name: "PDF", exact: true })).toBeEnabled();
    for (const label of ["PDF", "DOCX", "XLSX", "Photo ZIP"]) {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: label, exact: true }).click();
      await download;
    }
    expect(state.downloads).toHaveLength(4);
    await page.getByRole("button", { name: "Reports", exact: true }).click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole("button", { name: "Preview Salvage report: CLAIM-157" })).toBeVisible();
    expect(state.errors).toEqual([]);
    // Next's development indicator also lives in a portal; only its error
    // dialog represents a framework failure.
    await expect(page.locator("nextjs-portal [data-nextjs-dialog-overlay]")).toHaveCount(0);
  });
}
