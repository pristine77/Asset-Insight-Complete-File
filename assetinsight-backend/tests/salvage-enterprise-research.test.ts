import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), prepare: vi.fn(), fetch: vi.fn(), fx: vi.fn() }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { models: { retrieve: mocks.retrieve }, responses: { create: mocks.create } } }));
vi.mock("../src/service/salvageImagePreparation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/salvageImagePreparation.js")>(), prepareSalvagePhotos: mocks.prepare,
}));
vi.mock("../src/service/salvageEvidenceFetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/salvageEvidenceFetch.js")>(), fetchSalvageEvidence: mocks.fetch, fetchSalvageExchangeRate: mocks.fx,
}));
import { runEnterpriseSalvageAssessment, verifySalvageCandidate } from "../src/service/salvageResearchPipeline.js";
import { clearSalvageModelAccessCache, ensureSalvageModelAccess, newSalvageResearchCheckpoint, SalvageModelAccessError, SalvageResearchLimitError, salvageModel, SalvageResearchExecution } from "../src/service/salvageResearchExecution.js";
import { salvagePhotoBatches } from "../src/service/salvageImagePreparation.js";

const response = (data: any, extra = {}) => ({ id: "resp-fixture", status: "completed", output_text: JSON.stringify(data),
  usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 50 } }, output: [], ...extra });
