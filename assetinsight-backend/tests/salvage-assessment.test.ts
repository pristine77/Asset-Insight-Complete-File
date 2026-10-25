import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildSalvageAssessment, normalizeSalvageAssessmentInputs, refreshSalvageAssessment,
  safeSalvageSourceUrl, validateSalvageAssessment, projectSalvageAssessmentLegacyFields, validateSalvageAssessmentInputs,
} from "../src/service/salvageAssessment.js";

const subject = {
  year: 2018, make: "Ford", model: "F-150", trim: "XLT", odometer: 150000,
  odometerUnit: "km", province: "ON", market: "Toronto", effectiveDate: "2026-09-08",
  vin: "1FTFW1ET1EFA12345", condition: "Collision damage", damageDescription: "Front body damage",
};
function comparable(index: number, price = 10000 + index * 1000, basket = "as_is", priceBasis = "sold") {
  const id = `ref-${index}`;
  const data = { id: `vehicle-${index}`, basket, title: `2018 Ford F-150 ${index}`, url: `https://auctions.example.ca/lots/${index}`,
    sourceName: "Fixture auctions", listingId: String(index), vin: `1FTFW1ET1EFA${String(index).padStart(5, "0")}`,
    year: 2018, make: "Ford", model: "F-150", trim: "XLT", powertrain: null,
    odometer: 145000 + index, odometerUnit: "km", condition: basket === "pre_loss" ? "Undamaged, normal wear" : "Collision damage", brand: basket === "pre_loss" ? "Normal" : "Salvage",
    location: "Toronto", province: "ON", country: "CA", eventDate: "2026-08-31",
    price, currency: "CAD", priceBasis, verification: "verified", referenceIds: [id], adjustments: [],
    evidence: {} as Record<string, { referenceId: string; quote: string }>,
  };
  const quote = `${data.year} ${data.make} ${data.model} ${data.condition}, brand ${data.brand} in ${data.location}. ${data.odometer} km. ${priceBasis === "sold" ? "Sold" : "Asking"} CAD ${price} on 2026-08-31.`;
  for (const field of ["year", "make", "model", "condition", "brand", "location", "price", "currency", "priceBasis", "odometer", "eventDate"]) data.evidence[field] = { referenceId: id, quote };
  const ref = { id, kind: "web", url: data.url, title: data.title, publisher: "Fixture auctions", accessedAt: "2026-09-08", excerpt: quote, photoIds: [] };
  return { data, ref };
}
function withFacts(item: ReturnType<typeof comparable>, changes: Partial<ReturnType<typeof comparable>["data"]>) {
  Object.assign(item.data, changes);
  const data = item.data;
  item.ref.excerpt = `${data.year} ${data.make} ${data.model} ${data.condition}, brand ${data.brand} in ${data.location}. ${data.odometer} ${data.odometerUnit}. ${data.priceBasis === "sold" ? "Sold" : "Asking"} CAD ${data.price} on ${data.eventDate}.`;
  Object.values(data.evidence).forEach((entry) => { entry.quote = item.ref.excerpt; });
  return item;
}
function assessment(count = 3, options: Record<string, unknown> = {}) {
  const items = Array.from({ length: count }, (_, index) => comparable(index + 1));
  return buildSalvageAssessment({ inputs: subject, candidates: items.map((item) => item.data), references: items.map((item) => item.ref), generatedAt: "2026-09-08T12:00:00Z", ...options });
}

