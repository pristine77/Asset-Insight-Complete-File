import { describe, expect, it } from "vitest";
import {
  createSalvageUnitsFromClient, mergeSalvageUnitsFromClient, normalizeSalvageAppraisalField, normalizeStoredSalvageUnits,
  SalvageAppraisalFieldError, SALVAGE_MAX_ADDITIONAL_UNITS,
} from "../src/service/salvageAppraisalFields.js";
import { mergeSalvageUnitResearch, salvageAppraiserProfileFor, salvageUnitResearchSnapshot } from "../src/service/salvageUnitResearch.js";

// The full MCD Appraisals report (owner, 2026-11-01): several units, new fields.
const loop = { points: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]] };

describe("Salvage units sent with a new report", () => {
  it("assigns stable ids, keeps photo counts and drops server-owned fields", () => {
    const units = createSalvageUnitsFromClient([
      { unit_label: "Lead trailer", photo_count: 2, imageUrls: ["https://evil.example/x.jpg"], assessment: { schemaVersion: 2 }, id: "u-mine" },
      { unit_label: "Bin 4", photo_count: 0 },
    ]);
    expect(units.map((u) => u.id)).toEqual(["u2", "u3"]);
    expect(units[0]).toMatchObject({ unit_label: "Lead trailer", photo_count: 2, imageUrls: [], research: true });
    expect(units[0]).not.toHaveProperty("assessment");
    // No photos: nothing to research.
    expect(units[1].research).toBe(false);
  });

  it("keeps the appraiser's choice to skip research", () => {
    expect(createSalvageUnitsFromClient([{ photo_count: 3, research: false }])[0].research).toBe(false);
  });

  it("checks loops against the unit's own photos", () => {
    expect(createSalvageUnitsFromClient([{ photo_count: 1, damage_marks: [{ photoIndex: 0, loops: [loop] }] }])[0].damage_marks).toHaveLength(1);
    expect(() => createSalvageUnitsFromClient([{ photo_count: 1, damage_marks: [{ photoIndex: 3, loops: [loop] }] }])).toThrow();
  });

  it("limits units and photos", () => {
    expect(() => createSalvageUnitsFromClient(Array.from({ length: SALVAGE_MAX_ADDITIONAL_UNITS + 1 }, () => ({})))).toThrow(SalvageAppraisalFieldError);
    expect(() => createSalvageUnitsFromClient([{ photo_count: 51 }])).toThrow(/at most 50/);
    expect(() => createSalvageUnitsFromClient([{ photo_count: 50 }, { photo_count: 50 }, { photo_count: 50 }, { photo_count: 1 }])).toThrow(/150/);
  });

  it("refuses unknown loss statuses and over-long text", () => {
    expect(() => createSalvageUnitsFromClient([{ loss_status: "Destroyed" }])).toThrow(/loss_status/);
    expect(() => createSalvageUnitsFromClient([{ licence_plate: "x".repeat(41) }])).toThrow(/too long/);
  });

  it("accepts loops for photos a new unit declared but has not saved yet", () => {
    const [unit] = createSalvageUnitsFromClient([{ photo_count: 2, damage_marks: [{ photoIndex: 1, loops: [loop] }] }]);
    expect(normalizeStoredSalvageUnits([unit])[0].damage_marks).toHaveLength(1);
  });
});

