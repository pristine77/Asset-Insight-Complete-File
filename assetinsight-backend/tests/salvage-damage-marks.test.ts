/**
 * Damage the appraiser loops on Salvage photos (owner, 2026-11-01: "draw around
 * the damaged area so the software knows exactly where the damage is and
 * concentrates on the marked area"; freehand loop; the report prints the photo
 * with its loops; the loops are editable in the preview and saved). Loops are
 * checked, drawn on the copies the analysis and the report use, and each loop's
 * area is sent to the analysis as a close-up of the clean original.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({ get: vi.fn(), retrieve: vi.fn(), create: vi.fn() }));
vi.mock("axios", () => ({ default: { get: mocks.get } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { models: { retrieve: mocks.retrieve }, responses: { create: mocks.create } } }));

import { damageMarksByPhoto, drawDamageLoops, normalizeSalvageDamageMarks, salvageDamageCropBox } from "../src/utils/salvageDamageMarks.js";
import { prepareSalvagePhotos } from "../src/service/salvageImagePreparation.js";
import { runEnterpriseSalvageAssessment } from "../src/service/salvageResearchPipeline.js";
import { clearSalvageModelAccessCache } from "../src/service/salvageResearchExecution.js";
import { editableSalvageData, SALVAGE_EDITABLE_FIELDS } from "../src/service/salvageWorkflowService.js";

const response = (data: unknown) => ({ id: "resp", status: "completed", output_text: JSON.stringify(data), output: [],
  usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
/** A rough loop around the box (x, y, w, h), as fractions of the photo. */
const r4 = (value: number) => Math.round(value * 10000) / 10000;
const loop = (x: number, y: number, w: number, h: number) =>
  ({ points: [[x, y], [r4(x + w), y], [r4(x + w), r4(y + h)], [x, r4(y + h)]] as [number, number][] });
const grey = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#808080" } }).jpeg().toBuffer();

beforeEach(() => {
  vi.clearAllMocks();
  clearSalvageModelAccessCache();
  mocks.retrieve.mockImplementation(async (model: string) => ({ id: model }));
});

describe("checking the loops sent with a report or a preview save", () => {
  it("keeps valid loops per photo, sorted, derives each loop's box and drops slips of the pen", () => {
    expect(normalizeSalvageDamageMarks(undefined, 3)).toEqual([]);
    expect(normalizeSalvageDamageMarks([
      { photoIndex: 2, loops: [loop(0.1, 0.2, 0.3, 0.25)], regions: [{ x: 0, y: 0, width: 1, height: 1 }] },
      { photoIndex: 0, loops: [loop(0.5, 0.5, 0.005, 0.4), loop(0, 0, 1, 1)] },
      { photoIndex: 1, loops: [loop(0.4, 0.4, 0.001, 0.001)] },
    ], 3)).toEqual([
      { photoIndex: 0, loops: [loop(0, 0, 1, 1)], regions: [{ x: 0, y: 0, width: 1, height: 1 }] },
      // A box sent by the client is ignored; it is worked out from the points.
      { photoIndex: 2, loops: [loop(0.1, 0.2, 0.3, 0.25)], regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.25 }] },
    ]);
  });

  it("refuses loops on photos not in the report, outside the photo, repeated, too many or malformed", () => {
    expect(() => normalizeSalvageDamageMarks([{ photoIndex: 3, loops: [] }], 3)).toThrow("not in the report");
    expect(() => normalizeSalvageDamageMarks([{ photoIndex: 0.5, loops: [] }], 3)).toThrow("not in the report");
    expect(() => normalizeSalvageDamageMarks([{ photoIndex: 0, loops: [loop(0.8, 0, 0.5, 0.2)] }], 1)).toThrow("outside");
    expect(() => normalizeSalvageDamageMarks([{ photoIndex: 0, loops: [] }, { photoIndex: 0, loops: [] }], 2)).toThrow("twice");
    expect(() => normalizeSalvageDamageMarks([{ photoIndex: 0, loops: Array(5).fill(loop(0.1, 0.1, 0.2, 0.2)) }], 1)).toThrow("at most 4");
    expect(() => normalizeSalvageDamageMarks([{ photoIndex: 0, loops: [{ points: [[0.1, 0.1], [0.2, 0.2]] }] }], 1)).toThrow("between 3 and 400");
    expect(() => normalizeSalvageDamageMarks("marks", 1)).toThrow("list");
  });

  it("inspects one damaged area once: a loop redrawn over the same area replaces the first", () => {
    const [mark] = normalizeSalvageDamageMarks([{ photoIndex: 0, loops: [
      loop(0.1, 0.1, 0.3, 0.3), loop(0.6, 0.6, 0.2, 0.2), loop(0.12, 0.11, 0.3, 0.28),
    ] }], 1);
    expect(mark.loops).toEqual([loop(0.12, 0.11, 0.3, 0.28), loop(0.6, 0.6, 0.2, 0.2)]);
    expect(mark.regions).toHaveLength(2);
  });

  it("is a saved report field, so preview edits are kept and reach the next analysis", () => {
    expect(SALVAGE_EDITABLE_FIELDS).toContain("damage_marks");
    expect(editableSalvageData({ damage_marks: [{ photoIndex: 1, loops: [loop(0.1, 0.1, 0.2, 0.2)] }] }).damage_marks)
      .toEqual([{ photoIndex: 1, loops: [loop(0.1, 0.1, 0.2, 0.2)], regions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] }]);
    expect(() => editableSalvageData({ damage_marks: [{ photoIndex: 0, loops: "x" }] })).toThrow("at most 4");
  });

  it("lines the marks up with the photos", () => {
    const mark = normalizeSalvageDamageMarks([{ photoIndex: 1, loops: [loop(0.1, 0.1, 0.2, 0.2)] }], 3)[0];
    expect(damageMarksByPhoto([mark], 3)).toEqual([undefined, mark, undefined]);
  });
});