describe("Canadian Salvage assessment normalization", () => {
  it("keeps financial unknowns null, defaults CAD and ignores unrecognized/provider keys", () => {
    const inputs = normalizeSalvageAssessmentInputs({ ...subject, currency: "USD", assessment: { status: "supported" }, odometer: "Not Found", sellerCosts: { fees: { amount: "", description: "Unknown" } }, repairItems: [{ quantity: 1, unitPrice: "CAD 100" }] });
    expect(inputs.currency).toBe("CAD");
    expect(inputs.odometer).toBeNull();
    expect(inputs.sellerCosts.fees?.amount).toBeNull();
    expect(inputs.repairItems[0].unitPrice).toBeNull();
    expect(inputs).not.toHaveProperty("assessment");
    const report = buildSalvageAssessment({ inputs });
    expect(report.valuations.preLoss.amount).toBeNull();
    expect(report.repairs.total).toBeNull();
    expect(report.netRecovery.total).toBeNull();
  });

  it("supports legacy input aliases without generating provenance", () => {
    const normalized = normalizeSalvageAssessmentInputs({ item_model: "F-150", item_condition: "Used", damage_description: "Front damage", reported_loss_type: "Collision", province: "Ontario", effective_date: "2026-09-08", repair_items: [{ name: "Fender", quantity: 2, unit_price: 120.5 }], labour_breakdown: [{ task: "Fit", hours: 3, rate_per_hour: 100 }] });
    expect(normalized.model).toBe("F-150");
    expect(normalized.province).toBe("ON");
    expect(normalized.condition).toBe("Used");
    expect(normalized.lossType).toBe("Collision");
    expect(normalized.repairItems[0]).toMatchObject({ description: "Fender", quantity: 2, unitPrice: 120.5 });
    expect(normalized.labourItems[0]).toMatchObject({ description: "Fit", hours: 3, rate: 100 });
    expect(normalized.repairItems[0].appraiserReason).toBeNull();
  });

  it("rejects impossible dates, negative amounts, partial VINs and numeric NaN", () => {
    const normalized = normalizeSalvageAssessmentInputs({ ...subject, effectiveDate: "2026-02-30", vin: "1234", odometer: -1, repairItems: [{ unitPrice: Infinity, quantity: -1 }] });
    expect(normalized.effectiveDate).toBeNull();
    expect(normalized.vin).toBeNull();
    expect(normalized.odometer).toBeNull();
    expect(normalized.repairItems[0]).toMatchObject({ unitPrice: null, quantity: null });
    expect(validateSalvageAssessmentInputs({ odometer: -1, effectiveDate: "2026-02-30", repairItems: [{ quantity: 1, unitPrice: "abc" }] })).toMatchObject({ valid: false });
    expect(validateSalvageAssessmentInputs({ ...subject, charges: [{ amount: 0 }], odometer: null })).toEqual({ valid: true, errors: [] });
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "https://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "https://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/", "https://host.internal/", "https://printer.local/", "https://169.254.169.254/latest", "https://127.0.0.1.nip.io/", "https://example.ca:8443/", "https://user:pass@example.ca/"])("rejects unsafe evidence URLs %s", (url) => {
    expect(safeSalvageSourceUrl(url)).toBeNull();
  });
  it("canonicalizes safe URLs without tracking parameters or fragments", () => {
    expect(safeSalvageSourceUrl("https://auctions.example.ca/lots/1?utm_source=x&lot=1#photos")).toBe("https://auctions.example.ca/lots/1?lot=1");
  });
});

