import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundUploadEntry } from "@/services/backgroundUploadManager";
import type { UploadResumeRecord } from "@/services/uploadResumeStore";

const mocks = vi.hoisted(() => ({
  snapshot: { active: null, queued: [], held: [], notices: [] } as any,
  list: vi.fn(), get: vi.fn(), prepare: vi.fn(), enqueue: vi.fn(), review: vi.fn(),
  entry: vi.fn(), pause: vi.fn(), resume: vi.fn(), dismiss: vi.fn(), accepted: vi.fn(),
  push: vi.fn(), revision: 0,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/auth-storage", () => ({ captureAuthSession: () => ({ revision: mocks.revision }), isAuthSessionCurrent: (session: { revision: number }) => session.revision === mocks.revision }));
vi.mock("./useBackgroundUploads", () => ({ useBackgroundUploads: () => mocks.snapshot }));
vi.mock("@/services/backgroundUploadManager", () => ({
  backgroundUploads: { enqueue: mocks.enqueue, entryForDraft: mocks.entry, pause: mocks.pause, resume: mocks.resume, dismissNotice: mocks.dismiss, onAccepted: mocks.accepted },
  describeBackgroundUpload: (entry: BackgroundUploadEntry) => entry.finalizing ? "Confirming server acceptance" : "Uploading 0%",
}));
vi.mock("@/services/uploadResumeStore", () => ({ listResumableUploads: mocks.list, getResumableUpload: mocks.get }));
vi.mock("@/services/uploadResumeRecovery", () => ({ prepareResumeFromRecord: mocks.prepare, describeResumeOutcome: () => "The upload needs review before it can continue." }));
vi.mock("@/services/uploadReviewNavigation", () => ({ openUploadForReview: mocks.review }));

import { UploadBar } from "./UploadBar";
const record: UploadResumeRecord = { version: 2, key: "owner-A:asset:draft-A", ownerId: "owner-A", kind: "asset", scopeId: "draft-A", endpoint: "/asset", details: {}, clientSubmissionId: "submission-A", files: [], title: "PRIVATE A REPORT", totalFiles: 2, uploadedFiles: 1, savedAt: "2026-10-15T00:00:00Z" };
const entry: BackgroundUploadEntry = { id: "upload-A", ownerId: "owner-A", kind: "asset", scopeId: "draft-A", title: record.title, clientSubmissionId: record.clientSubmissionId, status: "uploading", percent: 95, totalFiles: 2, pausing: false, canPause: false, finalizing: true, needsForm: false };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.revision = 0;
  mocks.snapshot = { active: null, queued: [], held: [], notices: [] };
  mocks.list.mockResolvedValue([]); mocks.get.mockResolvedValue(record);
  mocks.entry.mockReturnValue(null); mocks.enqueue.mockResolvedValue("upload-A");
  mocks.review.mockResolvedValue(undefined); mocks.accepted.mockReturnValue(() => {});
});
afterEach(cleanup);

describe("owner-bound upload line", () => {
  it("95 percent is confirmation pending, never accepted, and no destructive controls are offered", async () => {
    mocks.snapshot.active = entry;
    render(<UploadBar ownerId="owner-A" />);
    expect(screen.getByText("Confirming server acceptance")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the server to confirm acceptance/)).toBeInTheDocument();
    expect(screen.queryByText(/has been accepted/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Discard|Stop/ })).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("awaits enqueue, preserves the offer on failure and rejects same-tick double clicks", async () => {
    mocks.list.mockResolvedValue([record]); mocks.prepare.mockResolvedValue({ status: "ready", request: { ownerId: "owner-A" } });
    const enqueue = deferred<string>(); mocks.enqueue.mockReturnValue(enqueue.promise);
    render(<UploadBar ownerId="owner-A" />);
    const finish = await screen.findByRole("button", { name: "Finish upload" });
    fireEvent.click(finish); fireEvent.click(finish);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await act(async () => enqueue.reject(new Error("Request failed with status code 409")));
    expect(await screen.findByRole("button", { name: "Finish upload" })).toBeEnabled();
    expect(screen.getByRole("alert")).not.toHaveTextContent(/status code 409/);
    expect(screen.getByText(record.title)).toBeInTheDocument();
  });

  it("does not enqueue a delayed recovery after switching account", async () => {
    mocks.list.mockResolvedValue([record]); const prepared = deferred<any>(); mocks.prepare.mockReturnValue(prepared.promise);
    const ui = render(<UploadBar ownerId="owner-A" />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish upload" }));
    mocks.revision++; mocks.list.mockResolvedValue([]); ui.rerender(<UploadBar ownerId="owner-B" />);
    await act(async () => prepared.resolve({ status: "ready", request: { ownerId: "owner-A" } }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(screen.queryByText(record.title)).not.toBeInTheDocument();
    expect(mocks.prepare.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not reveal old entries/notices or delayed lists to the next owner", async () => {
    const listed = deferred<UploadResumeRecord[]>(); mocks.list.mockReturnValueOnce(listed.promise).mockResolvedValue([]);
    mocks.snapshot.active = entry;
    mocks.snapshot.notices = [{ id: "notice-A", ownerId: "owner-A", title: "PRIVATE OLD NOTICE", heading: "Upload accepted", message: "PRIVATE OLD MESSAGE", autoDismiss: false }];
    const ui = render(<UploadBar ownerId="owner-A" />);
    mocks.revision++; ui.rerender(<UploadBar ownerId="owner-B" />);
    expect(screen.queryByText(record.title)).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE OLD/)).not.toBeInTheDocument();
    await act(async () => listed.resolve([record]));
    expect(screen.queryByText(record.title)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish upload" })).not.toBeInTheDocument();
  });

  it("opens the exact held snapshot for review and never offers discard or forbidden retry", async () => {
    mocks.snapshot.held = [{ ...entry, status: "attention", needsForm: true }];
    render(<UploadBar ownerId="owner-A" />);
    fireEvent.click(screen.getByRole("button", { name: "Review saved report" }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());
    expect(mocks.get).toHaveBeenCalledWith("owner-A", "asset", "draft-A", "submission-A", expect.objectContaining({ signal: expect.any(AbortSignal), isCurrent: expect.any(Function) }));
    expect(mocks.review).toHaveBeenCalledWith(record, expect.anything(), expect.any(Function));
    expect(screen.queryByRole("button", { name: /Resume|Discard/ })).not.toBeInTheDocument();
  });

  it("a persisted conflict offers review only, without pretending it can finish", async () => {
    mocks.list.mockResolvedValue([{ ...record, needsForm: true }]);
    render(<UploadBar ownerId="owner-A" />);
    expect(await screen.findByRole("button", { name: "Review saved report" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Finish upload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
  });

  it("shows a retry when local recovery cannot be listed instead of silently hiding it", async () => {
    mocks.list.mockRejectedValueOnce(new Error("storage blocked")).mockResolvedValueOnce([record]);
    render(<UploadBar ownerId="owner-A" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved uploads" }));
    expect(await screen.findByRole("button", { name: "Finish upload" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("only suppresses an offer with the exact same submission identity", async () => {
    mocks.list.mockResolvedValue([record]);
    render(<UploadBar ownerId="owner-A" />);
    await screen.findByRole("button", { name: "Finish upload" });
    expect(mocks.entry).toHaveBeenCalledWith("asset", "draft-A", "submission-A");
  });
});
