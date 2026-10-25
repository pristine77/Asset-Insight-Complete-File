import { expect, test } from "@playwright/test";
import type { SalvageReport } from "../services/salvage";

// Browser plugin not available: isolated repository Playwright fixtures, no provider or storage writes.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || "3010"}`;
for (const language of ["en", "fr", "es"] as const) {
  test(`saved Salvage sections and revision-safe appraiser context (${language})`, async ({ page }, info) => {
    const theme = language === "fr" ? "dark" : "light";
    await page.context().addCookies([{ name: "cv_access_token", value: "isolated-enrichment-owner", url: baseURL }]);
    await page.addInitScript(mode => { localStorage.setItem("cv_access_token", "isolated-enrichment-owner"); localStorage.setItem("cv-theme", mode); }, theme);
    const summary = language === "fr" ? "Résumé de l’évaluation" : language === "es" ? "Resumen de la evaluación" : "Executive summary";
    const contextTitle = language === "fr" ? "Contexte fourni par l’évaluateur" : language === "es" ? "Contexto aportado por el tasador" : "Appraiser report context";
    const noteLabel = language === "fr" ? "Conclusion de l’évaluateur" : language === "es" ? "Conclusión del tasador" : "Appraiser conclusion";
    let snapshot: SalvageReport = { _id: "enrichment-1", file_number: "SALVAGE-CONTENT-QA", revision: 7, createdAt: "2026-09-09T00:00:00Z",
      status: "preview", preview_available: true, generation_state: "ready", workflow_stage: "preview_ready", imageUrls: [], downloadable: false,
      preview_data: { file_number: "SALVAGE-CONTENT-QA", language, report_context: { intended_use: "Insurance review" },
        report_enrichment: { schemaVersion: 1, sections: [
          { id: "executive-summary", title: summary, paragraphs: ["Saved evidence is incomplete. No valuation is established by this fixture."], tables: [{ headers: ["Measure", "Saved conclusion", "Evidence status"], rows: [["Net auction recovery", "Not established", "Seller-side fees unknown"], ["Repair estimate", "Incomplete", "Labour hours not established"]] }] },
          { id: "photo-findings", title: "Photo finding index", paragraphs: ["Original photos remain attached; an unanalyzed photo is not evidence of absence."], tables: [{ headers: ["Photo", "Analysis status", "Observation", "Uncertainty"], rows: [["photo-001", "Not analyzed", "No supported reading", "VIN unreadable"]] }] },
          { id: "references", title: "References", paragraphs: ["No externally verified sources in this isolated fixture."], tables: [] },
        ] } } };
    const errors: string[] = [], writes: Array<{ path: string; payload: Record<string, unknown> }> = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      let body: unknown = { data: [], items: [], enabled: false, configured: false, showBadge: false };
      if (path.endsWith("/user/me")) body = { _id: "owner", username: "QA Appraiser", email: "qa@example.test" };
      else if (path.endsWith("/notifications") || path.endsWith("/reports/myreports")) body = [];
      else if (path.endsWith("/salvage/enrichment-1/preview")) {
        if (request.method() === "PATCH") {
          const payload = request.postDataJSON();
          expect(payload.baseRevision).toBe(snapshot.revision); expect(payload.data.report_enrichment).toBeUndefined();
          expect(payload.data.assessment).toBeUndefined(); expect(payload.data.imageUrls).toBeUndefined();
          writes.push({ path, payload });
          snapshot = { ...snapshot, revision: snapshot.revision + 1, preview_data: { ...snapshot.preview_data, ...payload.data,
            report_enrichment: { ...snapshot.preview_data.report_enrichment!, sections: snapshot.preview_data.report_enrichment!.sections.map(section => section.id === "executive-summary" ? { ...section, paragraphs: ["Saved evidence is incomplete. Appraiser note: " + payload.data.report_context.appraiser_conclusion] } : section) } } };
        }
        body = { data: snapshot };
      } else if (request.method() !== "GET") writes.push({ path, payload: request.postDataJSON() || {} });
      await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    });
    await page.goto("/salvage/preview/enrichment-1");
    await expect(page).toHaveURL(/\/salvage\/preview\/enrichment-1$/); await expect(page).toHaveTitle(/Asset Insight/);
    await expect(page.getByRole("heading", { name: "Salvage report preview", exact: true })).toBeVisible();
    await expect(page.getByRole("table").first()).toContainText("Not established");
    await expect(page.locator("nextjs-portal [data-nextjs-dialog-overlay]")).toHaveCount(0);
    expect(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/salvage-enrichment-web-${info.project.name}-${language}.png` });
    await page.locator("summary").filter({ hasText: /^Photo finding index$/ }).click();
    await expect(page.getByRole("table", { name: "Photo finding index" })).toContainText("VIN unreadable");
    await page.getByText(contextTitle, { exact: true }).click();
    await page.getByLabel(noteLabel, { exact: true }).fill("Appraiser requires further inspection.\nHidden damage remains unknown.");
    await expect(page.getByRole("button", { name: "Research again", exact: true })).toBeDisabled();
    await expect(page.getByRole("table").first()).toContainText("Not established");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("Saved revision 8", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({ baseRevision: 7, data: { report_context: { intended_use: "Insurance review", appraiser_conclusion: "Appraiser requires further inspection.\nHidden damage remains unknown." } } });
    await page.reload();
    await page.getByText(contextTitle, { exact: true }).click();
    await expect(page.getByLabel(noteLabel, { exact: true })).toHaveValue("Appraiser requires further inspection.\nHidden damage remains unknown.");
    expect(writes).toHaveLength(1); expect(errors).toEqual([]);
    expect(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
