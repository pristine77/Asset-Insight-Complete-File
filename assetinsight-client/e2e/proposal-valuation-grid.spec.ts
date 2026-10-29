import { expect, test, type Page } from "@playwright/test";
import type { ProposalValuationChange, ProposalValuationPayload } from "../components/reports/proposal-valuation/types";

// Synthetic API fixtures only. No customer reports or external provider calls.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || "3010"}`;
function fixture(): ProposalValuationPayload {
  return {
    reportId: "grid-qa", title: "Synthetic valuation grid", currencyCode: "CAD", revision: 7,
    permissions: { canManageEvaluators: true, canEditAll: true, evaluatorColumnId: null, canRegenerateFiles: true },
    assetScheduleSheet: {
      evaluator_columns: [{ id: "qa", name: "QA appraiser" }],
      rows: Array.from({ length: 225 }, (_, i) => ({
        lot_id: `lot-${i + 1}`, asset_id: String(i + 1), asset_category: "Office Equipment",
        year: "2023", make: "Original", model: "Fixture", serial_number: `QA-${i + 1}`,
        cr_details: "Synthetic fixture", condition_score: "3", location: "Regina, SK",
        pictures: 0, picture_urls: [], asset_insight: "", evaluator_values: { qa: 500 },
        market_check: { comparable_count: "", avg_retail_asking_price: "", market_saturation: "", market_velocity: "", regional_demand: "", notes: "" },
        low_est_sale_value: 500, high_est_sale_value: 500, buyer_premium_percent: 15,
        buyer_premium_amount: 75, total_expected_gross: 575, allocated_value: 575,
        notes: "", cleaning: 5, lien_search: null, video_cost: null, lotting_fee: 5, advertising: 5,
      })),
      file_summary: { buyers_premium_basis: "uncapped", total_risk_weighted_value: null, file_risk_multiplier: null, commission_percent_no_guarantee: null, offer2_nmg_percent: 0.785, capped_threshold_percent: 0.1 },
    },
  };
}

async function openWorkspace(page: Page, lostBatch = 0) {
  const persisted = fixture(), receipts = new Map<string, ProposalValuationPayload>();
  const calls: Array<{ changes: ProposalValuationChange[]; baseRevision: number; clientMutationId: string }> = [];
  const errors: string[] = [];
  let lost = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.context().addCookies([{ name: "cv_access_token", value: "synthetic-grid-owner", url: baseURL }]);
  await page.addInitScript(() => { localStorage.setItem("cv_access_token", "synthetic-grid-owner"); localStorage.setItem("cv-theme", "dark"); });
  await page.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
  await page.route("**/api/**", async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, json: body });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (pathname.endsWith("/user/me")) return json({ _id: "qa-owner", username: "QA Owner", email: "qa@example.test", isVerified: true, proposalValuationEnabled: true });
    if (pathname.endsWith("/proposal-valuation/events")) return route.fulfill({ headers, contentType: "text/event-stream", body: `event: ready\ndata: ${JSON.stringify({ reportId: persisted.reportId, revision: persisted.revision })}\n\n` });
    if (pathname.endsWith("/proposal-valuation") && request.method() === "PATCH") {
      const body = request.postDataJSON(); calls.push(body);
      if (body.changes.length > 500) return json({ code: "PROPOSAL_VALUATION_CHANGES_TOO_LARGE", message: "A save can contain at most 500 changes" }, 413);
      if (receipts.has(body.clientMutationId)) return json(receipts.get(body.clientMutationId));
      if (body.baseRevision !== persisted.revision) return json({ code: "PV_REVISION_CONFLICT", currentRevision: persisted.revision }, 409);
      for (const change of body.changes as ProposalValuationChange[]) {
        const row = persisted.assetScheduleSheet.rows.find(row => row.lot_id === change.lotId)!;
        (row as unknown as Record<string, unknown>)[change.field] = change.value;
      }
      persisted.revision! += 1;
      receipts.set(body.clientMutationId, structuredClone(persisted));
      if (!lost && receipts.size === lostBatch) {
        lost = true;
        return json({ message: "Synthetic lost response after commit" }, 503);
      }
      return json(persisted);
    }
    if (pathname.endsWith("/proposal-valuation")) return json(persisted);
    if (pathname.endsWith("/notifications")) return json([]);
    return json({ items: [], data: [], unreadCount: 0, total: 0, enabled: false, configured: false });
  });
  await page.goto("/proposal-valuations/grid-qa");
  await expect(page.getByPlaceholder("Search assets")).toBeVisible();
  await expect(page).toHaveTitle(/Asset Insight/);
  return { persisted, calls, errors };
}

