import "fake-indexeddb/auto";
import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { openDB } from "idb";
import { advanceAuthSession } from "@/lib/auth-storage";
import { describeOrderedFiles } from "./uploadJobFiles";
import { attachResumableSession, forgetOwnerResumableUploads, forgetResumableUpload, getResumableUpload, listResumableUploads, loadResumableDraft, markResumableNeedsForm, recordResumableProgress, rememberResumableUpload, resetUploadResumeStoreForTests, resumeKey } from "./uploadResumeStore";

let sequence = 0;
beforeEach(() => { vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("File", NativeFile); });
afterEach(() => vi.unstubAllGlobals());
function fixture(kind: "asset" | "lot-listing" = "asset") {
  const ownerId = `snapshot-owner-${++sequence}`;
  const media = [new File(["untouched original"], "photo.jpg", { type: "image/jpeg", lastModified: 17 }), new File(["original clip"], "clip.mp4", { type: "video/mp4", lastModified: 23 })];
  const lots = [{ id: "lot-1", files: [media[0]], extraFiles: [], videoFiles: [media[1]], coverIndex: 0 }];
  const snapshot = { version: 3, userId: ownerId, kind, revision: 9, savedAt: "2026-10-15", ...(kind === "asset" ? { formData: { clientSubmissionId: "submission-1" }, lots } : { data: { clientSubmissionId: "submission-1", lots } }) };
  const record = { ownerId, kind, scopeId: "scope-1", endpoint: kind === "asset" ? "/asset" as const : "/lot-listing" as const, clientSubmissionId: "submission-1", title: "Report", details: { contract_no: "123", client_submission_id: "submission-1" }, files: describeOrderedFiles(media), totalFiles: media.length, uploadedFiles: 0 };
  return { record, media, snapshot, lots };
}
describe("immutable background upload storage", () => {
  it.each(["asset", "lot-listing"] as const)("keeps %s originals, order, metadata and envelope after reload without any editable draft", async (kind) => {
    const f = fixture(kind);
    const pending = rememberResumableUpload(f.record, f.media, f.snapshot);
    f.record.details.contract_no = "changed later";
    f.lots[0].id = "later edit";
    const saved = await pending;
    resetUploadResumeStoreForTests();
    const listed = await listResumableUploads(saved.ownerId);
    const loaded = await loadResumableDraft(listed[0]);
    expect(loaded?.record.details.contract_no).toBe("123");
    expect(await loaded?.media[0].text()).toBe("untouched original");
    expect(await loaded?.media[1].text()).toBe("original clip");
    expect(loaded?.media.map((file) => [file.name, file.type, file.lastModified])).toEqual([["photo.jpg", "image/jpeg", 17], ["clip.mp4", "video/mp4", 23]]);
    const envelope = loaded?.envelope as { lots?: typeof f.lots; data?: { lots?: typeof f.lots } };
    const lots = kind === "asset" ? envelope.lots : envelope.data?.lots;
    expect(lots?.[0].id).toBe("lot-1");
    expect(lots?.[0].files[0]).toBe(loaded?.media[0]);
    expect(await listResumableUploads("some-other-owner")).toEqual([]);
  });
  it("rejects a changed re-handoff even with identical file metadata, preserving original bytes", async () => {
    const f = fixture(); const saved = await rememberResumableUpload(f.record, f.media, f.snapshot);
    const replacement = new File(["different photo!!"], f.media[0].name, { type: f.media[0].type, lastModified: f.media[0].lastModified });
    const media = [replacement, f.media[1]];
    const changed = { ...f.snapshot, lots: [{ ...f.lots[0], files: [replacement] }] };
    await expect(rememberResumableUpload({ ...f.record, files: describeOrderedFiles(media) }, media, changed)).rejects.toThrow(/already saved/);
    expect(await (await loadResumableDraft(saved))?.media[0].text()).toBe("untouched original");
  });
  it("fails closed with unavailable browser storage", async () => {
    const f = fixture(); resetUploadResumeStoreForTests(); vi.stubGlobal("indexedDB", undefined);
    await expect(rememberResumableUpload(f.record, f.media, f.snapshot)).rejects.toThrow(/storage is unavailable/);
  });
  it("rolls back metadata and originals if IndexedDB runs out of storage midway", async () => {
    const f = fixture();
    const originalAdd = IDBObjectStore.prototype.add;
    const failing = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "media") throw new DOMException("Storage is full", "QuotaExceededError");
      return originalAdd.apply(this, args);
    });
    await expect(rememberResumableUpload(f.record, f.media, f.snapshot)).rejects.toThrow(/free device storage/);
    failing.mockRestore();
    expect(await listResumableUploads(f.record.ownerId)).toEqual([]);
    const database = await openDB("cv-upload-snapshots");
    expect((await database.getAllKeys("snapshots")).filter((key) => String(key).includes(f.record.ownerId))).toEqual([]);
    expect((await database.getAllKeys("media")).filter((key) => String(key).includes(f.record.ownerId))).toEqual([]);
    database.close();
  });
  it("rejects missing original bytes instead of restoring an empty photo list", async () => {
    const f = fixture(); const saved = await rememberResumableUpload(f.record, f.media, f.snapshot);
    const database = await openDB("cv-upload-snapshots");
    await database.delete("media", `${saved.key}:0`); database.close();
    await expect(loadResumableDraft(saved)).rejects.toThrow(/original media could not be read/);
    expect(await listResumableUploads(saved.ownerId)).toHaveLength(1);
  });
  it("aborts the whole atomic snapshot if the caller/account changes while saving", async () => {
    const f = fixture(); let checks = 0;
    await expect(rememberResumableUpload(f.record, f.media, f.snapshot, { isCurrent: () => ++checks < 5 })).rejects.toThrow();
    expect(await listResumableUploads(f.record.ownerId)).toEqual([]);
  });
  it("refuses an already aborted handoff without writing anything", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(rememberResumableUpload(f.record, f.media, f.snapshot, { signal: controller.signal })).rejects.toThrow();
    expect(await listResumableUploads(f.record.ownerId)).toEqual([]);
  });
  it("rejects incomplete media, wrong owner and omitted snapshot", async () => {
    const f = fixture();
    await expect(rememberResumableUpload(f.record, f.media.slice(1), f.snapshot)).rejects.toThrow();
    await expect(rememberResumableUpload(f.record, f.media, { ...f.snapshot, userId: "other" })).rejects.toThrow(/account/);
    await expect(rememberResumableUpload(f.record, f.media, null)).rejects.toThrow();
    expect(await listResumableUploads(f.record.ownerId)).toEqual([]);
  });
  it("retains all owner snapshots on logout and precisely cleans only the accepted identity", async () => {
    const f = fixture(); const first = await rememberResumableUpload(f.record, f.media, f.snapshot);
    const second = await rememberResumableUpload({ ...f.record, clientSubmissionId: "submission-2", details: { ...f.record.details, client_submission_id: "submission-2" } }, f.media, f.snapshot);
    await forgetOwnerResumableUploads(first.ownerId);
    expect(await listResumableUploads(first.ownerId)).toHaveLength(2);
    await forgetResumableUpload(first.ownerId, first.kind, first.scopeId);
    expect(await listResumableUploads(first.ownerId)).toHaveLength(2);
    await forgetResumableUpload(first.ownerId, first.kind, first.scopeId, first.clientSubmissionId);
    expect(await loadResumableDraft(first)).toBeNull();
    expect(await (await loadResumableDraft(second))?.media[0].text()).toBe("untouched original");
  });
  it("persists exact-session identity, progress and review-only state without overwriting another attempt", async () => {
    const f = fixture(); const saved = await rememberResumableUpload(f.record, f.media, f.snapshot);
    await attachResumableSession(saved.ownerId, saved.kind, saved.scopeId, "session-a", saved.clientSubmissionId);
    await expect(attachResumableSession(saved.ownerId, saved.kind, saved.scopeId, "session-b", saved.clientSubmissionId)).rejects.toThrow(/session changed/);
    await recordResumableProgress(saved.ownerId, saved.kind, saved.scopeId, 100, saved.clientSubmissionId);
    await markResumableNeedsForm(saved.ownerId, saved.kind, saved.scopeId, saved.clientSubmissionId);
    expect(await getResumableUpload(saved.ownerId, saved.kind, saved.scopeId, saved.clientSubmissionId)).toMatchObject({ sessionId: "session-a", uploadedFiles: 2, needsForm: true });
  });
  it("fails a delayed deletion guard before touching durable originals", async () => {
    const f = fixture(); const saved = await rememberResumableUpload(f.record, f.media, f.snapshot);
    await expect(forgetResumableUpload(saved.ownerId, saved.kind, saved.scopeId, saved.clientSubmissionId, { isCurrent: () => false })).rejects.toThrow();
    expect(await loadResumableDraft(saved)).not.toBeNull();
  });
  it("cannot read a snapshot using another owner/identity", async () => {
    const f = fixture(); const saved = await rememberResumableUpload(f.record, f.media, f.snapshot);
    expect(await loadResumableDraft({ ...saved, ownerId: "other" })).toBeNull();
    expect(await loadResumableDraft({ ...saved, clientSubmissionId: "different" })).toBeNull();
  });
  it("keys cannot collide through delimiter characters", () => {
    expect(resumeKey("a:b", "asset", "c", "d")).not.toBe(resumeKey("a", "asset", "b:c", "d"));
  });
  it("two tabs cannot overwrite a frozen attempt during simultaneous handoff", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      rememberResumableUpload(f.record, f.media, f.snapshot),
      rememberResumableUpload(f.record, f.media, f.snapshot),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = (await listResumableUploads(f.record.ownerId))[0];
    expect(await (await loadResumableDraft(saved))?.media[0].text()).toBe("untouched original");
  });
  it("rejects mismatched snapshot media order and submission identity before a handoff", async () => {
    const f = fixture();
    await expect(rememberResumableUpload({ ...f.record, files: describeOrderedFiles([...f.media].reverse()) }, [...f.media].reverse(), f.snapshot)).rejects.toThrow(/media order/);
    await expect(rememberResumableUpload({ ...f.record, clientSubmissionId: "different" }, f.media, f.snapshot)).rejects.toThrow(/identity/);
    expect(await listResumableUploads(f.record.ownerId)).toEqual([]);
  });
  it("fences same-owner authentication changes during a write", async () => {
    const f = fixture(); let checks = 0;
    await expect(rememberResumableUpload(f.record, f.media, f.snapshot, { isCurrent: () => { if (++checks === 3) advanceAuthSession(); return true; } })).rejects.toThrow();
    expect(await listResumableUploads(f.record.ownerId)).toEqual([]);
  });
});