describe("evidence-backed valuation", () => {
  it("uses median and observed range for three distinct same-basis vehicles", () => {
    const report = assessment();
    expect(report.valuations.asIs).toMatchObject({ amount: 12000, low: 11000, high: 13000, status: "supported", currency: "CAD", priceBasis: "sold" });
    expect(report.valuations.preLoss.amount).toBeNull();
    expect(report.valuations.asIs.method).toContain("not a confidence interval");
    expect(validateSalvageAssessment(report)).toEqual({ valid: true, errors: [] });
  });

  it("does not combine two sold and one asking price into a conclusion", () => {
    const items = [comparable(1), comparable(2), comparable(3, 14000, "as_is", "asking")];
    const report = assessment(0, { candidates: items.map((item) => item.data), references: items.map((item) => item.ref) });
    expect(report.valuations.asIs.amount).toBeNull();
    expect(report.valuations.asIs.comparableIds).toHaveLength(2);
  });

  it("labels asking-only median provisional and keeps pre-loss/as-is groups separate", () => {
    const items = [1, 2, 3].map((id) => comparable(id, 20000 + id * 1000, "pre_loss", "asking"));
    const report = assessment(0, { candidates: items.map((item) => item.data), references: items.map((item) => item.ref) });
    expect(report.valuations.preLoss).toMatchObject({ amount: 22000, status: "provisional", priceBasis: "asking" });
    expect(report.valuations.asIs.amount).toBeNull();
    expect(report.limitations.map((item) => item.code)).toContain("PRE_LOSS_ASKING_ONLY");
  });

  it.each(["Collision damage", "Flood damage", "Fire damage", "No body damage but flood damage", "Unrepaired front damage"])("does not place explicit %s into automatic pre-loss valuation", (condition) => {
    const items = [1, 2, 3].map((id) => withFacts(comparable(id, 20000 + id, "pre_loss"), { condition }));
    const report = assessment(0, { candidates: items.map((item) => item.data), references: items.map((item) => item.ref) });
    expect(report.valuations.preLoss.amount).toBeNull();
    expect(report.candidates.every((item) => item.exclusionReasons.some((reason) => reason.startsWith("Pre-loss basket")))).toBe(true);
  });

  it.each(["No damage", "No visible body damage", "Undamaged", "Repaired collision damage; normal wear", "Collision damage fully repaired; normal wear", "Sans dommages", "Sin daños"])("does not mistake %s for current damage or assign a legal brand", (condition) => {
    const item = withFacts(comparable(1, 25000, "pre_loss"), { condition });
    const report = assessment(0, { candidates: [item.data], references: [item.ref] });
    expect(report.candidates[0].eligible).toBe(true);
    expect(report.inputs.documentedBrand).toBeNull();
    expect(report.limitations.map((entry) => entry.code)).toContain("LEGAL_BRAND_UNVERIFIED");
  });

  it("flags unrepaired brands in pre-loss and conflicting as-is brands without treating post-loss brand as pre-loss", () => {
    const preLoss = withFacts(comparable(1, 25000, "pre_loss"), { brand: "Salvage" });
    expect(assessment(0, { candidates: [preLoss.data], references: [preLoss.ref] }).candidates[0].eligible).toBe(false);
    const asIs = withFacts(comparable(2), { brand: "Rebuilt" });
    const conflict = assessment(0, { inputs: { ...subject, documentedBrand: "Salvage" }, candidates: [asIs.data], references: [asIs.ref] });
    expect(conflict.candidates[0].exclusionReasons.join(" ")).toContain("brand conflicts");
    const normal = comparable(3, 25000, "pre_loss");
    expect(assessment(0, { inputs: { ...subject, documentedBrand: "Salvage" }, candidates: [normal.data], references: [normal.ref] }).candidates[0].eligible).toBe(true);
  });

  it("requires meaningful appraiser review for clear undamaged/damaged basket contradictions", () => {
    const item = withFacts(comparable(1), { condition: "Undamaged, normal wear", brand: "Normal" });
    const raw = assessment(0, { candidates: [{ ...item.data, appraiserReason: "ok" }], references: [item.ref] });
    expect(raw.candidates[0].exclusionReasons.join(" ")).toContain("Undamaged comparable conflicts");
    const reviewed = assessment(0, { candidates: [{ ...item.data, appraiserReason: "Appraiser reviewed the loss circumstances and documented suitability of this comparison." }], references: [item.ref] });
    expect(reviewed.candidates[0].eligible).toBe(true);
  });

  it("requires actual brand evidence, not a model assertion of a known brand", () => {
    const item = comparable(1); delete item.data.evidence.brand;
    expect(assessment(0, { candidates: [item.data], references: [item.ref] }).candidates[0].exclusionReasons).toContain("Missing verified brand evidence");
  });

  it("flags material mileage gaps with an explicit policy limitation and converts miles before comparison", () => {
    const far = withFacts(comparable(1), { odometer: 300000 });
    const equivalent = withFacts(comparable(2), { odometer: 93206, odometerUnit: "mi" });
    const report = assessment(0, { candidates: [far.data, equivalent.data], references: [far.ref, equivalent.ref] });
    expect(report.candidates.find((item) => item.listingId === "1")?.eligible).toBe(false);
    expect(report.candidates.find((item) => item.listingId === "2")?.eligible).toBe(true);
    expect(report.limitations.find((item) => item.code === "MILEAGE_SELECTION_POLICY")?.message).toContain("not a Canadian appraisal standard");
  });

  it("only accepts a supported mileage-specific adjustment or meaningful appraiser rationale for a mileage gap", () => {
    const item = withFacts(comparable(1), { odometer: 300000 });
    const adjustment = { description: "Equipment adjustment", amount: 1000, referenceIds: [], appraiserReason: "Documented extra equipment compared with the subject." };
    const unrelated = assessment(0, { candidates: [{ ...item.data, adjustments: [adjustment] }], references: [item.ref] });
    expect(unrelated.candidates[0].eligible).toBe(false);
    const unsupported = assessment(0, { candidates: [{ ...item.data, adjustments: [{ ...adjustment, description: "Mileage adjustment", appraiserReason: null }] }], references: [item.ref] });
    expect(unsupported.candidates[0].eligible).toBe(false);
    const supported = assessment(0, { candidates: [{ ...item.data, adjustments: [{ ...adjustment, description: "Mileage adjustment", appraiserReason: "Appraiser documented the mileage difference and adjustment from inspected condition." }] }], references: [item.ref] });
    expect(supported.candidates[0].eligible).toBe(true);
    const reviewed = assessment(0, { candidates: [{ ...item.data, appraiserReason: "Appraiser accepted the documented mileage difference after direct inspection." }], references: [item.ref] });
    expect(reviewed.candidates[0].eligible).toBe(true);
  });

  it.each(["reserve", "current_bid", "unknown"])("excludes %s from numeric values", (basis) => {
    const item = comparable(1); item.data.priceBasis = basis;
    const report = assessment(0, { candidates: [item.data], references: [item.ref] });
    expect(report.candidates[0].eligible).toBe(false);
    expect(report.candidates[0].exclusionReasons.join(" ")).toContain("price basis");
    expect(report.valuations.asIs.amount).toBeNull();
  });

  it("does not trust the model's verified label, unmatched quote, price or date", () => {
    const item = comparable(1);
    item.data.evidence.price.quote = "The sold price is CAD 9999999";
    const changedPrice = comparable(2); changedPrice.data.price = 50000;
    const changedDate = comparable(3); changedDate.data.eventDate = "2026-09-09";
    const report = assessment(0, { candidates: [item.data, changedPrice.data, changedDate.data], references: [item.ref, changedPrice.ref, changedDate.ref] });
    expect(report.candidates.every((candidate) => !candidate.eligible)).toBe(true);
    expect(report.candidates.flatMap((candidate) => candidate.exclusionReasons)).toContain("Missing verified price evidence");
    expect(report.valuations.asIs.amount).toBeNull();
  });

  it("requires dates, mileage and geographic subject inputs", () => {
    const item = comparable(1);
    item.data.eventDate = ""; item.data.odometerUnit = "";
    const report = assessment(0, { inputs: { ...subject, province: null }, candidates: [item.data], references: [item.ref] });
    expect(report.candidates[0].eligible).toBe(false);
    expect(report.limitations.map((item) => item.code)).toContain("SUBJECT_MARKET_INCOMPLETE");
  });

  it("retains old evidence only within one year and discloses expanded dates", () => {
    const items = [1, 2, 3].map((id) => comparable(id));
    for (const item of items) {
      item.data.eventDate = "2026-01-01";
      item.ref.excerpt = item.ref.excerpt.replace("2026-08-31", "2026-01-01");
      Object.values(item.data.evidence).forEach((value) => { value.quote = item.ref.excerpt; });
    }
    const report = assessment(0, { candidates: items.map((item) => item.data), references: items.map((item) => item.ref) });
    expect(report.valuations.asIs.amount).toBe(12000);
    expect(report.limitations.map((item) => item.code)).toContain("EXPANDED_EVIDENCE_DATES");
    expect(assessment(0, { inputs: { ...subject, effectiveDate: "2027-09-08" }, candidates: items.map((item) => item.data), references: items.map((item) => item.ref) }).valuations.asIs.amount).toBeNull();
  });

  it("deduplicates VINs, listing IDs, aliases and syndicated vehicle fingerprints", () => {
    const items = [1, 2, 3, 4].map((id) => comparable(id));
    items[1].data.vin = items[0].data.vin;
    items[2].data.vin = ""; items[2].data.listingId = items[0].data.listingId;
    items[3].data.vin = ""; items[3].data.price = items[0].data.price; items[3].data.odometer = items[0].data.odometer;
    items[3].data.evidence = items[0].data.evidence; items[3].data.referenceIds.push(items[0].ref.id);
    const report = assessment(0, { candidates: items.map((item) => item.data), references: items.map((item) => item.ref) });
    expect(report.candidates.filter((item) => item.eligible)).toHaveLength(1);
    expect(new Set(report.candidates.map((item) => item.id)).size).toBe(4);
    expect(report.valuations.asIs.amount).toBeNull();
  });

  it("caps investigation at20 and retains at most6 per valuation basket", () => {
    const items = Array.from({ length: 30 }, (_, index) => comparable(index + 1, 10000 + index, index < 10 ? "pre_loss" : "as_is"));
    const report = assessment(0, { candidates: items.map((item) => item.data), references: items.map((item) => item.ref) });
    expect(report.candidates).toHaveLength(20);
    expect(report.comparables.filter((item) => item.basket === "pre_loss")).toHaveLength(6);
    expect(report.comparables.filter((item) => item.basket === "as_is")).toHaveLength(6);
  });

  it("requires support for adjustments and transparently calculates supported amounts", () => {
    const items = [1, 2, 3].map((id) => comparable(id));
    const unsupported = { ...items[0].data, adjustments: [{ description: "Made up", amount: 1000 }] };
    expect(assessment(0, { candidates: [unsupported], references: [items[0].ref] }).candidates[0].eligible).toBe(false);
    const adjusted = items.map((item) => ({ ...item.data, adjustments: [{ description: "Documented equipment adjustment", amount: -500.125, appraiserReason: "Appraiser inspected missing equipment and documented the replacement quote.", referenceIds: [] }] }));
    expect(assessment(0, { candidates: adjusted, references: items.map((item) => item.ref) }).valuations.asIs.amount).toBe(11499.88);
  });

  it("does not treat unknown trim or powertrain as matching a known subject", () => {
    const item = comparable(1);
    const report = assessment(0, { inputs: { ...subject, powertrain: "3.5L V6" }, candidates: [{ ...item.data, trim: null }], references: [item.ref] });
    expect(report.candidates[0].eligible).toBe(false);
    expect(report.candidates[0].exclusionReasons.join(" ")).toContain("Unknown comparable trim");
    expect(report.candidates[0].exclusionReasons.join(" ")).toContain("Unknown comparable powertrain");
    const reviewed = assessment(0, { inputs: { ...subject, powertrain: "3.5L V6" }, candidates: [{ ...item.data, trim: null, appraiserReason: "Reviewed original equipment documentation and accepted this match." }], references: [item.ref] });
    expect(reviewed.candidates[0].eligible).toBe(true);
  });

  it("does not establish an adjustment by attaching an unrelated verified source", () => {
    const item = comparable(1);
    const report = assessment(0, { candidates: [{ ...item.data, adjustments: [{ description: "Unrelated adjustment", amount: 5000, referenceIds: [item.ref.id] }] }], references: [item.ref] });
    expect(report.candidates[0].exclusionReasons).toContain("Unsupported adjustment");
  });

  it("does not accept an arbitrary foreign-currency conversion", () => {
    const item = comparable(1); item.data.currency = "USD";
    const report = assessment(0, { candidates: [{ ...item.data, fx: { cadPerUnit: 1.35, date: subject.effectiveDate, referenceId: item.ref.id } }], references: [item.ref] });
    expect(report.candidates[0].exclusionReasons).toContain("Missing dated Bank of Canada conversion evidence");
  });

  it("requires the exact dated Bank of Canada observation to match a foreign conversion", () => {
    const items = [1, 2, 3].map((id) => comparable(id));
    for (const item of items) {
      item.data.currency = "USD";
      item.ref.excerpt = item.ref.excerpt.replace("CAD", "USD");
      Object.values(item.data.evidence).forEach((value) => { value.quote = item.ref.excerpt; });
    }
    const fx = { id: "ref-boc", kind: "web", url: "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2026-09-08&end_date=2026-09-08", title: "Daily rate", accessedAt: "2026-09-08", excerpt: '{"d":"2026-09-08","FXUSDCAD":{"v":"1.35"}}' };
    const candidates = items.map((item) => ({ ...item.data, fx: { cadPerUnit: 1.35, date: subject.effectiveDate, referenceId: fx.id } }));
    const report = assessment(0, { candidates, references: [...items.map((item) => item.ref), fx] });
    expect(report.valuations.asIs.amount).toBe(16200);
    expect(projectSalvageAssessmentLegacyFields(report).comparableItems).toEqual(expect.arrayContaining([expect.objectContaining({ price: "USD 11000.00" })]));
    candidates.forEach((item) => { item.fx.cadPerUnit = 8; });
    expect(assessment(0, { candidates, references: [...items.map((item) => item.ref), fx] }).valuations.asIs.amount).toBeNull();
    candidates.forEach((item) => { item.fx.cadPerUnit = 1.35; item.fx.date = "2026-09-04"; });
    const priorRate = { ...fx, excerpt: '{"d":"2026-09-04","FXUSDCAD":{"v":"1.35"}}' };
    const prior = assessment(0, { candidates, references: [...items.map((item) => item.ref), priorRate] });
    expect(prior.valuations.asIs.amount).toBe(16200);
    expect(prior.limitations.map((item) => item.code)).toContain("PRIOR_DATE_FX_OBSERVATION");
  });

  it("forces owner-supplied verified claims into attributed appraiser evidence", () => {
    const item = comparable(1);
    const inputs = normalizeSalvageAssessmentInputs({ ...subject, suppliedComparables: [item.data], suppliedReferences: [item.ref] });
    expect(inputs.suppliedComparables[0].verification).toBe("appraiser_supplied");
    expect(inputs.suppliedReferences[0].kind).toBe("appraiser");
    const report = buildSalvageAssessment({ inputs });
    expect(report.candidates[0].eligible).toBe(false);
  });

  it("cannot make a nonexistent uploaded photo into evidence or a comparable source", () => {
    const item = comparable(1);
    const report = assessment(0, { inputs: { ...subject, suppliedReferences: [{ id: "photo-proof", kind: "photo", title: "Sale receipt", excerpt: "Sale receipt", photoIds: ["photo-050"] }], suppliedComparables: [{ ...item.data, photoIds: ["photo-050"], referenceIds: ["photo-proof"], appraiserReason: "Reviewed the attached sale receipt." }] },
      photoFindings: [{ photoId: "photo-001", status: "not_analyzed", uncertainties: ["Unavailable"] }] });
    expect(report.references).toEqual([]);
    expect(report.candidates[0].photoIds).toEqual([]);
    expect(report.candidates[0].eligible).toBe(false);
    expect(report.limitations.map((item) => item.code)).toContain("PHOTO_REFERENCE_INVALID");
  });

  it("does not verify legal brand using a generic provincial guidance reference", () => {
    const ref = { id: "provincial", kind: "web", url: "https://www.ontario.ca/page/mandatory-vehicle-branding-program", title: "Ontario vehicle branding", accessedAt: "2026-09-08", excerpt: "Ontario salvage and rebuilt brands" };
    const report = assessment(0, { inputs: { ...subject, documentedBrand: "Salvage", brandProvince: "ON", brandEvidenceRef: ref.id }, references: [ref] });
    expect(report.limitations.map((item) => item.code)).toContain("LEGAL_BRAND_UNVERIFIED");
  });

  it("requires vehicle-specific appraiser-supplied document provenance for a stated brand", () => {
    const ref = { id: "brand-doc", kind: "photo", title: "Ontario vehicle registration", accessedAt: "2026-09-08", excerpt: `Ontario VIN ${subject.vin} status Salvage`, photoIds: ["photo-001"] };
    const inputs = { ...subject, documentedBrand: "Salvage", brandProvince: "ON", brandEvidenceRef: ref.id, suppliedReferences: [ref] };
    const photos = [{ photoId: "photo-001", status: "not_analyzed", uncertainties: [] }];
    expect(assessment(0, { inputs, photoFindings: photos }).limitations.map((item) => item.code)).not.toContain("LEGAL_BRAND_UNVERIFIED");
    expect(assessment(0, { inputs: { ...inputs, vin: "1FTFW1ET1EFA99999" }, photoFindings: photos }).limitations.map((item) => item.code)).toContain("LEGAL_BRAND_UNVERIFIED");
  });
});

