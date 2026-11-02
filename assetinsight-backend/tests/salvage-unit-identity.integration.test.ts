import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import SalvageReport from "../src/models/salvage.model.js";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";
import { buildSalvageAppraisalView } from "../src/service/salvageAppraisalView.js";
import { mergeSalvageUnitsFromClient, normalizeStoredSalvageUnits } from "../src/service/salvageAppraisalFields.js";
import { salvageUnitResearchSnapshot } from "../src/service/salvageUnitResearch.js";
import { saveSalvagePreview } from "../src/service/salvageWorkflowService.js";
import { normalizeSalvageReportData } from "../src/service/salvageReportData.js";

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await mongoose.connection.db!.dropDatabase(); });

const assessment = () => buildSalvageAssessment({ inputs: {
  year: 2018, make: "Caterpillar", model: "950M", province: "SK", market: "Regina", effectiveDate: "2026-11-01",
  vehicleOverrides: { year: "2018", make: "Caterpillar", model: "950M", bodyType: "Wheel Loader", vin: "11111111111111111" },
  overrides: { preLoss: { amount: 50000, description: "Appraiser value", appraiserReason: "Documented manual value retained for regression." } },
}, vehiclePhotoExtraction: true });
const unit = () => { const a = assessment(); return { id: "u2", item_type: "Wheel Loader", year: "2018", make: "Caterpillar", item_model: "950M", vin: "11111111111111111", imageUrls: ["https://assetinsight.test/unit-2.jpg"], research: true, assessment: a, assessment_inputs: a.inputs }; };
const details = () => ({ user: new mongoose.Types.ObjectId(), report_date: "2026-11-01", file_number: "UNIT-IDENTITY", date_received: "2026-11-01", claim_number: "CLAIM", policy_number: "POLICY", appraiser_name: "Test Appraiser", appraiser_phone: "5551234567", appraiser_email: "qa@example.test", adjuster_name: "Adjuster", insured_name: "Insured", company_name: "Company", company_address: "Address", appraiser_comments: "Reviewed", next_report_due: "2026-11-02", imageUrls: [], currency: "CAD" });

describe("reviewed additional-unit identity", () => {
  it("persists accepted identity changes in current canonical inputs, rendering and the next research request", async () => {
    const oldUnit = unit(), baseline = structuredClone(oldUnit.assessment.researchedInputs);
    const preview = normalizeSalvageReportData({ ...details(), additional_units: [oldUnit] });
    const report = await SalvageReport.create({ ...details(), workflow_version: 1, status: "preview", revision: 3, job_id: "completed-generation", job_status: "done", preview_data: preview, additional_units: [oldUnit] });
    const stored: any = await SalvageReport.findById(report._id).lean();
    const edited: any = await saveSalvagePreview(stored, { additional_units: [{ id: "u2", make: "Komatsu", item_model: "WA500", vin: "22222222222222222", actual_cash_value: 0, assessment: { forged: true }, imageUrls: ["http://127.0.0.1/forged"] }] }, 3);
    const saved = edited.preview_data.additional_units[0];
    expect(saved).toMatchObject({ make: "Komatsu", item_model: "WA500", actual_cash_value: 0, assessment: { stale: true, inputs: { make: "Komatsu", model: "WA500", vin: "22222222222222222" } } });
    expect(saved.assessment.researchedInputs).toEqual(baseline);
    expect(saved.assessment.candidates).toEqual(oldUnit.assessment.candidates);
    expect(saved.assessment.references).toEqual(oldUnit.assessment.references);
    expect(saved.imageUrls).toEqual(oldUnit.imageUrls);
    expect(saved.assessment_inputs).toEqual(saved.assessment.inputs);
    expect(edited.additional_units).toEqual(edited.preview_data.additional_units);
    expect(edited.revision).toBe(4);
    const view = buildSalvageAppraisalView(edited.preview_data);
    expect(view.units[1].name).toContain("Komatsu WA500");
    expect(view.units[1].name).not.toMatch(/Caterpillar|950M/);
    expect(view.units[1].valueAmount).toBe(0);
    const request = salvageUnitResearchSnapshot(edited.preview_data, saved);
    expect(request.assessment_inputs).toMatchObject({ make: "Komatsu", model: "WA500", vin: "22222222222222222", province: "SK", market: "Regina" });
    expect(request.assessment.researchedInputs).toEqual(baseline);
  });

  it("preserves an explicit cleared identity and null amount without restoring old photo values", () => {
    const oldUnit = unit();
    const [saved] = mergeSalvageUnitsFromClient([oldUnit], [{ id: "u2", make: null, item_model: "", actual_cash_value: null }]);
    expect(saved.assessment.inputs).toMatchObject({ make: null, model: null });
    expect(saved.assessment.researchedInputs.make).toBe("Caterpillar");
    expect(saved.assessment.stale).toBe(true);
    const view = buildSalvageAppraisalView({ additional_units: normalizeStoredSalvageUnits([saved]) });
    expect(view.units[1].name).not.toMatch(/Caterpillar|950M/);
    expect(view.units[1].valueAmount).toBeNull();
  });

  it("repairs previously accepted inconsistent scalar identity on ordinary Save and on research", () => {
    const inconsistent = { ...unit(), make: "Komatsu", item_model: "WA500" };
    const [saved] = mergeSalvageUnitsFromClient([inconsistent], [{ id: "u2", make: "Komatsu", item_model: "WA500" }]);
    expect(saved.assessment.inputs).toMatchObject({ make: "Komatsu", model: "WA500" });
    expect(salvageUnitResearchSnapshot({}, inconsistent).assessment_inputs).toMatchObject({ make: "Komatsu", model: "WA500" });
    expect(buildSalvageAppraisalView({ additional_units: [inconsistent] }).units[1].name).toContain("Komatsu WA500");
  });

  it("leaves unchanged evidence and identity untouched on a partial unrelated edit", () => {
    const oldUnit = unit(), before = structuredClone(oldUnit);
    const [saved] = mergeSalvageUnitsFromClient([oldUnit], [{ id: "u2", appraiser_reserve: 0 }]);
    expect(saved.assessment).toEqual(before.assessment);
    expect(saved.assessment_inputs).toEqual(before.assessment_inputs);
    expect(saved.appraiser_reserve).toBe(0);
    expect(oldUnit).toEqual(before);
  });

  it("does not mark older canonical units stale merely because they lack photo-extracted vehicle details", () => {
    const oldAssessment = buildSalvageAssessment({ inputs: { year: 2018, make: "Caterpillar", model: "950M", vin: "11111111111111111" } });
    const oldUnit = { ...unit(), assessment: oldAssessment, assessment_inputs: oldAssessment.inputs };
    const [saved] = mergeSalvageUnitsFromClient([oldUnit], [{ id: "u2", item_type: "Wheel Loader", year: "2018", make: "Caterpillar", item_model: "950M" }]);
    expect(saved.assessment).toEqual(oldAssessment);
    expect(buildSalvageAppraisalView({ additional_units: [saved] }).units[1].market.notes.general.join(" ")).not.toContain("Material subject details changed");
  });
});
