import { expect, test, type Page } from "@playwright/test";
import type { SalvageReport } from "../services/salvage";

// Browser plugin not available. All requests are isolated; no provider/storage writes.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || "3010"}`;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
async function setup(page: Page, theme: "light" | "dark") {
  await page.context().addCookies([{ name: "cv_access_token", value: "isolated-progress-owner", url: baseURL }]);
  await page.addInitScript((value) => { localStorage.setItem("cv_access_token", "isolated-progress-owner"); localStorage.setItem("cv-theme", value); }, theme);
  const errors: string[] = [], writes: { path: string; data: Record<string, unknown> }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") errors.push(entry.text()); });
  let snapshot: SalvageReport = { _id: "progress-1", file_number: "SALVAGE-PROGRESS-QA", createdAt: "2026-09-09T00:00:00Z", revision: 1,
    status: "processing", generation_state: "processing", workflow_stage: "preparing_preview", workflow_message: "Inspecting uploaded photo evidence",
    workflow_progress_percent: 38, job_id: "initial-job", can_cancel: true, preview_available: false, downloadable: false,
    imageUrls: ["https://assetinsight.pro/qa-1.jpg", "https://assetinsight.pro/qa-2.jpg"],
    preview_data: { file_number: "SALVAGE-PROGRESS-QA", appraiser_comments: "Uploaded damage notes", make: "Ford", language: "en" },
    workflow_steps: [{ key: "intake", label: "Saving original photos", status: "completed" }, { key: "photos", label: "Photo evidence assessment", status: "active" }, { key: "research", label: "Canadian market research", status: "pending" }, { key: "preview", label: "Prepare preview", status: "pending" }] };
  let job = 0;
  await page.route("https://assetinsight.pro/**", (route) => route.fulfill({ contentType: "image/png", body: pixel }));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    let body: unknown = { data: [], items: [], enabled: false, configured: false, showBadge: false }, status = 200;
    if (path.endsWith("/user/me")) body = { _id: "owner", username: "QA Appraiser", email: "qa@example.test", contactPhone: "1234567890", companyName: "Test Company", companyAddress: "Test address" };
    else if (path.endsWith("/notifications") || path.endsWith("/reports/myreports")) body = [];
    else if (path.endsWith("/reports/dashboard-analytics")) body = { totals: { reports: 0, lots: 0 }, series: [], leaderboard: { entries: [] } };
    else if (path.endsWith("/salvage") && request.method() === "POST") {
      const upload = request.postDataBuffer()!.toString();
      expect(upload).toContain('filename="photo-1.png"'); expect(upload).toContain('filename="photo-2.png"');
      status = 202; body = { reportId: "progress-1", jobId: snapshot.job_id, phase: "processing", message: "Upload accepted" };
      writes.push({ path, data: { upload: true } });
    } else if (path.endsWith("/salvage")) body = { data: [snapshot] };
    else if (path.endsWith("/salvage/progress-1/preview")) {
      if (request.method() === "PATCH") {
        const data = request.postDataJSON(); expect(data.baseRevision).toBe(snapshot.revision);
        expect(data.data.imageUrls).toBeUndefined(); writes.push({ path, data });
        snapshot = { ...snapshot, revision: snapshot.revision + 1, preview_data: { ...snapshot.preview_data, ...data.data } };
      }
      body = { data: snapshot };
    } else if (path.endsWith("/salvage/progress-1/cancel")) {
      const data = request.postDataJSON(); expect(data).toEqual({ baseRevision: snapshot.revision, jobId: snapshot.job_id });
      writes.push({ path, data });
      snapshot = { ...snapshot, revision: snapshot.revision + 1, status: "cancelled", generation_state: "cancelled", workflow_stage: "stopped", can_cancel: false,
        workflow_message: "Processing stopped", files_generating: false, workflow_steps: snapshot.workflow_steps!.map((step) => step.status === "active" ? { ...step, status: "cancelled" } : step) };
      body = { data: snapshot };
    } else if (["/retry", "/submit", "/resubmit"].some((suffix) => path.endsWith(`/salvage/progress-1${suffix}`))) {
      const data = request.postDataJSON(); expect(data.baseRevision).toBe(snapshot.revision); writes.push({ path, data });
      const files = !path.endsWith("/retry");
      snapshot = { ...snapshot, revision: snapshot.revision + 1, job_id: `new-job-${++job}`, status: "processing", generation_state: "processing", can_cancel: true,
        workflow_stage: files ? "generating_files" : "preparing_preview", files_generating: files, workflow_message: files ? "Creating report documents" : "Resuming photo assessment", workflow_progress_percent: 52,
        workflow_steps: [{ key: "intake", label: "Saved originals", status: "completed" }, { key: files ? "files" : "assessment", label: files ? "Create documents" : "Prepare preview", status: "active" }, { key: "review", label: files ? "Approval" : "Review preview", status: "pending" }] };
      status = 202; body = { data: snapshot };
    }
    await route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  return { errors, writes, completePreview: () => {
    snapshot = { ...snapshot, status: "preview", generation_state: "ready", workflow_stage: "preview_ready", workflow_message: "Preview ready to review", preview_available: true, can_cancel: false,
      workflow_steps: [{ key: "intake", label: "Upload received", status: "completed" }, { key: "photos", label: "Photo assessment", status: "completed" }, { key: "research", label: "Market evidence", status: "completed" }, { key: "preview", label: "Prepare preview", status: "completed" }] };
  } };
}