describe("independent repository transport contract parity", () => {
  const source = readFileSync(resolve("src/service/salvageAssessment.ts"), "utf8");
  const definitions = source.slice(source.indexOf("/** Server-owned"), source.indexOf("export interface BuildSalvageAssessmentOptions"));
  for (const relative of ["../assetinsight-client/lib/salvageAssessment.ts", "../assetinsight-app/src/types/salvageAssessment.ts", "../assetinsight-admin/lib/salvageAssessment.ts"]) {
    const path = resolve(relative);
    // Each repository can build/test independently; when this workspace is
    // present, detect accidental drift in its separately shipped DTO copies.
    it.skipIf(!existsSync(path))(`matches backend schema in ${relative}`, () => {
      expect(readFileSync(path, "utf8")).toContain(definitions);
    });
  }
});

describe("deterministic totals, edits and provenance", () => {
  const reason = "Documented in the appraiser's dated supplier quotation.";
  const cost = (amount: number | null) => ({ amount, description: "Documented cost", referenceIds: [], appraiserReason: reason });
  it("calculates parts, labour and charges with line rounding and documented zero", () => {
    const report = assessment(0, { inputs: { ...subject, repairItems: [{ description: "Fender", quantity: 3, unitPrice: 10.125, appraiserReason: reason }], labourItems: [{ description: "Fit", hours: 1.25, rate: 100.1, appraiserReason: reason }], charges: [cost(0)] } });
    expect(report.repairs).toMatchObject({ partsTotal: 30.38, labourTotal: 125.13, chargesTotal: 0, total: 155.51, status: "complete" });
  });

  it("leaves an incomplete line unknown instead of making a complete zero estimate", () => {
    const report = assessment(0, { inputs: { ...subject, repairItems: [{ description: "Fender", quantity: 1, unitPrice: null, appraiserReason: reason }], labourItems: [{ description: "Fit", hours: 1, rate: 100, appraiserReason: reason }], charges: [cost(0)] } });
    expect(report.repairs).toMatchObject({ partsTotal: null, knownSubtotal: 100, total: null, status: "incomplete" });
  });

  it("requires quoted cost identity, quantity and rate evidence rather than a generic citation", () => {
    const ref = { id: "ref-quote", kind: "web", url: "https://parts.example.ca/quote/1", title: "Quote", accessedAt: "2026-09-08", excerpt: "Fender: CAD 120, quantity 2. Fit fender: 3 hours at CAD 100 per hour. Delivery CAD 25." };
    const inputs = { ...subject, repairItems: [{ description: "Fender", quantity: 2, unitPrice: 120, referenceIds: [ref.id] }], labourItems: [{ description: "Fit fender", hours: 3, rate: 100, referenceIds: [ref.id] }], charges: [{ description: "Delivery", amount: 25, referenceIds: [ref.id] }] };
    const supported = assessment(0, { inputs, references: [ref] });
    expect(supported.repairs.total).toBe(565);
    inputs.repairItems[0].quantity = 20;
    expect(assessment(0, { inputs, references: [ref] }).repairs.total).toBeNull();
    inputs.repairItems[0].quantity = 2; inputs.charges[0].amount = 500;
    expect(assessment(0, { inputs, references: [ref] }).repairs.total).toBeNull();
    expect(assessment(0, { inputs, references: [{ ...ref, excerpt: "A vehicle report without any quotation values." }] }).repairs.knownSubtotal).toBe(0);
  });

  it("requires each seller cost and subtracts seller-side costs, including explicit zero", () => {
    const allCosts = { fees: cost(500), transport: cost(200), storage: cost(0), disposal: cost(0) };
    const report = assessment(3, { inputs: { ...subject, sellerCosts: allCosts } });
    expect(report.netRecovery).toMatchObject({ gross: 12000, total: 11300, status: "complete", knownDeductions: 700 });
    expect(assessment(3, { inputs: { ...subject, sellerCosts: { ...allCosts, storage: null } } }).netRecovery).toMatchObject({ total: null, status: "incomplete", knownDeductions: 700 });
  });

  it("does not allow a missing cited reference to hide behind an appraiser reason", () => {
    const report = assessment(3, { inputs: { ...subject, overrides: { asIs: { ...cost(15000), referenceIds: ["does-not-exist"] } },
      repairItems: [{ description: "Fender", quantity: 1, unitPrice: 120, appraiserReason: reason, referenceIds: ["does-not-exist"] }],
      sellerCosts: { fees: { ...cost(500), referenceIds: ["does-not-exist"] }, transport: cost(0), storage: cost(0), disposal: cost(0) } } });
    expect(report.valuations.asIs.amount).toBe(12000);
    expect(report.repairs.partsTotal).toBeNull();
    expect(report.netRecovery.total).toBeNull();
  });

  it("preserves negative net recovery rather than silently clamping it", () => {
    const report = assessment(3, { inputs: { ...subject, sellerCosts: { fees: cost(15000), transport: cost(0), storage: cost(0), disposal: cost(0) } } });
    expect(report.netRecovery.total).toBe(-3000);
  });

  it("keeps supplied identity authoritative and reports conflicting photo findings", () => {
    const report = assessment(0, { photoFindings: [{ photoId: "photo-001", status: "analyzed", observations: ["Plate visible"], facts: [{ field: "make", value: "Toyota", evidence: "Badge reads Toyota", source: "observed" }], uncertainties: [] }, { photoId: "photo-002", status: "not_analyzed", observations: ["Should not survive"], uncertainties: ["Decode failed"] }] });
    expect(report.inputs.make).toBe("Ford");
    expect(report.photoFindings[1].observations).toEqual([]);
    expect(report.limitations.map((item) => item.code)).toEqual(expect.arrayContaining(["PHOTO_MAKE_CONFLICT", "PHOTOS_NOT_ANALYZED"]));
  });

  it("recalculates appraiser overrides without rewriting provenance or requiring new research", () => {
    const report = assessment();
    const original = structuredClone(report);
    const updated = refreshSalvageAssessment(report, { ...report.inputs, overrides: { asIs: cost(15000) } });
    expect(updated.valuations.asIs).toMatchObject({ amount: 15000, status: "appraiser_override" });
    expect(updated.stale).toBe(false);
    expect(updated.researchedInputs).toEqual(original.inputs);
    expect(updated.generatedAt).toEqual(original.generatedAt);
    expect(report).toEqual(original);
  });

  it("marks material subject changes stale while preserving the research baseline", () => {
    const report = assessment();
    const updated = refreshSalvageAssessment(report, { ...report.inputs, condition: "Fire damage", damageDescription: "Entire vehicle burned" });
    expect(updated.stale).toBe(true);
    expect(updated.researchedInputs.condition).toBe("Collision damage");
    expect(updated.limitations.map((item) => item.code)).toContain("RESEARCH_STALE");
    expect(refreshSalvageAssessment(updated, report.inputs).stale).toBe(false);
  });

  it("detects tampered totals and does not implicitly upgrade legacy values", () => {
    const report = assessment(); report.valuations.asIs.amount = 1;
    expect(validateSalvageAssessment(report)).toMatchObject({ valid: false });
    expect(validateSalvageAssessment({ valuation: { fairMarketValue: "$10000" } })).toMatchObject({ valid: false });
  });

  it("runtime validation fails closed without throwing for malformed nested persisted fields", () => {
    expect(validateSalvageAssessment({ ...assessment(), candidates: [null], references: [null] })).toEqual({ valid: false, errors: ["Malformed versioned assessment fields"] });
  });

  it("projects legacy fields from canonical conclusions, without equating reserve with salvage", () => {
    const projected = projectSalvageAssessmentLegacyFields(assessment());
    expect(projected).toMatchObject({ currency: "CAD", item_model: "F-150", actual_cash_value: null, replacement_cost: null, recommended_reserve: null,
      valuation: { fairMarketValue: "CAD 12000.00", as_is_salvage_value: 12000, pre_loss_market_value: null }, repair_estimate: { total: null, parts: null } });
    expect(projectSalvageAssessmentLegacyFields(assessment(0))).toMatchObject({ valuation: { fairMarketValue: "Unavailable" } });
  });
});
