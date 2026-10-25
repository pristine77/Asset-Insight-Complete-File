import { describe, expect, it } from "vitest";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";
import { normalizeSalvageReportData } from "../src/service/salvageReportData.js";
import { editableSalvageData, salvageSnapshot } from "../src/service/salvageWorkflowService.js";
import { buildSalvageReportEnrichment, normalizeSalvageReportContext, validateSalvageReportContext } from "../src/service/salvageReportEnrichment.js";

const fixture = () => {
  const assessment = buildSalvageAssessment({ inputs: { effectiveDate: "2026-08-16", year: 2018, make: "Peterbilt", model: "389", province: "SK", condition: "Collision damage",
    repairItems: [{ description: "Cab repair", quantity: 1, unitPrice: 6000, appraiserReason: "Documented supplier quote" }],
    labourItems: [{ description: "Repair and refinish", hours: 30, rate: 125, appraiserReason: "Reviewed facility estimate" }],
    charges: [{ description: "Shop supplies", amount: 400, appraiserReason: "Facility quotation" }, { description: "Taxes", amount: 600, appraiserReason: "Documented taxes" }],
    overrides: { preLoss: { amount: 132900, appraiserReason: "Owner supplied valuation basis for testing" }, asIs: { amount: 25000, appraiserReason: "Reviewed as-is condition estimate" } },
    sellerCosts: { fees: { amount: 0, appraiserReason: "Written fee waiver" }, transport: null, storage: { amount: 250, appraiserReason: "Storage invoice" }, disposal: { amount: 0, appraiserReason: "No disposal needed" } },
  }, photoFindings: [{ photoId: "photo-001", status: "analyzed", observations: ["Dented cab panel"], uncertainties: ["Unseen internal damage"], facts: [] },
    { photoId: "photo-002", status: "not_analyzed", observations: [], uncertainties: ["Image unreadable"], facts: [] }],
    research: { model: "gpt-6-astra", status: "partial", plan: { summary: { text: "Research asking-market vehicles", urls: [] }, priorities: [{ text: "Check local sources", urls: [] }] } },
    generatedAt: "2026-08-16T00:00:00Z" });
  return { assessment, language: "en", currency: "CAD", imageUrls: ["https://assetinsight.pro/1.jpg", "https://assetinsight.pro/2.jpg"],
    report_context: { intended_use: "Claim review only", pre_loss_condition: "Not independently documented", appraiser_conclusion: "Awaiting transport quotation" } };
};
const serialized = (data: any) => JSON.stringify(normalizeSalvageReportData(data).report_enrichment);