describe("the close-up of a marked area", () => {
  it("adds a 15% margin, stays inside the photo and is at least 64 px", () => {
    expect(salvageDamageCropBox({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 1000, 800))
      .toEqual({ left: 175, top: 140, width: 650, height: 520 });
    expect(salvageDamageCropBox({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 1000, 1000))
      .toEqual({ left: 885, top: 885, width: 115, height: 115 });
    expect(salvageDamageCropBox({ x: 0.5, y: 0.5, width: 0.01, height: 0.01 }, 1000, 1000).width).toBe(64);
  });

  it("is cut from the clean full-size original; the photo copy has the loops drawn on", async () => {
    mocks.get.mockResolvedValue({ data: await grey(4000, 3000) });
    const marks = normalizeSalvageDamageMarks([{ photoIndex: 0, loops: [loop(0.4, 0.4, 0.1, 0.1), loop(0, 0, 0.5, 0.5)] }], 1);
    const [photo] = await prepareSalvagePhotos(["https://fixture.test/1.jpg"], { damageMarks: marks, damageCloseUps: true });
    expect(photo.width).toBe(1600);
    expect(photo.damageCrops).toHaveLength(2);
    // 10% of 4000 px plus 15% each side is 520 px: native detail, not upscaled from 1600.
    expect((await sharp(photo.damageCrops![0]).metadata()).width).toBe(520);
    expect((await sharp(photo.damageCrops![1]).metadata()).width).toBe(1200);
    // The close-up is clean grey; the copy shows the red loop at its edge.
    const crop = await sharp(photo.damageCrops![0]).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(crop.data[0] - crop.data[1])).toBeLessThan(12);
    const copy = await sharp(photo.buffer).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => { const i = (y * copy.info.width + x) * 3; return [copy.data[i], copy.data[i + 1], copy.data[i + 2]]; };
    const [r, g] = at(Math.round(0.45 * 1600), Math.round(0.4 * 1200));
    expect(r).toBeGreaterThan(170);
    expect(g).toBeLessThan(110);
  });

  it("is not cut for the report, which only prints the loops", async () => {
    mocks.get.mockResolvedValue({ data: await grey(800, 600) });
    const marks = normalizeSalvageDamageMarks([{ photoIndex: 0, loops: [loop(0.2, 0.2, 0.3, 0.3)] }], 1);
    const [photo] = await prepareSalvagePhotos(["https://fixture.test/2.jpg"], { damageMarks: marks });
    expect(photo.damageCrops).toBeUndefined();
    const [plain] = await prepareSalvagePhotos(["https://fixture.test/3.jpg"]);
    expect(plain.buffer.equals(photo.buffer)).toBe(false);
  });

  it("draws nothing when a photo has no loops", async () => {
    const jpeg = await grey(100, 80);
    expect(await drawDamageLoops(jpeg, 100, 80, [])).toBe(jpeg);
  });
});

describe("the analysis of marked photos", () => {
  const answer = (params: any) => {
    const name = params.text.format.name;
    if (name === "salvage_photo_observations") {
      const ids = params.input[0].content.filter((part: any) => part.type === "input_text" && /^photo-\d+$/.test(part.text)).map((part: any) => part.text);
      return response({ photos: ids.map((photoId: string) => ({ photoId, observations: [], facts: [], uncertainties: [] })), repairSuggestions: [] });
    }
    if (name === "salvage_research_plan") return response({ summary: "", missingFacts: [], priorities: [], limitations: [] });
    return response({ issues: [], summary: "" });
  };

  it("tells the model about the loops and sends each close-up after its photo", async () => {
    mocks.get.mockResolvedValue({ data: await grey(1200, 900) });
    mocks.create.mockImplementation(async (params: any) => answer(params));
    await runEnterpriseSalvageAssessment({
      snapshot: { assessment_inputs: {} },
      imageUrls: ["https://fixture.test/a.jpg", "https://fixture.test/b.jpg"],
      damageMarks: normalizeSalvageDamageMarks([{ photoIndex: 1, loops: [loop(0.1, 0.1, 0.3, 0.3), loop(0.6, 0.5, 0.2, 0.2)] }], 2),
      onCheckpoint: vi.fn(),
    });
    const photoCall = mocks.create.mock.calls.find(([params]) => params.text.format.name === "salvage_photo_observations")![0];
    const content = photoCall.input[0].content;
    expect(content[0].text).toMatch(/^The appraiser drew red freehand loops on some photos to mark damage\./);
    expect(content.filter((part: any) => part.type === "input_text").slice(1).map((part: any) => part.text)).toEqual([
      "photo-001",
      "photo-002",
      "photo-002 marked damage area 1 of 2 (close-up)",
      "photo-002 marked damage area 2 of 2 (close-up)",
    ]);
    expect(content.filter((part: any) => part.type === "input_image")).toHaveLength(4);
  });

  it("says nothing about loops when no photo is marked", async () => {
    mocks.get.mockResolvedValue({ data: await grey(800, 600) });
    mocks.create.mockImplementation(async (params: any) => answer(params));
    await runEnterpriseSalvageAssessment({ snapshot: { assessment_inputs: {} }, imageUrls: ["https://fixture.test/a.jpg"], onCheckpoint: vi.fn() });
    const photoCall = mocks.create.mock.calls.find(([params]) => params.text.format.name === "salvage_photo_observations")![0];
    expect(photoCall.input[0].content[0].text).toMatch(/^Inspect each photo separately\./);
    expect(photoCall.input[0].content.filter((part: any) => part.type === "input_image")).toHaveLength(1);
  });
});
