import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: { get: mocks.get } }));
import { ReportDraftService, type ReportDraftRecord } from "./reportDrafts";

function fixture(count = 693): ReportDraftRecord {
  return {
    _id: "fixture", user: "owner", clientDraftId: "stable", type: "lotListing",
    storageMode: "r2_media", revision: 1, contractNo: "93257", formData: {},
    createdAt: "", updatedAt: "",
    lots: Array.from({ length: 85 }, (_, i) => ({ id: `lot-${i}`, lotNumber: String(i + 1), coverIndex: 0 })),
    media: Array.from({ length: count }, (_, i) => ({
      clientFileId: `photo-${i}`, lotId: `lot-${i % 75}`, slot: "main" as const,
      index: Math.floor(i / 75), originalOrder: i, name: `${i}.jpg`, mimeType: "image/jpeg", size: 1, lastModified: 1,
    })).reverse(),
  };
}

describe("account draft media restoration", () => {
  beforeEach(() => { mocks.get.mockReset(); });

  it.each(["duplicate-photo", "duplicate-lot", "unknown-lot", "unknown-slot"])("rejects %s mappings before downloading and never silently discards media", async (issue) => {
    const record = fixture(3);
    if (issue === "duplicate-photo") record.media[1].clientFileId = record.media[0].clientFileId;
    if (issue === "duplicate-lot") record.lots[1] = record.lots[0];
    if (issue === "unknown-lot") record.media[0].lotId = "missing-lot";
    if (issue === "unknown-slot") record.media[0].slot = "unknown" as "main";
    await expect(ReportDraftService.restoreLots(record)).rejects.toThrow(/saved draft/);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([0, 2])("rejects a downloaded size of %i rather than returning an incomplete original", async (size) => {
    mocks.get.mockResolvedValue({ data: new Blob(["x".repeat(size)]) });
    await expect(ReportDraftService.restoreLots(fixture(1))).rejects.toThrow(/Lot 1, photo 1.*incomplete/);
  });

  it("shows the affected lot, photo and safe reason from a binary API error", async () => {
    mocks.get.mockRejectedValue({ response: { status: 409, data: new Blob([JSON.stringify({ code: "DRAFT_MEDIA_MISSING", message: "private provider url" })]) } });
    await expect(ReportDraftService.restoreLots(fixture(1))).rejects.toThrow(/Lot 1, photo 1.*missing from storage/);
  });

  it("shows useful retry guidance for older backends returning a generic 404", async () => {
    mocks.get.mockRejectedValue({ response: { status: 404 } });
    await expect(ReportDraftService.restoreLots(fixture(1))).rejects.toThrow(/Retry loading the latest draft/);
  });

  it("restores 693 photos in saved lot order with four concurrent downloads and complete progress", async () => {
    let active = 0, peak = 0;
    mocks.get.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return { data: new Blob(["x"], { type: "image/jpeg" }) };
    });
    const progress = vi.fn();
    const lots = await ReportDraftService.restoreLots(fixture(), { onProgress: progress });
    expect(peak).toBe(4);
    expect(lots).toHaveLength(85);
    expect(lots.flatMap((lot) => lot.files || [])).toHaveLength(693);
    expect(lots[0].files?.map((file) => file.name)).toEqual(["0.jpg", "75.jpg", "150.jpg", "225.jpg", "300.jpg", "375.jpg", "450.jpg", "525.jpg", "600.jpg", "675.jpg"]);
    expect(lots.slice(75).every((lot) => lot.files?.length === 0)).toBe(true);
    expect(progress.mock.calls.map(([value]) => value.completed)).toEqual(Array.from({ length: 694 }, (_, i) => i));
    expect(progress).toHaveBeenLastCalledWith({ completed: 693, total: 693 });
  });

  it("cancels in-flight downloads and never starts queued photos after cancellation", async () => {
    const controller = new AbortController();
    mocks.get.mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const restoring = ReportDraftService.restoreLots(fixture(), { signal: controller.signal });
    const rejected = expect(restoring).rejects.toThrow();
    expect(mocks.get).toHaveBeenCalledTimes(4);
    controller.abort();
    await rejected;
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });

  it("does not return a partially restored lot array if any original fails", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Missing original"))
      .mockResolvedValue({ data: new Blob(["x"]) });
    await expect(ReportDraftService.restoreLots(fixture())).rejects.toThrow("Missing original");
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });

  it("preserves covers, extras and videos without counting or ordering them as main photos", async () => {
    mocks.get.mockResolvedValue({ data: new Blob(["x"]) });
    const record = fixture(3);
    record.lots = [{ id: "lot-0", coverIndex: 0 }];
    record.media = record.media.map((media, index) => ({ ...media, lotId: "lot-0", slot: (["video", "extra", "main"] as const)[index] }));
    const [lot] = await ReportDraftService.restoreLots(record);
    expect(lot.coverIndex).toBe(0);
    expect(lot.files?.map((file) => file.name)).toEqual(["0.jpg"]);
    expect(lot.extraFiles?.map((file) => file.name)).toEqual(["1.jpg"]);
    expect(lot.videoFiles?.map((file) => file.name)).toEqual(["2.jpg"]);
  });
});
