import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceAuthSession } from "@/lib/auth-storage";
const store = vi.hoisted(() => ({ rememberResumableUpload: vi.fn(), forgetResumableUpload: vi.fn(), recordResumableProgress: vi.fn(), attachResumableSession: vi.fn(), markResumableNeedsForm: vi.fn(), getResumableUpload: vi.fn() }));
vi.mock("./uploadResumeStore", async (original) => ({ ...await original<typeof import("./uploadResumeStore")>(), ...store }));
import { createBackgroundUploadManager, describeBackgroundUpload, type BackgroundUploadRequest } from "./backgroundUploadManager";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<BackgroundUploadRequest> = {}) {
  const result = deferred(); let progress!: (value: number) => void; let signal!: AbortSignal;
  const upload = vi.fn((notify: (value: number) => void, abort: AbortSignal) => { progress = notify; signal = abort; return result.promise; });
  const media = [new File(["original"], "photo.jpg", { lastModified: 1 })];
  const request: BackgroundUploadRequest = { ownerId: "owner-1", kind: "asset", scopeId: "scope-1", endpoint: "/asset", title: "Report", totalFiles: 1, clientSubmissionId: "submission-1", details: { client_submission_id: "submission-1" }, files: [{ name: "photo.jpg", size: 8, lastModified: 1 }], media, draftSnapshot: { userId: "owner-1", kind: "asset", lots: [{ files: media }] }, upload, ...overrides };
  return { request, result, upload, progress: (value: number) => progress(value), getSignal: () => signal };
}
let manager: ReturnType<typeof createBackgroundUploadManager>;
beforeEach(() => {
  vi.resetAllMocks();
  for (const method of Object.values(store)) method.mockResolvedValue(undefined);
  manager = createBackgroundUploadManager(); manager.setOwner("owner-1");
});
afterEach(() => manager.resetForTests());
describe("durable background upload manager", () => {
  it("does not start or acknowledge handoff before the media transaction commits", async () => {
    const saving = deferred(); store.rememberResumableUpload.mockReturnValue(saving.promise);
    const f = fixture(); let handedOff = false;
    const pending = manager.enqueue(f.request).then(() => { handedOff = true; });
    await flush(); expect(f.upload).not.toHaveBeenCalled(); expect(handedOff).toBe(false);
    saving.resolve(undefined); await pending; await flush(); expect(f.upload).toHaveBeenCalledOnce();
  });
  it("rejects quota/storage failure and never starts transport", async () => {
    store.rememberResumableUpload.mockRejectedValue(new Error("No device storage")); const f = fixture();
    await expect(manager.enqueue(f.request)).rejects.toThrow(/storage/); await flush();
    expect(f.upload).not.toHaveBeenCalled(); expect(manager.getSnapshot().active).toBeNull();
  });
  it("aborts handoff if caller leaves during durable saving", async () => {
    const saving = deferred(); store.rememberResumableUpload.mockReturnValue(saving.promise);
    const controller = new AbortController(); const f = fixture({ signal: controller.signal });
    const pending = manager.enqueue(f.request); controller.abort(); saving.resolve(undefined);
    await expect(pending).rejects.toThrow(); await flush(); expect(f.upload).not.toHaveBeenCalled();
  });
  it("serializes independent jobs and only frees the accepted immutable identity", async () => {
    const a = fixture(), b = fixture({ scopeId: "scope-2", clientSubmissionId: "submission-2" });
    await manager.enqueue(a.request); await manager.enqueue(b.request); await flush();
    expect(a.upload).toHaveBeenCalledOnce(); expect(b.upload).not.toHaveBeenCalled();
    a.result.resolve({ reportId: "r1", accepted: true }); await flush(); await flush();
    expect(b.upload).toHaveBeenCalledOnce();
    expect(store.forgetResumableUpload).toHaveBeenCalledWith("owner-1", "asset", "scope-1", "submission-1", expect.any(Object));
  });
  it.each([0.95, 1])("never claims acceptance at %s transport progress", async (fraction) => {
    const f = fixture(); await manager.enqueue(f.request); await flush(); f.progress(fraction);
    const active = manager.getSnapshot().active!;
    expect(active.finalizing).toBe(true); expect(active.canPause).toBe(false); expect(active.percent).toBeLessThan(100);
    expect(describeBackgroundUpload(active)).toBe("Confirming server acceptance");
    expect(manager.getSnapshot().notices).toEqual([]); expect(store.forgetResumableUpload).not.toHaveBeenCalled();
  });
  it.each([{ reportId: "r1", accepted: false, jobId: "j", status: "processing" }, { reportId: "r1" }, { reportId: "r1", accepted: true, phase: "upload" }, { reportId: "r1", accepted: true, reportAvailable: false }])("rejects incomplete/explicitly unaccepted result %# without Sent or cleanup", async (receipt) => {
    const onAccepted = vi.fn(), event = vi.fn(); manager.onAccepted(event);
    const f = fixture({ onAccepted }); await manager.enqueue(f.request); await flush(); f.result.resolve(receipt); await flush();
    expect(manager.getSnapshot().held).toHaveLength(1); expect(manager.getSnapshot().notices.every((notice) => notice.kind === "attention")).toBe(true);
    expect(onAccepted).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(store.forgetResumableUpload).not.toHaveBeenCalled();
  });
  it("holds a fresh reused acceptance for explicit review without deleting current media", async () => {
    const f = fixture(); await manager.enqueue(f.request); await flush(); f.result.resolve({ reportId: "old", accepted: true, reusedAcceptance: true }); await flush(); await flush();
    expect(manager.getSnapshot().held[0].needsForm).toBe(true); expect(store.markResumableNeedsForm).toHaveBeenCalled();
    expect(store.forgetResumableUpload).not.toHaveBeenCalled(); expect(manager.getSnapshot().notices[0].kind).toBe("attention");
  });
  it("accepts a verified exact immutable retry receipt, not a new submission", async () => {
    const f = fixture({ skipPersist: true }); store.getResumableUpload.mockResolvedValue({ ...f.request });
    await manager.enqueue(f.request); await flush(); f.result.resolve({ reportId: "r1", accepted: true, reusedAcceptance: true }); await flush();
    expect(store.rememberResumableUpload).not.toHaveBeenCalled(); expect(manager.getSnapshot().notices[0].kind).toBe("sent");
  });
  it("does not allow skipPersist to bypass missing durable media metadata", async () => {
    const f = fixture({ skipPersist: true }); await expect(manager.enqueue(f.request)).rejects.toThrow(/could not be verified/);
    await flush(); expect(f.upload).not.toHaveBeenCalled();
  });
  it("does not emit old-owner acceptance after switching during asynchronous cleanup", async () => {
    const deletion = deferred(); store.forgetResumableUpload.mockReturnValue(deletion.promise);
    const onAccepted = vi.fn(), listener = vi.fn(); manager.onAccepted(listener);
    const f = fixture({ onAccepted }); await manager.enqueue(f.request); await flush();
    f.result.resolve({ reportId: "r1", accepted: true }); await flush();
    manager.setOwner("owner-2"); deletion.resolve(undefined); await flush();
    expect(manager.getSnapshot().notices).toEqual([]); expect(onAccepted).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  it("fences callbacks on same-owner session change without waiting for shell effects", async () => {
    const f = fixture(); const accepted = vi.fn(); manager.onAccepted(accepted);
    await manager.enqueue(f.request); await flush(); advanceAuthSession();
    f.progress(0.5); expect(f.getSignal().aborted).toBe(true);
    f.result.resolve({ reportId: "r1", accepted: true }); await flush();
    expect(accepted).not.toHaveBeenCalled(); expect(store.forgetResumableUpload).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual({ active: null, queued: [], held: [], notices: [] });
  });
  it("hides notices immediately on a silent same-owner session replacement", async () => {
    const f = fixture(); await manager.enqueue(f.request); await flush(); f.result.resolve({ reportId: "r1", accepted: true }); await flush();
    expect(manager.getSnapshot().notices).toHaveLength(1); advanceAuthSession();
    expect(manager.getSnapshot().notices).toEqual([]);
  });
  it("does not run acceptance cleanup after a silent session replacement during its durable await", async () => {
    const deletion = deferred(); store.forgetResumableUpload.mockReturnValue(deletion.promise);
    const cleanup = vi.fn(), listener = vi.fn(); manager.onAccepted(listener);
    const f = fixture({ onAccepted: cleanup }); await manager.enqueue(f.request); await flush();
    f.result.resolve({ reportId: "r1", accepted: true }); await flush(); advanceAuthSession(); deletion.resolve(undefined); await flush();
    expect(cleanup).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(manager.getSnapshot().notices).toEqual([]);
  });
  it("stops notification iteration if a listener switches accounts", async () => {
    const f = fixture(); const later = vi.fn(), cleanup = vi.fn();
    manager.onAccepted(() => manager.setOwner("owner-2")); manager.onAccepted(later);
    await manager.enqueue({ ...f.request, onAccepted: cleanup }); await flush(); f.result.resolve({ reportId: "r1", accepted: true }); await flush();
    expect(later).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled(); expect(manager.getSnapshot().notices).toEqual([]);
  });
  it("keeps durable data on logout and ignores late progress/failure", async () => {
    const f = fixture(); await manager.enqueue(f.request); await flush(); manager.setOwner(null);
    expect(f.getSignal().aborted).toBe(true); f.progress(0.7); f.result.reject(new Error("Network Error")); await flush();
    expect(manager.getSnapshot().notices).toEqual([]); expect(store.forgetResumableUpload).not.toHaveBeenCalled();
  });
  it("retains paused/stopped work and cannot say nothing was submitted", async () => {
    const f = fixture(); const id = await manager.enqueue(f.request); await flush(); manager.stop(id);
    expect(manager.getSnapshot().held[0].message).toMatch(/may already have accepted/);
    expect(store.forgetResumableUpload).not.toHaveBeenCalled(); f.result.reject(new Error("aborted")); await flush();
  });
  it("maps raw conflict errors, persists review mode and never retries a conflict from the bar", async () => {
    const f = fixture(); const id = await manager.enqueue(f.request); await flush();
    f.result.reject({ message: "Request failed with status code 409", response: { status: 409, data: {} } }); await flush(); await flush();
    expect(manager.getSnapshot().held[0].needsForm).toBe(true); expect(manager.getSnapshot().held[0].message).not.toMatch(/409|status code/);
    expect(store.markResumableNeedsForm).toHaveBeenCalledWith("owner-1", "asset", "scope-1", "submission-1", expect.any(Object));
    manager.resume(id); expect(f.upload).toHaveBeenCalledOnce();
  });
  it("keeps success truthful even when exact local cleanup fails", async () => {
    const f = fixture(); store.forgetResumableUpload.mockRejectedValue(new Error("quota"));
    await manager.enqueue(f.request); await flush(); f.result.resolve({ reportId: "r1", accepted: true }); await flush();
    expect(manager.getSnapshot().notices[0].kind).toBe("sent"); expect(manager.getSnapshot().held).toEqual([]);
  });
  it("rejects duplicate concurrent handoffs and different bound account", async () => {
    const saving = deferred(); store.rememberResumableUpload.mockReturnValue(saving.promise); const f = fixture();
    const pending = manager.enqueue(f.request); await expect(manager.enqueue(f.request)).rejects.toThrow(/already in the queue/);
    await expect(manager.enqueue({ ...f.request, ownerId: "owner-2" })).rejects.toThrow(/session changed/);
    saving.resolve(undefined); await pending;
  });
});