for (const lostBatch of [0, 1, 2]) {
  test(`225-row paste saves all cells with lost batch ${lostBatch}`, async ({ page }) => {
    test.skip(page.viewportSize()!.width < 768, "Spreadsheet is desktop-only");
    const { persisted, calls, errors } = await openWorkspace(page, lostBatch);
    const grid = page.getByRole("grid", { name: "Proposal valuation lots" });
    const cell = grid.getByLabel("Year for 1", { exact: true }).locator("..");
    await cell.click();
    await cell.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", Array.from({ length: 225 }, () => "2024\tNew Make\tNew Model").join("\n"));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await expect(page.getByText("Saved · revision 9", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(calls.map(call => call.changes.length)).toEqual(lostBatch === 0 ? [500, 175] : lostBatch === 1 ? [500, 500, 175] : [500, 175, 175]);
    if (lostBatch === 1) expect(calls[1]).toEqual(calls[0]);
    if (lostBatch === 2) expect(calls[2]).toEqual(calls[1]);
    expect(persisted.assetScheduleSheet.rows.every(row => row.year === "2024" && row.make === "New Make" && row.model === "New Model")).toBe(true);
    expect(errors).toEqual([]);
    if (process.env.PV_QA_SCREENSHOTS) await page.screenshot({ path: `${process.env.PV_QA_SCREENSHOTS}/saved-batch-${lostBatch}.png` });
  });
}

test("Escape cancels formula editing without reaching the window close handler", async ({ page }) => {
  test.skip(page.viewportSize()!.width < 768, "Formula bar is desktop-only");
  const { calls, errors } = await openWorkspace(page);
  await page.getByRole("grid").getByLabel("Year for 1", { exact: true }).locator("..").click();
  const bar = page.getByRole("textbox", { name: "Formula bar" });
  await bar.click();
  await bar.fill("999");
  await page.evaluate(() => {
    document.documentElement.dataset.qaEscapeBubbled = "0";
    window.addEventListener("keydown", event => {
      if (event.key === "Escape") document.documentElement.dataset.qaEscapeBubbled = "1";
    });
  });
  await bar.press("Escape");
  await expect(bar).toHaveValue("2023");
  await expect(page.locator("html")).toHaveAttribute("data-qa-escape-bubbled", "0");
  await expect(page.getByRole("heading", { name: "Proposal Valuation", exact: true })).toBeVisible();
  expect(calls).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("mobile avoids hidden rows and resizing retains the active desktop edit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = await openWorkspace(page);
  const grid = page.getByRole("grid", { includeHidden: true });
  await expect(grid.locator("tbody td[data-row]")).toHaveCount(0);
  await expect(page.getByLabel("Year for 1", { exact: true })).toBeVisible();
  expect(await page.locator("input").count()).toBeLessThan(1000);
  await page.setViewportSize({ width: 1366, height: 900 });
  const year = grid.getByLabel("Year for 1", { exact: true });
  await year.locator("..").dblclick();
  await year.fill("2025");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(grid.locator("tbody td[data-row]")).toHaveCount(0);
  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(year).toHaveValue("2025");
  await year.press("Enter");
  await expect(page.getByText("Saved · revision 8", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(grid.locator("tbody td[data-row]")).toHaveCount(0);
  await expect(page.getByPlaceholder("Search assets")).toBeVisible();
  expect(errors).toEqual([]);
  if (process.env.PV_QA_SCREENSHOTS) await page.screenshot({ path: `${process.env.PV_QA_SCREENSHOTS}/mobile-320.png` });
});