for (const theme of ["light", "dark"] as const) {
  test(`Salvage upload, durable progress, explicit preview and repeatable stop/resubmit (${theme})`, async ({ page }, testInfo) => {
    const state = await setup(page, theme);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Salvage", exact: true }).click();
    const dialog = page.getByRole("dialog");
    for (const [label, value] of [["File Number", "SALVAGE-PROGRESS-QA"], ["Claim Number", "CLAIM-1"], ["Policy Number", "POLICY-1"], ["Adjuster Name", "Adjuster"], ["Insured Name", "Insured"], ["Appraiser Comments", "Uploaded damage notes"]]) {
      await dialog.locator("label").filter({ hasText: new RegExp(`^${label}$`) }).locator("..").locator("input,textarea").fill(value);
    }
    await dialog.getByLabel("Salvage images").setInputFiles([1, 2].map((index) => ({ name: `photo-${index}.png`, mimeType: "image/png", buffer: pixel })));
    await dialog.getByRole("button", { name: "Create Report" }).click();
    await expect(page).toHaveURL(/\/salvage\/status\/progress-1$/);
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveTitle(/Asset Insight/);
    const tracker = page.getByRole("main", { name: "Salvage report progress" });
    await expect(tracker.getByRole("heading", { name: "Salvage report progress" })).toBeVisible();
    await expect(tracker).not.toContainText(/\bAI\b|OpenAI|GPT-/);
    await expect(tracker.getByRole("list", { name: "Report processing steps" })).toContainText("In progress");
    await expect(page.getByRole("button", { name: "Open preview" })).toBeDisabled();
    expect(await page.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(true);
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification" }).all()) await dismiss.click();
    await page.screenshot({ path: `/tmp/assetinsight-salvage-progress-${testInfo.project.name}-${theme}.png` });

    page.once("dialog", (prompt) => prompt.accept());
    await page.getByRole("button", { name: "Stop processing" }).click();
    await expect(page.getByRole("heading", { name: "Processing stopped" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open preview" })).toBeDisabled();
    await page.reload(); // Durable saved status survives a reload, with no automatic restart.
    await expect(page.getByRole("button", { name: "Resume processing" })).toBeVisible();
    page.once("dialog", (prompt) => prompt.accept());
    await page.getByRole("button", { name: "Resume processing" }).click();
    await expect(page.getByRole("button", { name: "Stop processing" })).toBeVisible();
    state.completePreview();
    await page.getByRole("button", { name: "Refresh progress" }).click();
    await expect(page.getByRole("button", { name: "Open preview" })).toBeEnabled();
    await expect(page).toHaveURL(/\/salvage\/status\/progress-1$/);
    await page.getByRole("button", { name: "Open preview" }).click();
    await expect(page).toHaveURL(/\/salvage\/preview\/progress-1$/);
    await expect(page.getByLabel("Appraiser comments")).toHaveValue("Uploaded damage notes");

    for (let cycle = 1; cycle <= 2; cycle++) {
      await page.getByLabel("Appraiser comments").fill(`Reviewed details ${cycle}\nKeep every photo`);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page.getByRole("button", { name: /^(Submit|Resubmit) report$/ })).toBeEnabled();
      await page.getByRole("button", { name: /^(Submit|Resubmit) report$/ }).click();
      await expect(page).toHaveURL(/\/salvage\/status\/progress-1$/);
      await expect(page.getByLabel("Appraiser comments")).toHaveCount(0);
      page.once("dialog", (prompt) => prompt.accept());
      await page.getByRole("button", { name: "Stop processing" }).click();
      await expect(page.getByRole("button", { name: "Open preview" })).toBeEnabled();
      await page.getByRole("button", { name: "Open preview" }).click();
      await expect(page.getByLabel("Appraiser comments")).toHaveValue(`Reviewed details ${cycle}\nKeep every photo`);
      await expect(page.getByRole("button", { name: /^View photo \d$/ })).toHaveCount(2);
    }
    expect(state.writes.filter((write) => write.data.upload)).toHaveLength(1);
    const cancellations = state.writes.filter((write) => write.path.endsWith("/cancel"));
    expect(cancellations.map((write) => write.data.jobId)).toEqual(["initial-job", "new-job-2", "new-job-3"]);
    expect(state.errors).toEqual([]);
    await expect(page.locator("nextjs-portal [data-nextjs-dialog-overlay]")).toHaveCount(0);
  });
}