describe("Salvage enriched report projection", () => {
  it("reconciles source-style repair inputs from arithmetic, not the sample's incorrect total", () => {
    const data = fixture();
    expect(data.assessment.repairs.total).toBe(10750);
    expect(serialized(data)).toContain("10,750.00");
    expect(serialized(data)).not.toContain("10,550");
    expect(data.assessment.netRecovery.total).toBeNull();
    const result = normalizeSalvageReportData(data);
    expect(result.report_enrichment.sections[0].tables[0].rows).toEqual(expect.arrayContaining([
      ["Net auction recovery", "Unavailable", "Incomplete"],
      ["As-is salvage value", "$25,000.00", "Appraiser override"],
    ]));
    expect(result.assessment.valuations.asIs.amount).toBe(25000); // Never subtract repair again.
  });
  it("keeps all photos, flags unreadable evidence, places actual references last and cannot invent a signoff", () => {
    const data = fixture(); const result = normalizeSalvageReportData(data);
    const sections = result.report_enrichment.sections;
    expect(sections.at(-1).id).toBe("references");
    expect(sections.find((s: any) => s.id === "photo-findings").tables[0].rows).toEqual([
      ["photo-001", "Dented cab panel", "Unseen internal damage"], ["photo-002", "Not analyzed", "Image unreadable"],
    ]);
    expect(result.imageUrls).toEqual(data.imageUrls);
    expect(serialized(data)).not.toMatch(/Morgan Chen|Electronic review|example\.com|\bGPT-6|\bOpenAI\b/);
    expect(serialized(data)).toContain("unverified leads");
  });
  it("discards forged derived sections and preserves supplied text without altering evidence or calculations", () => {
    const data = fixture(); const before = structuredClone(data);
    const result = normalizeSalvageReportData({ ...data, report_enrichment: { sections: [{ title: "Forged verified sale" }] } });
    expect(JSON.stringify(result.report_enrichment)).not.toContain("Forged verified sale");
    expect(result.report_context.appraiser_conclusion).toBe("Awaiting transport quotation");
    expect(data).toEqual(before);
    expect(editableSalvageData({ report_enrichment: { schemaVersion: 1 }, report_history: { revision: 99 }, report_context: { client_comments: "Client note" } }))
      .toEqual({ report_context: { client_comments: "Client note" } });
  });
  it("does not upgrade two asking listings into a numeric sale conclusion", () => {
    const a = buildSalvageAssessment({ inputs: { year: 2018, make: "Peterbilt", model: "389", effectiveDate: "2026-08-16", province: "SK" },
      candidates: [1, 2].map(i => ({ id: `asking-${i}`, basket: "pre_loss", title: `Truck ${i}`, year: 2018, make: "Peterbilt", model: "389", price: 100000 + i, priceBasis: "asking", currency: "CAD", eventDate: "2026-08-10", location: "Saskatoon", province: "SK", country: "CA", verification: "appraiser_supplied", appraiserReason: "Comparable listing supplied for review" })) });
    expect(a.valuations.preLoss.amount).toBeNull();
    const text = serialized({ assessment: a });
    expect(text).toContain("Asking price"); expect(text).not.toContain("Medium confidence");
    expect(text).toContain("Insufficient evidence");
  });
  it.each(["en", "fr", "es"])("localizes section labels and preserves canonical amounts in %s", language => {
    const result = normalizeSalvageReportData({ ...fixture(), language });
    expect(result.report_enrichment.sections.map((s: any) => s.id)).toEqual(expect.arrayContaining([
      "executive-summary", "repair-provenance", "comparable-verification", "adjustment-support", "valuation-calculations", "evidence-review", "photo-findings", "review-checklist", "references",
    ]));
    expect(result.report_enrichment.sections[0].title).toBe({ en: "Executive Assessment Summary", fr: "Sommaire de l’évaluation", es: "Resumen ejecutivo de la valoración" }[language]);
    expect(result.assessment.repairs.total).toBe(10750);
    expect(result.report_enrichment.sections.flatMap((s: any) => s.tables).every((t: any) => t.rows.every((r: string[]) => r.length === t.headers.length))).toBe(true);
  });
  it("supports legacy reports without fabricating enhanced valuation evidence", () => {
    const result = normalizeSalvageReportData({ imageUrls: ["https://assetinsight.pro/legacy.jpg"], valuation: { fairMarketValue: "5000" }, comparableItems: [{ title: "Legacy comparable", price: "3000", link: "javascript:alert(1)" }] });
    expect(result.assessment).toBeUndefined();
    expect(result.valuation.fairMarketValue).toBe("5000");
    expect(JSON.stringify(result.report_enrichment)).toContain("Legacy listing; transaction status unverified");
    expect(JSON.stringify(result.report_enrichment)).not.toContain("javascript:");
    expect(result.report_enrichment.sections.some((s: any) => s.id === "executive-summary")).toBe(false);
  });
  it("uses only server history and does not expose hidden actor IDs, hashes or provider diagnostics", () => {
    const result = salvageSnapshot({ revision: 3, preview_data: { ...fixture(), report_history: { revision: 999, events: [] } },
      assessment_edit_history: [{ revision: 3, actor: "private-actor", at: new Date("2026-09-09T00:00:00Z"), changedFields: ["report_context"], beforeHash: "private-hash" }] });
    expect(result.report_history.revision).toBe(3);
    expect(JSON.stringify(result.report_enrichment)).toContain("2026-09-09T00:00:00.000Z");
    expect(JSON.stringify(result.report_enrichment)).not.toMatch(/private-actor|private-hash|999/);
    expect(buildSalvageReportEnrichment(result)).toEqual(result.report_enrichment);
  });
  it("validates bounded context, actual calendar dates and explicit clearing", () => {
    expect(validateSalvageReportContext({ repair_estimate_date: "2026-02-30" })).toBeTruthy();
    expect(validateSalvageReportContext({ repair_estimate_date: "2026-02-28" })).toBeNull();
    expect(validateSalvageReportContext({ claim_approved: "yes" })).toBeTruthy();
    expect(validateSalvageReportContext({ client_comments: "x".repeat(6001) })).toBeTruthy();
    expect(validateSalvageReportContext({ intended_use: 1 })).toBeTruthy();
    expect(normalizeSalvageReportContext({ intended_use: "  ", client_comments: "Preserve\nparagraphs", signer: "forged" })).toEqual({ intended_use: null, client_comments: "Preserve\nparagraphs" });
  });
  it("retains saved quality-review issue text and its evidence IDs as unverified notes", () => {
    const data = fixture();
    data.assessment.research.qualityReview = { issues: [{ text: "Confirm collision repair scope", candidateIds: ["c-1"], photoIds: ["photo-001"] }] };
    const out = serialized(data);
    expect(out).toContain("Confirm collision repair scope"); expect(out).toContain("c-1, photo-001");
    expect(out).toContain("unverified leads");
  });
  it("retains FX rate/date, source quotes and conclusion citations without changing saved calculations", () => {
    const data = fixture();
    data.assessment.valuations.preLoss.referenceIds = ["appraisal-basis"];
    data.assessment.candidates = [{ id: "foreign-1", title: "Foreign comparable", basket: "pre_loss", price: 10000, currency: "USD", adjustedPrice: 13700,
      fx: { cadPerUnit: 1.37, date: "2026-08-14", referenceId: "fx-boc" }, evidence: { price: { referenceId: "listing-price", quote: "Asking price USD 10000" } },
      priceBasis: "asking", verification: "unverified", referenceIds: [], adjustments: [], exclusionReasons: ["Unverified price"], eligible: false, selected: false } as any];
    const result = serialized(data);
    expect(result).toContain("1 USD = 1.37 CAD"); expect(result).toContain("2026-08-14"); expect(result).toContain("[fx-boc]");
    expect(result).toContain("[appraisal-basis]"); expect(result).toContain("[listing-price] Asking price USD 10000");
    expect(data.assessment.valuations.preLoss.amount).toBe(132900);
  });
  it("does not relabel generated procurement notes as appraiser-authored or resurrect explicitly cleared notes", () => {
    const result = normalizeSalvageReportData({ ...fixture(), procurement_notes: "Generated lead time suggestion", report_context: { lead_time_notes: null } });
    const section = result.report_enrichment.sections.find((s: any) => s.id === "repair-provenance");
    expect(section.tables[0].rows).toContainEqual(["Lead times and availability (appraiser)", "Not reported"]);
    expect(JSON.stringify(section)).not.toContain("Generated lead time suggestion");
  });
  it("groups repeated excerpts while retaining all supported fields and distinct source attributions", () => {
    const data = fixture();
    const evidence = { price: { referenceId: "listing-1", quote: "2018 truck asking CAD 10000" },
      year: { referenceId: "listing-1", quote: "2018 truck asking CAD 10000" },
      model: { referenceId: "listing-2", quote: "2018 truck asking CAD 10000" } };
    data.assessment.candidates = [{ id: "candidate-1", title: "Truck", basket: "pre_loss", currency: "CAD", evidence,
      referenceIds: [], adjustments: [], exclusionReasons: [], eligible: false, selected: false } as any];
    const table = buildSalvageReportEnrichment(data).sections.find(s => s.id === "comparable-verification")!.tables[0];
    const quotes = table.rows.filter(r => r[0].startsWith("Source excerpt"));
    expect(quotes).toEqual([["Source excerpt (price, year)", "[listing-1] 2018 truck asking CAD 10000"],
      ["Source excerpt (model)", "[listing-2] 2018 truck asking CAD 10000"]]);
    expect(data.assessment.candidates[0].evidence).toEqual(evidence);
  });
  it.each(["fr", "es"])("translates known system methods and review flags without changing appraiser prose in %s", language => {
    const out = serialized({ ...fixture(), language });
    expect(out).not.toContain("Appraiser override: ");
    expect(out).not.toContain("VIN is absent or unreadable");
    expect(out).toContain("Owner supplied valuation basis for testing");
    expect(out).toContain("Awaiting transport quotation");
  });
});
