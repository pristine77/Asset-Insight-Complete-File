import { describe, expect, it } from "vitest";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";
import { buildSalvageAppraisalView, money, salvageReportUnits } from "../src/service/salvageAppraisalView.js";

// The full MCD Appraisals report (owner, 2026-11-01): front sheet, units, totals, appendices.
const report = (extra: Record<string, unknown> = {}) => ({
  file_number: "SAL-1", claim_number: "C-1", company_name: "Insurer", report_number: 2, unit_label: "Heavy Truck #807",
  item_type: "Highway Tractor", year: "2014", make: "Peterbilt", item_model: "389", is_repairable: "No",
  actual_cash_value: 105000, appraiser_reserve: 105000, salvage_value: "7000", recommended_reserve: 0,
  appendices: [{ id: "a-1", title: "Truck estimate", kind: "pdf", url: "https://cdn.example/a.pdf", pageCount: 3 },
    { id: "a-2", title: "Invoice", kind: "image", url: "https://cdn.example/b.jpg" }],
  repair_estimate_appendix: "a-1",
  additional_units: [
    { id: "u2", unit_label: "Lead", is_repairable: "Yes", actual_cash_value: 63000, appraiser_reserve: 7500, salvage_value: "N/A",
      repair_summary: { parts: 4600, labour: 2653.5, betterment: 120, shop_supplies: 143 } },
    { id: "u3", unit_label: "Pup", is_repairable: "Yes", actual_cash_value: 42000, appraiser_reserve: 10000, loss_status: "Repairable" },
  ],
  ...extra,
});

describe("Salvage appraisal report view", () => {
  it("lists every unit with its status, and totals the values", () => {
    const view = buildSalvageAppraisalView(report());
    expect(view.reportNumberText).toBe("Report Two");
    expect(view.units.map((u) => [u.heading, u.status])).toEqual([
      ["Unit 1 — Heavy Truck #807", "Constructive Total Loss"], ["Unit 2 — Lead", "Repairable"], ["Unit 3 — Pup", "Repairable"]]);
    expect(view.totals).toEqual({ value: 210000, reserve: 122500, salvage: 7000 });
    expect(view.subject).toBe("3 units");
  });

  it("letters appendices and links a unit's full estimate", () => {
    const view = buildSalvageAppraisalView(report());
    expect(view.appendices.map((a) => [a.letter, a.anchor, a.pageCount])).toEqual([["A", "salvage-appendix-a", 3], ["B", "salvage-appendix-b", 1]]);
    expect(view.units[0].repairNote).toMatch(/Appendix A/);
    expect(view.units[1].repairNote).toBe("");
  });

  it("prints a unit's typed repair totals with betterment taken off", () => {
    const lines = Object.fromEntries(buildSalvageAppraisalView(report()).units[1].repairLines.map((l) => [l.label, l.amount]));
    expect(lines).toMatchObject({ Parts: 4600, Labour: 2653.5, "Less Betterment": 120, "Shop Supplies": 143, TOTAL: 7276.5 });
  });

  it("never treats a blank older reserve (stored as 0) as a reserve", () => {
    const view = buildSalvageAppraisalView(report({ appraiser_reserve: undefined, additional_units: [] }));
    expect(view.units[0].reserve).toBeNull();
    expect(view.units[0].reserveText).toBe("Not established");
  });

  it("keeps claim fields for every unit but never another unit's fields", () => {
    const units = salvageReportUnits(report());
    expect(units[1]).toMatchObject({ claim_number: "C-1", unit_label: "Lead" });
    expect(units[1]).not.toHaveProperty("make");
    expect(units[1].repair_estimate_appendix).toBeUndefined();
  });

  it("reads amounts typed as text", () => {
    expect(money("$105,000.00")).toBe(105000);
    expect(money("N/A")).toBeNull();
    expect(money("2,000–3,000")).toBeNull();
    expect(money("Approx 10K")).toBeNull();
    expect(money("US$ 0.00")).toBe(0);
  });
});

describe("appraisal monetary presence and denomination", () => {
  it("keeps count separate from unknown reserve and labels a mixed-basis total neutrally", () => {
    const view = buildSalvageAppraisalView(report({ appraiser_reserve: undefined, recommended_reserve: 0,
      additional_units: [{ id: "u2", value_basis: "replacement", replacement_cost: 30000 }] }));
    expect(view.figures[0]).toMatchObject({ amount: null });
    expect(view.figures[0]).not.toHaveProperty("count");
    expect(view.figures[3]).toMatchObject({ amount: null, count: 2 });
    expect(view.totalValueLabel).toBe("Value");
    expect(view.figures[1]).toEqual({ label: "Value", amount: 135000 });
  });

  it.each([0, null])("preserves explicit additional-unit ACV %j instead of falling back to positive research", (amount) => {
    const a = buildSalvageAssessment({ inputs: { overrides: { preLoss: { amount: 50000, description: "Manual opinion", appraiserReason: "Documented appraiser amount retained for regression." } } } });
    const view = buildSalvageAppraisalView(report({ additional_units: [{ id: "u2", actual_cash_value: amount, assessment: a }] }));
    expect(view.units[1].valueAmount).toBe(amount);
    expect(view.totals.value).toBe(105000 + (amount ?? 0));
    expect(buildSalvageAppraisalView(report({ additional_units: [{ id: "u2", assessment: a }] })).units[1].valueAmount).toBe(50000);
  });

  it("preserves legacy USD labels and amounts without changing canonical CAD research", () => {
    const legacy = report({ currency: "USD", actual_cash_value: 12345, additional_units: [] });
    const before = structuredClone(legacy), view = buildSalvageAppraisalView(legacy);
    expect(view.currency).toBe("USD");
    expect(view.units[0].valueAmount).toBe(12345);
    expect(view.limitations.join(" ")).toContain("Values are in US dollars");
    expect(view.units[0].market.notes.providedBy.join(" ")).toContain("All values are in US dollars");
    expect(legacy).toEqual(before);
    expect(buildSalvageAppraisalView({ ...legacy, assessment: buildSalvageAssessment({ inputs: {} }) }).currency).toBe("CAD");
  });

  it("keeps known repair extras without presenting an incomplete assessment as a complete total", () => {
    const assessment = buildSalvageAssessment({ inputs: {} });
    const view = buildSalvageAppraisalView(report({ additional_units: [{ id: "u2", assessment, repair_summary: { shop_supplies: 35, taxes: 20 } }] }));
    expect(view.units[1].repairLines.at(-1)).toMatchObject({ label: "KNOWN SUBTOTAL", amount: 55 });
    expect(view.units[1].repairNote).toContain("complete repair estimate is not established");
    expect(view.units[1].market.repairTotal).toBeNull();
  });
});


describe("saved and unknown odometer display", () => {
  it.each([1000, 0, null])("does not let an absent photo field replace saved odometer %j with zero", (odometer) => {
    const assessment = buildSalvageAssessment({ inputs: { odometer, odometerUnit: "km" } });
    const view = buildSalvageAppraisalView({ assessment });
    const meter = view.units[0].market.groups.flatMap((group) => group.rows).find((row) => row.label === "Odometer");
    expect(meter?.client).toBe(odometer === null ? undefined : `${odometer.toLocaleString("en-CA")} km`);
  });
});