const subject = { year: 2011, make: "Chevrolet", model: "Equinox", odometer: 150000, odometerUnit: "km", province: "ON", market: "Ottawa", effectiveDate: "2026-09-08" };
const request = { input: "Fixture only", max_output_tokens: 100, text: { format: { type: "json_schema" as const, name: "fixture", schema: { type: "object" }, strict: true } } };

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  clearSalvageModelAccessCache(); mocks.retrieve.mockImplementation(async (model: string) => ({ id: model }));
  mocks.prepare.mockImplementation(async (urls: string[]) => urls.map(() => ({ buffer: Buffer.from("fixture"), width: 1, height: 1 })));
  mocks.fetch.mockRejectedValue(new Error("No source fixture")); mocks.fx.mockResolvedValue(null);
  mocks.create.mockImplementation(async (params: any) => {
    const name = params.text.format.name;
    if (name === "salvage_photo_observations") {
      const ids = params.input[0].content.filter((part: any) => part.type === "input_text" && /^photo-/.test(part.text)).map((part: any) => part.text);
      return response({ photos: ids.map((photoId: string) => ({ photoId, observations: ["Front bumper visible."], facts: [], uncertainties: [] })), repairSuggestions: [] });
    }
    if (name === "salvage_research_plan") return response({ summary: "Local market evidence first.", missingFacts: [], priorities: ["Verify identity"], limitations: [] });
    if (name === "salvage_market_candidates") return response({ candidates: [], expansionReasons: [], limitations: [] },
      { output: [{ type: "web_search_call", action: { type: "search", sources: [{ url: "https://public.example.com/market" }] } }] });
    if (name === "salvage_repair_source_evidence") return response({ parts: [], limitations: [] },
      { output: [{ type: "web_search_call", action: { type: "search", sources: [{ url: "https://public.example.com/parts" }] } }] });
    return response({ issues: [], summary: "No unsupported prices supplied." });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Salvage execution and recovery", () => {
  it("verifies model access before work and caches only successful retrievals", async () => {
    mocks.retrieve.mockRejectedValueOnce({ status: 401 });
    const execution = new SalvageResearchExecution(newSalvageResearchCheckpoint("hash"), vi.fn());
    await expect(execution.json("stage", request)).rejects.toThrow(SalvageModelAccessError);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(execution.checkpoint.calls).toHaveLength(0);
    await ensureSalvageModelAccess("gpt-6-astra");
    await ensureSalvageModelAccess("gpt-6-astra");
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
  });
  it("keeps the Salvage-specific model and refuses unsupported overrides", () => {
    vi.stubEnv("OPENAI_PRIMARY_MODEL", "gpt-5.6-terra");
    expect(salvageModel()).toBe("gpt-6-astra");
    vi.stubEnv("OPENAI_SALVAGE_SEARCH_MODEL", "unsupported");
    expect(() => salvageModel(true)).toThrow(SalvageModelAccessError);
  });
  it("retains search evidence without retaining response usage", async () => {
    mocks.create.mockResolvedValue(response({ ok: true }, { output: [
      { type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com/listing" }] } },
      { type: "web_search_call", action: { type: "open_page", url: "https://example.com/listing" } },
    ] }));
    const checkpoint = newSalvageResearchCheckpoint("hash");
    const result = await new SalvageResearchExecution(checkpoint, vi.fn()).json("search", request, { search: true });
    expect(result).toEqual({ data: { ok: true }, consultedUrls: ["https://example.com/listing"], searchPerformed: true });
    expect(Object.keys(checkpoint.calls[0]!).sort()).toEqual(["consultedUrls", "id", "result", "searchPerformed", "stage", "status"]);
    expect(Object.keys(checkpoint).sort()).toEqual(["calls", "deadlineAt", "inputHash", "runId", "schemaVersion", "stages", "startedAt", "warnings"]);
  });
  it("does not infer a search from an unknown action", async () => {
    mocks.create.mockResolvedValue(response({ ok: true }, { output: [{ type: "web_search_call", action: { type: "future_action" } }] }));
    expect((await new SalvageResearchExecution(newSalvageResearchCheckpoint("hash"), vi.fn()).json("search", request)).searchPerformed).toBe(false);
  });
  it("persists intent before dispatch and reuses completed output without another call", async () => {
    const checkpoint = newSalvageResearchCheckpoint("hash");
    const save = vi.fn(async (saved) => { if (saved.calls[0]?.status === "reserved") expect(mocks.create).not.toHaveBeenCalled(); });
    await new SalvageResearchExecution(checkpoint, save).json("stage", request);
    expect(save.mock.calls[0]![0].calls[0].status).toBe("reserved");
    await new SalvageResearchExecution(structuredClone(checkpoint), vi.fn()).json("stage", request);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![1]).toMatchObject({ maxRetries: 0 });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ model: "gpt-6-astra", store: false });
  });
  it("does not dispatch if intent persistence fails", async () => {
    const execution = new SalvageResearchExecution(newSalvageResearchCheckpoint("hash"), async () => { throw new Error("Lease lost"); });
    await expect(execution.json("stage", request)).rejects.toThrow("Lease lost");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("stops after an ambiguous response, including on worker restart", async () => {
    const checkpoint = newSalvageResearchCheckpoint("hash");
    mocks.create.mockRejectedValue(new Error("Network timeout"));
    await expect(new SalvageResearchExecution(checkpoint, vi.fn()).json("stage", request)).rejects.toThrow("outcome is uncertain");
    expect(checkpoint.calls[0]!.status).toBe("uncertain");
    await expect(new SalvageResearchExecution(checkpoint, vi.fn()).json("another", request)).rejects.toThrow("uncertain outcome");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404])("surfaces model rejection %s without fallback", async (status) => {
    const checkpoint = newSalvageResearchCheckpoint("hash");
    mocks.create.mockRejectedValue({ status });
    await expect(new SalvageResearchExecution(checkpoint, vi.fn()).json("stage", request)).rejects.toThrow(SalvageModelAccessError);
    expect(checkpoint.calls[0]!.status).toBe("rejected");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("does not replay malformed output but accepts a valid response without usage", async () => {
    const checkpoint = newSalvageResearchCheckpoint("hash");
    mocks.create.mockResolvedValue(response({}, { output_text: "invalid" }));
    const execution = new SalvageResearchExecution(checkpoint, vi.fn());
    await expect(execution.json("bad", request)).rejects.toThrow("invalid");
    await expect(execution.json("bad", request)).rejects.toThrow("will not be requested again");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    mocks.create.mockResolvedValue(response({ ok: true }, { usage: null }));
    expect((await execution.json("valid", request)).data).toEqual({ ok: true });
  });
  it("bounds deadline, calls, text and image batch size before dispatch", async () => {
    const checkpoint = newSalvageResearchCheckpoint("hash");
    const execution = new SalvageResearchExecution(checkpoint, vi.fn());
    checkpoint.deadlineAt = new Date(0).toISOString();
    await expect(execution.json("stage", request)).rejects.toThrow("deadline");
    checkpoint.deadlineAt = new Date(Date.now() + 60_000).toISOString();
    await expect(execution.json("large", { ...request, input: "x".repeat(180_001) })).rejects.toThrow("request size");
    await expect(execution.json("photos", request, { imageCount: 11 })).rejects.toThrow("ten photos");
    checkpoint.calls = Array.from({ length: 12 }, (_, i) => ({ id: String(i), stage: String(i), status: "rejected" }));
    await expect(execution.json("next", request)).rejects.toThrow("call limit");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("Enterprise Salvage orchestration", () => {
  it("extracts vehicle/engine/workbook values from all photos, leaves unreadable values unknown and retains corrections on research", async () => {
    const defaultCreate = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (params: any) => {
      if (params.text.format.name !== "salvage_photo_observations") return defaultCreate(params);
      const ids = params.input[0].content.filter((part: any) => part.type === "input_text" && /^photo-/.test(part.text)).map((part: any) => part.text);
      return response({ photos: ids.map((photoId: string) => ({ photoId, observations: [], uncertainties: [], facts: photoId === "photo-011" ? [
        { field: "engineDisplacement", value: "6.7 L", evidence: "Engine label: 6.7 L" },
        { field: "engineMake", value: "Cummins", evidence: "Engine plate: Cummins" },
        { field: "vin", value: null, evidence: "VIN label unreadable" },
        { field: "spec:Wheelbase", value: "145 in", evidence: "Body label wheelbase: 145 in" },
      ] : photoId === "photo-001" ? [
        { field: "category", value: "Cars", evidence: "Four-door passenger car body visible." },
        { field: "make", value: "Ford", evidence: "Ford badge" },
        { field: "model", value: "Focus", evidence: "Focus badge" },
        { field: "year", value: "2020", evidence: "Probably a 2020 model" },
      ] : [] })), repairSuggestions: [] });
    });
    const imageUrls = Array.from({ length: 11 }, (_, i) => `fixture-${i}`);
    const first: any = await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: { province: "AB", market: "Calgary" } }, imageUrls, onCheckpoint: vi.fn() });
    const fields = first.assessment.vehicleDetails.fields;
    expect(fields.find((f: any) => f.key === "vin")).toMatchObject({ value: null, status: "unknown" });
    expect(fields.find((f: any) => f.key === "year")).toMatchObject({ value: null, status: "unknown" });
    expect(fields.find((f: any) => f.key === "engineDisplacement")).toMatchObject({ value: "6.7 L", status: "observed", evidence: [expect.objectContaining({ photoId: "photo-011", accepted: true })] });
    expect(fields.find((f: any) => f.key === "spec:Wheelbase")).toMatchObject({ value: "145 in", status: "observed" });
    expect(first.assessment_inputs).toMatchObject({ make: "Ford", model: "Focus", year: null, vin: null });
    expect(first.imageUrls).toEqual(imageUrls);
    const researchInput = mocks.create.mock.calls.find(([p]) => p.text.format.name === "salvage_research_plan")?.[0].input;
    expect(JSON.parse(researchInput).subject.vehicleSpecifications).toMatchObject({ engineMake: "Cummins", engineDisplacement: "6.7 L" });
    expect(JSON.parse(researchInput).subject.vehicleSpecifications).not.toHaveProperty("vin");
    const second: any = await runEnterpriseSalvageAssessment({ snapshot: { ...first,
      assessment_inputs: { ...first.assessment_inputs, vehicleOverrides: { model: "Appraiser correction", engineDisplacement: null } } }, imageUrls, onCheckpoint: vi.fn() });
    expect(second.assessment_inputs.model).toBe("Appraiser correction");
    expect(second.assessment.vehicleDetails.fields.find((f: any) => f.key === "engineDisplacement")).toMatchObject({ value: null, status: "manual" });
    expect(second.assessment.vehicleDetails.fields.find((f: any) => f.key === "make").status).toBe("observed");
    expect(second.assessment.vehicleDetails.fields.find((f: any) => f.key === "model").evidence).toEqual(fields.find((f: any) => f.key === "model").evidence);
    expect(mocks.create.mock.calls.find(([p]) => p.text.format.name === "salvage_photo_observations")?.[0].input[0].content[0].text).toContain("Never infer year, engine");
  });
  it.each([0, 1, 30, 31, 49, 50])("retains %i original photos and analyzes batches of at most ten", async (count) => {
    const urls = Array.from({ length: count }, (_, i) => `https://assetinsight.pro/salvage/photo-${i}.jpg`);
    const result = await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: subject }, imageUrls: urls, onCheckpoint: vi.fn() });
    expect(result.imageUrls).toEqual(urls);
    const assessment = result.assessment as any;
    expect(assessment.schemaVersion).toBe(2); expect(assessment.photoFindings).toHaveLength(count);
    expect(assessment.photoFindings.map((item: any) => item.photoId)).toEqual(urls.map((_, i) => `photo-${String(i + 1).padStart(3, "0")}`));
    expect(mocks.prepare.mock.calls.every(([photos]) => photos.length <= 10)).toBe(true);
    expect(mocks.prepare.mock.calls.flatMap(([photos]) => photos)).toEqual(urls);
    expect(assessment.research.analyzedPhotos).toBe(count);
  });
  it("rejects51 without uploading or calling AI", async () => {
    await expect(runEnterpriseSalvageAssessment({ snapshot: {}, imageUrls: Array(51).fill("unused"), onCheckpoint: vi.fn() })).rejects.toThrow("50");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("returns saved completed results without provider calls or changing manual identity", async () => {
    let checkpoint: any;
    const options = { snapshot: { assessment_inputs: subject, item_model: "Appraiser model" }, imageUrls: [], onCheckpoint: async (value: any) => { checkpoint = value; } };
    const result = await runEnterpriseSalvageAssessment(options);
    const callCount = mocks.create.mock.calls.length;
    expect(await runEnterpriseSalvageAssessment({ ...options, checkpoint })).toEqual(result);
    expect(mocks.create.mock.calls.length).toBe(callCount); expect(result.item_model).toBe("Equinox");
  });
  it("keeps every photo with explicit not-analyzed flags after a deadline stop", async () => {
    vi.spyOn(SalvageResearchExecution.prototype, "assertRemaining").mockImplementation(() => { throw new SalvageResearchLimitError("The research deadline was reached."); });
    const result = await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: subject }, imageUrls: ["a", "b"], onCheckpoint: vi.fn() });
    const assessment = result.assessment as any;
    expect(assessment.research.status).toBe("partial");
    expect(assessment.photoFindings.map((photo: any) => photo.status)).toEqual(["not_analyzed", "not_analyzed"]);
    expect(result.imageUrls).toEqual(["a", "b"]); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("never sends private metadata or VIN into web searches", async () => {
    await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: { ...subject, vin: "2CNALDEC1B6123456" },
      appraiser_email: "private@example.com", client_address: "123 Secret Road", claim_number: "SECRET-CLAIM" }, imageUrls: [], onCheckpoint: vi.fn() });
    const searches = mocks.create.mock.calls.filter(([params]) => params.tools?.length);
    expect(searches).toHaveLength(2);
    const payload = JSON.stringify(searches);
    for (const privateValue of ["private@example.com", "123 Secret Road", "SECRET-CLAIM", "2CNALDEC1B6123456"]) expect(payload).not.toContain(privateValue);
    expect(searches.every(([params]) => params.max_tool_calls === 4 && params.text.format.strict && params.tool_choice === "required")).toBe(true);
    expect(payload).toContain("Verify identity");
  });
  it("retains photo-linked repair concerns and verified parts prices without inventing quantities or labour", async () => {
    const original = mocks.create.getMockImplementation()!;
    const url = "https://parts.example.com/equinox-bumper";
    mocks.create.mockImplementation(async (params: any) => {
      if (params.text.format.name === "salvage_photo_observations") return response({ photos: [{ photoId: "photo-001", observations: ["Front bumper is broken."], facts: [], uncertainties: [] }],
        repairSuggestions: [{ description: "Replace front bumper", photoIds: ["photo-001"] }] });
      if (params.text.format.name === "salvage_repair_source_evidence") return response({ parts: [{ description: "Replace front bumper", url, title: "Front bumper",
        unitPrice: 120, currency: "CAD", priceQuote: "CAD 120", compatibilityQuote: "2011 Chevrolet Equinox" }], limitations: [] },
      { output: [{ type: "web_search_call", action: { type: "search", sources: [{ url }] } }] });
      return original(params);
    });
    mocks.fetch.mockImplementation(async (target: string) => {
      if (target !== url) throw new Error("Unavailable fixture");
      return { url, text: "Front bumper for 2011 Chevrolet Equinox. Price CAD 120", accessedAt: "2026-09-08", contentHash: "fixture" };
    });
    const result = await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: subject }, imageUrls: ["fixture-photo"], onCheckpoint: vi.fn() });
    const assessment = result.assessment as any;
    expect(assessment.inputs.repairItems[0]).toMatchObject({ description: "Replace front bumper", quantity: null, unitPrice: 120 });
    expect(assessment.references.some((ref: any) => ref.kind === "photo" && ref.photoIds.includes("photo-001"))).toBe(true);
    expect(assessment.repairs.total).toBeNull(); expect(assessment.repairs.labour).toEqual([]);
    const repairRequest = mocks.create.mock.calls.find(([params]) => params.text.format.name === "salvage_repair_source_evidence")![0];
    expect(repairRequest.input).toContain("no Markdown, citation syntax, quotation wrappers");
  });
  it("isolates unverified model search claims from report limitations and verified references", async () => {
    const original = mocks.create.getMockImplementation()!;
    const claim = "Copart vehicle 555 sold for CAD 4500. ([Copart](https://example.com/555?utm_source=x)) [1]";
    const unsafe = "Inspect [private](http://127.0.0.1/internal) and <script>alert(1)</script> [blocked](javascript:alert(1))";
    mocks.create.mockImplementation(async (params: any) => {
      const value = await original(params);
      if (params.text.format.name === "salvage_research_plan") return response({ summary: "AI proposed plan", missingFacts: [], priorities: [], limitations: ["Planner supplied an unverified claim"] });
      if (params.text.format.name === "salvage_market_candidates") return { ...value, output_text: JSON.stringify({ candidates: [], expansionReasons: [unsafe], limitations: [claim] }) };
      if (params.text.format.name === "salvage_quality_review") return response({ summary: "AI review summary", issues: [{ message: "Reviewer unsupported external claim", candidateIds: ["invented"], photoIds: [] }] });
      return value;
    });
    let checkpoint: any;
    const options = { snapshot: { assessment_inputs: subject }, imageUrls: [], onCheckpoint: async (saved: any) => { checkpoint = saved; } };
    const result = await runEnterpriseSalvageAssessment(options);
    const assessment = result.assessment as any;
    expect(result.analysis_warning).not.toContain("Copart");
    expect(result.analysis_warning).not.toContain("Planner supplied");
    expect(result.analysis_warning).not.toContain("Reviewer unsupported");
    expect(result.analysis_warning).toContain("no comparable candidates eligible");
    expect(result.analysis_warning).toContain("Quality review raised 1 unverified concern");
    expect(result.analysis_warning).not.toMatch(/\bAI\b|OpenAI|GPT-/);
    expect(assessment.references).toEqual([]);
    expect(assessment.research.preLossSearch.verification).toBe("unverified_provider_narrative");
    expect(assessment.research.preLossSearch.limitations[0]).toEqual({ text: "Copart vehicle 555 sold for CAD 4500. (Copart)", urls: ["https://example.com/555"] });
    expect(assessment.research.preLossSearch.expansionReasons[0].urls).toEqual([]);
    expect(JSON.stringify(assessment.research.preLossSearch)).not.toMatch(/127\.0\.0\.1|javascript:|<script>|\[1\]/);
    expect(assessment.research.qualityReview.issues[0]).toMatchObject({ text: "Reviewer unsupported external claim", candidateIds: [] });
    // Replay a pre-fix checkpoint: old promoted prose is removed without new calls.
    const callCount = mocks.create.mock.calls.length;
    delete checkpoint.result;
    checkpoint.warnings.push(claim, "Planner supplied an unverified claim", "Reviewer unsupported external claim");
    const replayed = await runEnterpriseSalvageAssessment({ ...options, checkpoint });
    expect(mocks.create.mock.calls).toHaveLength(callCount);
    expect(replayed.analysis_warning).not.toMatch(/Copart|Planner supplied|Reviewer unsupported/);
  });
  it("keeps repair search narrative unverified when no structured price was admitted", async () => {
    const original = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (params: any) => params.text.format.name === "salvage_repair_source_evidence"
      ? response({ parts: [], limitations: ["A dealer allegedly sells an engine for CAD 9000"] }, { output: [{ type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com/parts" }] } }] })
      : original(params));
    const result = await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: { ...subject, repairItems: [{ description: "Engine", quantity: null, unitPrice: null }] } }, imageUrls: [], onCheckpoint: vi.fn() });
    expect(result.analysis_warning).not.toContain("dealer allegedly");
    expect((result.assessment as any).research.repairSearch).toMatchObject({ verification: "unverified_provider_narrative", limitations: [{ text: "A dealer allegedly sells an engine for CAD 9000" }] });
    expect((result.assessment as any).repairs.total).toBeNull();
  });
  it("identifies batch range and total without treating other batches as missing photos", async () => {
    await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: subject }, imageUrls: Array.from({ length: 11 }, (_, index) => `fixture-${index}`), onCheckpoint: vi.fn() });
    const photos = mocks.create.mock.calls.filter(([params]) => params.text.format.name === "salvage_photo_observations");
    expect(photos[0][0].input[0].content[0].text).toContain("photos 1–10 of 11 total");
    expect(photos[1][0].input[0].content[0].text).toContain("photos 11–11 of 11 total");
    expect(photos[0][0].input[0].content[0].text).toContain("must not be described as missing");
    mocks.create.mock.calls.filter(([params]) => params.text.format.name === "salvage_market_candidates")
      .forEach(([params]) => expect(params.input).toContain("no Markdown, citation syntax, quotation wrappers"));
  });
  it("does not admit provincial navigation text and repairs an old navigation-only checkpoint on replay", async () => {
    const url = "https://www.ontario.ca/page/mandatory-vehicle-branding-program";
    const policy = "Vehicles branded salvage cannot be registered for road use until they are rebuilt and pass the required structural inspection.";
    mocks.fetch.mockResolvedValue({ url, text: "Home Menu Salvage Contact Login Print Accessibility", accessedAt: "2026-09-08" });
    let checkpoint: any;
    const options = { snapshot: { assessment_inputs: subject }, imageUrls: [], onCheckpoint: async (saved: any) => { checkpoint = saved; } };
    const result = await runEnterpriseSalvageAssessment(options);
    expect((result.assessment as any).research.provincialGuidance).toBeNull();
    expect((result.assessment as any).references).toEqual([]);
    const callCount = mocks.create.mock.calls.length;
    delete checkpoint.result;
    checkpoint.stages.provinceReference = { id: "ref-province-on", excerpt: "Home Menu Salvage Contact Login Print Accessibility", url };
    mocks.fetch.mockResolvedValue({ url, text: policy, accessedAt: "2026-09-08" });
    const replayed = await runEnterpriseSalvageAssessment({ ...options, checkpoint });
    expect(mocks.create.mock.calls).toHaveLength(callCount);
    expect((replayed.assessment as any).references[0]).toMatchObject({ id: "ref-province-on", excerpt: policy });
  });
  it("protects known legacy human identity when new form inputs contain unknown placeholders", async () => {
    const result = await runEnterpriseSalvageAssessment({ snapshot: { year: "2011", make: "Chevrolet", item_model: "Equinox",
      assessment_inputs: { year: null, make: null, model: null, province: "ON", market: "Ottawa" } }, imageUrls: [], onCheckpoint: vi.fn() });
    expect(result).toMatchObject({ year: "2011", make: "Chevrolet", item_model: "Equinox" });
  });
  it.each(["no_action", "no_sources"])("marks missing required public search evidence (%s) partial without inventing candidates", async (missing) => {
    const original = mocks.create.getMockImplementation()!;
    mocks.create.mockImplementation(async (params: any) => {
      const value = await original(params);
      if (params.text.format.name !== "salvage_market_candidates") return value;
      return { ...value, output: missing === "no_action" ? [] : [{ type: "web_search_call", action: { type: "search", sources: [] } }] };
    });
    const result = await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: subject }, imageUrls: [], onCheckpoint: vi.fn() });
    expect((result.assessment as any).research.status).toBe("partial");
    expect((result.assessment as any).candidates).toEqual([]);
    expect(result.analysis_warning).toContain(missing === "no_action" ? "confirmed web-search action" : "consulted public source URLs");
  });
  it("builds nested strict schemas with every property required and no additional properties", async () => {
    await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: subject }, imageUrls: ["fixture-photo"], onCheckpoint: vi.fn() });
    const check = (schema: any) => {
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required).toEqual(Object.keys(schema.properties));
        Object.values(schema.properties).forEach(check);
      }
      if (schema.type === "array") { expect(schema.maxItems).toBeGreaterThan(0); check(schema.items); }
    };
    mocks.create.mock.calls.forEach(([params]) => check(params.text.format.schema));
  });
  it("marks research partial when the final quality step reaches an execution limit", async () => {
    const original = SalvageResearchExecution.prototype.json;
    vi.spyOn(SalvageResearchExecution.prototype, "json").mockImplementation(function (this: SalvageResearchExecution, stage, ...args) {
      if (stage === "quality-review") throw new SalvageResearchLimitError("The research deadline was reached.");
      return original.call(this, stage, ...args);
    });
    const result = await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: subject }, imageUrls: [], onCheckpoint: vi.fn() });
    expect((result.assessment as any).research.status).toBe("partial");
    expect(mocks.create.mock.calls.some(([params]) => params.text.format.name === "salvage_quality_review")).toBe(false);
  });
  it.each([0, 1, 2, 10, 11, 30, 31, 49, 50])("photo batching preserves all indexes at count %i", (count) => {
    const urls = Array.from({ length: count }, (_, i) => String(i));
    const batches = salvagePhotoBatches(urls);
    expect(batches.flatMap((batch) => batch.urls)).toEqual(urls);
    expect(batches.every((batch) => batch.urls.length <= 10)).toBe(true);
  });
});

