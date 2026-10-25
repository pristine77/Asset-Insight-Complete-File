import "fake-indexeddb/auto";
import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const create = vi.hoisted(() => ({ asset: vi.fn(), lot: vi.fn() }));
vi.mock("./asset", () => ({ AssetService: { create: create.asset } }));
vi.mock("./lotListing", () => ({ createLotListing: create.lot }));
import { describeOrderedFiles, orderedSubmissionFiles } from "./uploadJobFiles";
import { loadResumableDraft, markResumableNeedsForm, rememberResumableUpload, resetUploadResumeStoreForTests } from "./uploadResumeStore";
import { prepareResumeFromRecord, describeResumeOutcome } from "./uploadResumeRecovery";
let sequence = 0;
beforeEach(() => { vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("File", NativeFile); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
async function save(kind: "asset" | "lot-listing") {
  const ownerId = `recovery-owner-${++sequence}`;
  const photo = (name: string) => new File([name], name, { type: name.endsWith("mp4") ? "video/mp4" : "image/jpeg", lastModified: 4 });
  const lots = [{ id: "lot-a", files: [photo("a.jpg")], extraFiles: [photo("a-extra.jpg")], videoFiles: [photo("a.mp4")] }, { id: "lot-b", files: [photo("b.jpg")], extraFiles: [], videoFiles: [photo("b.mp4")] }];
  const media = orderedSubmissionFiles(kind, lots);
  const snapshot = { version: 3, revision: 7, savedAt: "2026-10-15", userId: ownerId, kind, ...(kind === "asset" ? { formData: { contractNo: "123", watermarkImages: false }, lots } : { data: { contractNo: "123", watermarkImages: false, lots } }) };
  const record = await rememberResumableUpload({ ownerId, kind, scopeId: "scope", endpoint: kind === "asset" ? "/asset" : "/lot-listing", title: "123", clientSubmissionId: "stable-submit", details: { client_submission_id: "stable-submit", contract_no: "123", mixed_lots: [{ count: 1, extra_count: 1, video_count: 1 }, { count: 1, video_count: 1 }] }, files: describeOrderedFiles(media), totalFiles: media.length, uploadedFiles: 0 }, media, snapshot);
  return { record, lots };
}
describe("immutable upload recovery after browser reload", () => {
  it.each(["asset", "lot-listing"] as const)("resumes %s with original bytes/order and same details despite no autosaved draft", async (kind) => {
    const { record, lots } = await save(kind); lots[0].files = []; resetUploadResumeStoreForTests();
    const outcome = await prepareResumeFromRecord(record); expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("fixture could not restore");
    expect(outcome.request.clientSubmissionId).toBe("stable-submit"); expect(outcome.request.skipPersist).toBe(true);
    expect(outcome.request.details).toEqual(record.details); expect(await outcome.request.media[0].text()).toBe("a.jpg");
    expect(outcome.request.media.map((file) => file.name)).toEqual(kind === "asset" ? ["a.jpg", "a-extra.jpg", "b.jpg", "a.mp4", "b.mp4"] : ["a.jpg", "a-extra.jpg", "a.mp4", "b.jpg", "b.mp4"]);
    const progress = vi.fn(), signal = new AbortController().signal;
    await outcome.request.upload(progress, signal);
    if (kind === "asset") {
      expect(create.asset.mock.calls[0][1].map((file: File) => file.name)).toEqual(["a.jpg", "a-extra.jpg", "b.jpg"]);
      expect(create.asset.mock.calls[0][2].map((file: File) => file.name)).toEqual(["a.mp4", "b.mp4"]);
    } else expect(create.lot.mock.calls[0][1][0].videoFiles[0].name).toBe("a.mp4");
  });
  it("does not rebuild from supplied metadata when the durable record is absent", async () => {
    const { record } = await save("asset"); const outcome = await prepareResumeFromRecord({ ...record, key: "missing" });
    expect(outcome.status).toBe("draft-missing"); expect(create.asset).not.toHaveBeenCalled();
  });
  it("uses durable metadata rather than a stale caller copy", async () => {
    const { record } = await save("asset");
    const outcome = await prepareResumeFromRecord({ ...record, details: { contract_no: "tampered" } });
    expect(outcome.status === "ready" && outcome.request.details).toEqual(record.details);
  });
  it("requires explicit review of durable conflicts after refresh", async () => {
    const { record } = await save("lot-listing");
    await markResumableNeedsForm(record.ownerId, record.kind, record.scopeId, record.clientSubmissionId);
    const outcome = await prepareResumeFromRecord(record); expect(outcome.status).toBe("error");
    expect(describeResumeOutcome(outcome)).toMatch(/Review saved report/);
    expect(await loadResumableDraft(record)).not.toBeNull(); expect(create.lot).not.toHaveBeenCalled();
  });
  it("rejects owner change/abort during recovery, retaining the original", async () => {
    const { record } = await save("asset"); const controller = new AbortController(); controller.abort();
    expect((await prepareResumeFromRecord(record, { signal: controller.signal })).status).toBe("error");
    expect(await loadResumableDraft(record)).not.toBeNull();
  });
  it("keeps recovery guidance useful and never displays raw HTTP codes", () => {
    expect(describeResumeOutcome({ status: "changed", reason: "identity" })).toMatch(/media order/);
    expect(describeResumeOutcome({ status: "media-missing", missing: 1 })).toMatch(/1 original media file/);
  });
});