describe("Salvage units saved from the preview", () => {
  const saved = [{ id: "u2", unit_label: "Lead", imageUrls: ["https://cdn.example/u2/1.jpg", "https://cdn.example/u2/2.jpg"],
    assessment: { schemaVersion: 2, valuations: {} }, research: true }];

  it("keeps each unit's saved photos and research and applies the edits", () => {
    const [unit] = mergeSalvageUnitsFromClient(saved, [{ id: "u2", unit_label: "Lead trailer", appraiser_reserve: "7,500",
      imageUrls: ["https://evil.example/x.jpg"], assessment: { forged: true } }]);
    expect(unit.imageUrls).toEqual(saved[0].imageUrls);
    expect(unit.assessment).toEqual(saved[0].assessment);
    expect(unit).toMatchObject({ unit_label: "Lead trailer", appraiser_reserve: 7500 });
  });

  it("adds a new unit without photos and drops its loops", () => {
    const units = mergeSalvageUnitsFromClient(saved, [saved[0], { unit_label: "Bin 4", imageUrls: ["https://evil.example/y.jpg"], damage_marks: [{ photoIndex: 0, loops: [loop] }] }]);
    expect(units).toHaveLength(2);
    expect(units[1].id).toMatch(/^u-/);
    expect(units[1].imageUrls).toEqual([]);
    expect(units[1]).not.toHaveProperty("damage_marks");
  });

  it("removes and reorders by the browser's list", () => {
    const two = [...saved, { id: "u3", imageUrls: [] }];
    expect(mergeSalvageUnitsFromClient(two, [{ id: "u3" }, { id: "u2" }]).map((u) => u.id)).toEqual(["u3", "u2"]);
    expect(mergeSalvageUnitsFromClient(two, [{ id: "u3" }]).map((u) => u.id)).toEqual(["u3"]);
  });

  it("checks edited loops against the saved unit's photos", () => {
    expect(() => mergeSalvageUnitsFromClient(saved, [{ id: "u2", damage_marks: [{ photoIndex: 5, loops: [loop] }] }])).toThrow();
  });
});

describe("Salvage appraisal fields", () => {
  it("normalizes report and unit fields", () => {
    expect(normalizeSalvageAppraisalField("report_number", "2")).toBe(2);
    expect(() => normalizeSalvageAppraisalField("report_number", 0)).toThrow();
    expect(normalizeSalvageAppraisalField("value_basis", "replacement")).toBe("replacement");
    expect(() => normalizeSalvageAppraisalField("value_basis", "market")).toThrow();
    expect(normalizeSalvageAppraisalField("appraiser_reserve", "")).toBeNull();
    expect(normalizeSalvageAppraisalField("appraiser_reserve", "$105,000.00")).toBe(105000);
    expect(() => normalizeSalvageAppraisalField("appraiser_reserve", -1)).toThrow();
    expect(normalizeSalvageAppraisalField("repair_summary", { betterment: "138.60", taxes: "", other: 5 })).toEqual({ betterment: 138.6, taxes: null });
  });
});

describe("Salvage unit research and appraiser profile", () => {
  it("researches a unit in the claim's market", () => {
    const snapshot = salvageUnitResearchSnapshot({ assessment_inputs: { province: "SK", market: "Regina", repairItems: [{}] }, reported_loss_type: "Roll-over" },
      { year: "2022", make: "Doepker", item_model: "Lead", damage_description: "Frame twisted" });
    expect(snapshot.assessment_inputs).toMatchObject({ province: "SK", market: "Regina", damageDescription: "Frame twisted" });
    expect(snapshot.assessment_inputs).not.toHaveProperty("repairItems");
    expect(snapshot).toMatchObject({ make: "Doepker", reported_loss_type: "Roll-over" });
  });

  it("fills only blank identity from research", () => {
    const merged = mergeSalvageUnitResearch({ make: "Doepker", year: "" }, { analysis_warning: "w" });
    expect(merged).toMatchObject({ make: "Doepker", analysis_warning: "w" });
  });

  it("signs only reports that name the profile's owner as appraiser", () => {
    const owner = { name: "Jordan Reid", email: "jordan@example.ca", appraiserProfile: { designation: "CPPA", title: "Appraiser",
      signatureUrl: "https://cdn.example/sig.png", cvPdfUrl: "https://cdn.example/cv.pdf" } };
    const mine = salvageAppraiserProfileFor({ appraiser_name: "Someone", appraiser_email: "JORDAN@example.ca" }, owner);
    expect(mine).toMatchObject({ designation: "CPPA", signatureUrl: "https://cdn.example/sig.png", cvUrl: "https://cdn.example/cv.pdf", name: "Someone" });
    const theirs = salvageAppraiserProfileFor({ appraiser_name: "Pat Lee", appraiser_email: "pat@example.ca" }, owner);
    expect(theirs).not.toHaveProperty("signatureUrl");
    expect(theirs).not.toHaveProperty("cvUrl");
    expect(theirs.name).toBe("Pat Lee");
  });
});