describe("Retrieved comparable evidence", () => {
  const url = "https://auction.example.com/lot/123";
  const candidate = { title: "2011 Chevrolet Equinox", url, price: 4500, currency: "CAD", priceBasis: "sold", year: 2011, make: "Chevrolet", model: "Equinox",
    fieldEvidence: [{ field: "price", quote: "Sold CAD 4,500" }, { field: "currency", quote: "Sold CAD 4,500" }, { field: "priceBasis", quote: "Sold CAD 4,500" },
      { field: "year", quote: "2011 Chevrolet Equinox" }, { field: "make", quote: "2011 Chevrolet Equinox" }, { field: "model", quote: "2011 Chevrolet Equinox" }] };
  it("requires actual source text, not only model-provided citation URLs", async () => {
    mocks.fetch.mockResolvedValue({ url, text: "2011 Chevrolet Equinox. Sold CAD 4,500.", accessedAt: "2026-09-08", contentHash: "fixturehash" });
    const good = await verifySalvageCandidate(candidate, "as_is", [url], Date.now() + 10000);
    expect(good.candidate).toMatchObject({ price: 4500, verification: "verified" });
    expect(good.reference?.excerpt).toContain("Sold CAD 4,500");
    mocks.fetch.mockResolvedValue({ url, text: "2011 Chevrolet Equinox. Price unavailable.", accessedAt: "2026-09-08" });
    const bad = await verifySalvageCandidate(candidate, "as_is", [url], Date.now() + 10000);
    expect(bad.candidate.price).toBeNull(); expect(bad.candidate.priceBasis).toBe("unknown");
    expect(bad.candidate.evidence.price).toBeUndefined();
  });
  it.each(["Winning bid CAD 4,500", "Not sold CAD 4,500", "Sold CAD 4,500 pending approval", "Current bid CAD 4,500"])('does not accept "%s" as completed sale', async (quote) => {
    mocks.fetch.mockResolvedValue({ url, text: `2011 Chevrolet Equinox. ${quote}`, accessedAt: "2026-09-08" });
    const value = { ...candidate, fieldEvidence: [{ field: "priceBasis", quote }] };
    expect((await verifySalvageCandidate(value, "as_is", [url], Date.now() + 10000)).candidate.priceBasis).toBe("unknown");
  });
  it("does not fetch an unattributed or private URL", async () => {
    expect((await verifySalvageCandidate(candidate, "as_is", [], Date.now() + 10000)).candidate.verification).toBe("unverified");
    expect((await verifySalvageCandidate({ ...candidate, url: "http://127.0.0.1/" }, "as_is", ["http://127.0.0.1/"], Date.now() + 10000)).candidate.url).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
