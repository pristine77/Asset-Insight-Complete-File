import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SmartUploadWorkspace from "./SmartUploadWorkspace";
import type { SmartUploadDraft } from "./storage";
import type { SmartUploadGrouping } from "@/services/smartUpload";

const mocks = vi.hoisted(() => ({
  loadDraft: vi.fn(),
  getGrouping: vi.fn(),
  updateDraft: vi.fn(),
  updateGrouping: vi.fn(),
  complete: vi.fn(),
  deleteDraft: vi.fn(),
  createDraft: vi.fn(),
  recover: vi.fn(),
  getCompletionStatus: vi.fn(),
  createSession: vi.fn(),
  uploadFiles: vi.fn(),
  saveServerDraft: vi.fn(),
  cancel: vi.fn(),
  startDetection: vi.fn(),
  waitGrouping: vi.fn(),
  releaseMedia: vi.fn(),
}));

vi.mock("./storage", () => ({
  createSmartUploadDraft: mocks.createDraft,
  deleteSmartUploadDraft: mocks.deleteDraft,
  loadSmartUploadFile: vi.fn(),
  loadSmartUploadDraft: mocks.loadDraft,
  releaseSmartUploadMedia: mocks.releaseMedia,
  saveServerSmartUploadDraft: mocks.saveServerDraft,
  updateSmartUploadDraft: mocks.updateDraft,
}));

vi.mock("@/services/smartUpload", () => ({
  cancelSmartUpload: mocks.cancel,
  completeSmartUpload: mocks.complete,
  recoverSmartUploadCompletion: mocks.recover,
  getSmartUploadCompletionStatus: mocks.getCompletionStatus,
  isSmartUploadCompletionPending: (error: { completionPending?: boolean }) => error?.completionPending === true,
  createOrResumeSmartUploadSession: mocks.createSession,
  getSmartUploadError: (error: unknown) =>
    error instanceof Error ? error.message : "Smart Upload failed",
  getSmartUploadErrorCode: vi.fn(),
  getSmartUploadGrouping: mocks.getGrouping,
  startSmartUploadDetection: mocks.startDetection,
  updateSmartUploadDividers: mocks.updateGrouping,
  uploadSmartUploadFiles: mocks.uploadFiles,
  waitForSmartUploadGrouping: mocks.waitGrouping,
}));

const PREVIEW_URL =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

function createReviewState(fileCount = 300, photosPerLot = 3) {
  const files: SmartUploadDraft["files"] = Array.from(
    { length: fileCount },
    (_, index) => ({
      fileId: `images-${index}`,
      name: `photo-${index}.jpg`,
      type: "image/jpeg",
      size: 10,
      lastModified: index,
      originalOrder: index,
      uploaded: true,
    })
  );
  const draft: SmartUploadDraft = {
    version: 1,
    scope: "user-1:asset:scope-1",
    userId: "user-1",
    kind: "asset",
    clientSubmissionId: "scope-1",
    sessionId: "session-1",
    stage: "review",
    details: {},
    files,
    savedAt: "2026-08-12T12:00:00.000Z",
  };
  const grouping: SmartUploadGrouping = {
    sessionId: "session-1",
    smartUpload: true,
    groupingStatus: "review_ready",
    progressPercent: 100,
    revision: 0,
    orderReviewRequired: false,
    unresolvedDividerIds: [],
    hasOrderReviewState: true,
    groups: Array.from({ length: Math.ceil(fileCount / photosPerLot) }, (_, index) => ({
      groupIndex: index,
      imageCount: Math.min(photosPerLot, fileCount - index * photosPerLot),
      fileIds: files.slice(index * photosPerLot, (index + 1) * photosPerLot).map((file) => file.fileId),
      overLimit: false,
    })),
    dividerFileIds: [],
    metrics: [],
    warnings: [],
    expectedFileCount: files.length,
    confirmedFileCount: files.length,
    files: files.map((file) => ({
      fileId: file.fileId,
      name: file.name,
      mimeType: file.type,
      size: file.size,
      url: PREVIEW_URL,
      originalOrder: file.originalOrder,
    })),
  };
  return { draft, grouping };
}

function workspace(onSubmitted = vi.fn()) {
  return (
    <SmartUploadWorkspace
      open
      kind="asset"
      userId="user-1"
      scopeId="scope-1"
      details={{}}
      onClose={vi.fn()}
      onSubmitted={onSubmitted}
    />
  );
}

describe("SmartUploadWorkspace preview memory bounds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateDraft.mockResolvedValue(undefined);
    mocks.deleteDraft.mockResolvedValue(undefined);
    mocks.releaseMedia.mockResolvedValue(undefined);
    mocks.getCompletionStatus.mockResolvedValue({ sessionId: "session-1", status: "ready", accepted: false });
  });

  it("closes queued numbered detection without cancelling or deleting it, then reopens the same review", async () => {
    const { draft, grouping } = createReviewState(6, 3);
    draft.stage = "classifying";
    draft.details.smart_upload_grouping_method = "lot_number";
    grouping.groupingMethod = "lot_number";
    grouping.groupingStatus = "classifying";
    grouping.classificationJobId = "classification-1";
    grouping.groups.forEach((group, index) => { group.lotNumber = String(2500 + index); });
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    mocks.waitGrouping.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Polling stopped", "AbortError")), { once: true });
    }));
    const onClose = vi.fn();
    const onSubmitted = vi.fn();
    const props = { kind: "asset" as const, userId: "user-1", scopeId: "scope-1", details: {}, onClose, onSubmitted };
    const view = render(<SmartUploadWorkspace {...props} open />);
    fireEvent.click(await screen.findByRole("button", { name: "Close and keep processing" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect((mocks.waitGrouping.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    expect(screen.getByText(/reopen this saved upload from Drafts/)).toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    view.rerender(<SmartUploadWorkspace {...props} open={false} />);
    mocks.getGrouping.mockResolvedValue({ ...grouping, groupingStatus: "review_ready" });
    view.rerender(<SmartUploadWorkspace {...props} open />);
    await screen.findByLabelText("Lot number");
    expect(screen.getByLabelText("Lot number")).toHaveValue("2500");
    expect(screen.getByRole("button", { name: "Create preview" })).toBeDisabled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
    expect(mocks.startDetection).not.toHaveBeenCalled();
    expect(mocks.updateDraft.mock.calls.some((call) => call[2].stage === "failed")).toBe(false);
  });

  it.each([
    { method: "lot_number", jobId: undefined, confirmed: 3 },
    { method: "lot_number", jobId: "classification-1", confirmed: 2 },
    { method: "black_divider", jobId: "classification-1", confirmed: 3 },
  ] as const)("keeps $method processing open without a safe numbered receipt ($jobId, $confirmed files)", async ({ method, jobId, confirmed }) => {
    const { draft, grouping } = createReviewState(3);
    draft.stage = "classifying";
    draft.details.smart_upload_grouping_method = method;
    Object.assign(grouping, { groupingMethod: method, groupingStatus: "classifying", classificationJobId: jobId, confirmedFileCount: confirmed });
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    mocks.waitGrouping.mockImplementation(() => new Promise(() => undefined));
    const onClose = vi.fn();
    render(<SmartUploadWorkspace open kind="asset" userId="user-1" scopeId="scope-1" details={{}} onClose={onClose} onSubmitted={vi.fn()} />);
    await waitFor(() => expect(mocks.waitGrouping).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: method === "lot_number" ? "Close Lot Number Upload" : "Close Smart Upload" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close and keep processing" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(method === "lot_number" ? "processing is confirmed" : "Wait for this step to finish");
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("allows closing only after initial numbered classification acceptance, not while start is pending", async () => {
    const { draft, grouping } = createReviewState(3);
    draft.stage = "selected";
    draft.sessionId = undefined;
    draft.details.smart_upload_grouping_method = "lot_number";
    Object.assign(grouping, { groupingMethod: "lot_number", groupingStatus: "classifying", classificationJobId: "classification-1" });
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.createSession.mockResolvedValue({ sessionId: "session-1", groupingMethod: "lot_number" });
    mocks.uploadFiles.mockResolvedValue(undefined);
    let accept!: (value: SmartUploadGrouping) => void;
    mocks.startDetection.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
    mocks.waitGrouping.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Polling stopped", "AbortError")), { once: true });
    }));
    const onClose = vi.fn();
    render(<SmartUploadWorkspace open groupingMethod="lot_number" kind="asset" userId="user-1" scopeId="scope-1" details={{}} onClose={onClose} onSubmitted={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Upload & detect lots" }));
    await waitFor(() => expect(mocks.startDetection).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Close Lot Number Upload" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close and keep processing" })).not.toBeInTheDocument();
    await act(async () => accept(grouping));
    fireEvent.click(await screen.findByRole("button", { name: "Close and keep processing" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.updateDraft).toHaveBeenCalledWith("user-1", "asset", expect.objectContaining({ stage: "classifying" }), "scope-1");
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
    expect(mocks.updateDraft.mock.calls.some((call) => call[2].stage === "failed")).toBe(false);
  });

  it("restores numbered mode, retains 5,000 images and bounds rendered photo pages", async () => {
    const { draft, grouping } = createReviewState(5000, 50);
    draft.details.smart_upload_grouping_method = "lot_number";
    grouping.groupingMethod = "lot_number";
    grouping.groups.forEach((group, index) => { group.lotNumber = String(2500 + index); });
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    render(workspace()); // Entry defaults black; persisted method wins.
    await screen.findByRole("heading", { name: "Lot Number Upload" });
    await screen.findByText("Lots 1-6 of 100");
    expect(screen.getByText("Lot 2500")).toBeInTheDocument();
    expect(screen.queryByText("Upload sequence")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use as divider/ })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(18));
    fireEvent.click(screen.getByRole("button", { name: "Next photos" }));
    await screen.findByText("Photos 13-24 of 50");
    expect(document.querySelectorAll("img")).toHaveLength(18);
    expect(screen.getByRole("button", { name: "Create preview" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked every lot number/ }));
    expect(screen.getByRole("button", { name: "Create preview" })).toBeEnabled();
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
  });

  it("saves corrected numbers without acknowledgement, then confirms the exact revised groups", async () => {
    const { draft, grouping } = createReviewState(6, 3);
    draft.details.smart_upload_grouping_method = "lot_number";
    grouping.groupingMethod = "lot_number";
    grouping.groups[0].lotNumber = "2500";
    grouping.groups[1].lotNumber = "2501";
    grouping.unresolvedLotNumberFileIds = ["images-1"];
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    mocks.updateGrouping.mockImplementation(async (args) => ({ ...grouping, revision: grouping.revision + 1, groups: args.groups.map((group: { fileIds: string[]; lotNumber?: string }, index: number) => ({ ...group, groupIndex: index, imageCount: group.fileIds.length, overLimit: false })) }));
    mocks.complete.mockResolvedValue({ reportId: "r", jobId: "j", message: "queued" });
    render(workspace());
    const input = await screen.findByLabelText("Lot number");
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked every lot number/ }));
    fireEvent.change(input, { target: { value: "02500A" } });
    expect(screen.getByRole("button", { name: "Create preview" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save lot number" }));
    await screen.findByText("Lot 02500A");
    expect(mocks.updateGrouping.mock.calls[0][0]).toMatchObject({ groups: [{ fileIds: ["images-0", "images-1", "images-2"], lotNumber: "02500A" }, { fileIds: ["images-3", "images-4", "images-5"], lotNumber: "2501" }], dividerFileIds: [] });
    expect(mocks.updateGrouping.mock.calls[0][0]).not.toHaveProperty("acknowledgeLotNumberReview");
    expect(screen.getByRole("checkbox", { name: /I checked every lot number/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked every lot number/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create preview" }));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    expect(mocks.updateGrouping.mock.calls[1][0]).toMatchObject({ revision: 1, confirm: true, acknowledgeLotNumberReview: true });
  });

  it("keeps number edits after a failed save", async () => {
    const { draft, grouping } = createReviewState(3);
    draft.details.smart_upload_grouping_method = "lot_number";
    grouping.groupingMethod = "lot_number";
    grouping.groups[0].lotNumber = "2500";
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    mocks.updateGrouping.mockRejectedValue(new Error("Connection interrupted"));
    render(workspace());
    fireEvent.change(await screen.findByLabelText("Lot number"), { target: { value: "2509" } });
    fireEvent.click(screen.getByRole("button", { name: "Save lot number" }));
    await screen.findByText("Connection interrupted");
    expect(screen.getByLabelText("Lot number")).toHaveValue("2509");
  });

  it("splits, joins and undoes numbered boundaries without removing or reordering a photo", async () => {
    const { draft, grouping } = createReviewState(4, 4);
    draft.details.smart_upload_grouping_method = "lot_number";
    grouping.groupingMethod = "lot_number";
    grouping.groups[0].lotNumber = "2500";
    grouping.metrics = [{ fileId: "images-2", kind: "lot_start", lotNumber: "2501", meanLuminance: 0, variance: 0, darkPixelRatio: 0, isDivider: false }];
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    let revision = 0;
    mocks.updateGrouping.mockImplementation(async (args) => ({ ...grouping, revision: ++revision, groups: args.groups.map((group: { fileIds: string[]; lotNumber?: string }, index: number) => ({ ...group, groupIndex: index, imageCount: group.fileIds.length, overLimit: false })) }));
    render(workspace());
    await screen.findByLabelText("Lot number");
    fireEvent.click(screen.getAllByRole("button", { name: "Start new lot here" })[1]);
    await screen.findByText("Lot 2501");
    expect(mocks.updateGrouping.mock.calls[0][0].groups).toEqual([{ fileIds: ["images-0", "images-1"], lotNumber: "2500" }, { fileIds: ["images-2", "images-3"], lotNumber: "2501" }]);
    fireEvent.click(screen.getByRole("button", { name: "Join previous lot" }));
    await screen.findByText("Joined with the previous lot. All images were retained.");
    expect(mocks.updateGrouping.mock.calls[1][0].groups).toEqual([{ fileIds: ["images-0", "images-1", "images-2", "images-3"], lotNumber: "2500" }]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Previous lot arrangement restored.");
    expect(mocks.updateGrouping.mock.calls[2][0].groups).toEqual(mocks.updateGrouping.mock.calls[0][0].groups);
    for (const [call] of mocks.updateGrouping.mock.calls) {
      expect(call.dividerFileIds).toEqual([]);
      expect(call.groups.flatMap((group: { fileIds: string[] }) => group.fileIds)).toEqual(["images-0", "images-1", "images-2", "images-3"]);
      expect(call).not.toHaveProperty("acknowledgeLotNumberReview");
    }
  });

  it("recovers numbered mode from a server-only draft with the default entry method", async () => {
    const { draft, grouping } = createReviewState(3);
    grouping.groupingMethod = "lot_number";
    grouping.groups[0].lotNumber = "2500";
    mocks.loadDraft.mockResolvedValue(null);
    mocks.getGrouping.mockResolvedValue(grouping);
    mocks.saveServerDraft.mockImplementation(async (args) => ({ ...draft, ...args }));
    render(<SmartUploadWorkspace open kind="asset" userId="user-1" scopeId="scope-1" resumeSessionId="session-1" details={{}} onClose={vi.fn()} onSubmitted={vi.fn()} />);
    await screen.findByRole("heading", { name: "Lot Number Upload" });
    expect(screen.getByLabelText("Lot number")).toHaveValue("2500");
    expect(mocks.saveServerDraft).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ smart_upload_grouping_method: "lot_number" }) }));
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
  });

  it("requires a missing lot number and does not offer to exclude unreadable numbered photos", async () => {
    const { draft, grouping } = createReviewState(3);
    draft.details.smart_upload_grouping_method = "lot_number";
    grouping.groupingMethod = "lot_number";
    grouping.metrics = [{ fileId: "images-1", error: "Unreadable original", meanLuminance: 0, variance: 0, darkPixelRatio: 0, isDivider: false }];
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    render(workspace());
    await screen.findByLabelText("Lot number");
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked every lot number/ }));
    expect(screen.getByRole("button", { name: "Create preview" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Exclude from report" })).not.toBeInTheDocument();
    expect(mocks.updateGrouping).not.toHaveBeenCalled();
  });

  it("blocks duplicate lot numbers even after explicit review acknowledgement", async () => {
    const { draft, grouping } = createReviewState(6);
    draft.details.smart_upload_grouping_method = "lot_number";
    grouping.groupingMethod = "lot_number";
    grouping.groups.forEach((group) => { group.lotNumber = "2500"; });
    grouping.warnings = ["Lot number 2500 appears more than once. Review the boundaries and number before confirming."];
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    render(workspace());
    await screen.findByLabelText("Lot number");
    expect(screen.getByText(grouping.warnings[0])).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked every lot number/ }));
    expect(screen.getByRole("button", { name: "Create preview" })).toBeDisabled();
    expect(mocks.updateGrouping).not.toHaveBeenCalled();
  });

  it("pages large reviews instead of accumulating full-resolution images", async () => {
    const { draft, grouping } = createReviewState();
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);

    render(workspace());

    await screen.findByText("Images 1-12 of 300");
    await screen.findByText("Lots 1-6 of 100");
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(21));

    for (const image of document.querySelectorAll("img")) {
      expect(image).toHaveAttribute("loading", "lazy");
      expect(image).toHaveAttribute("decoding", "async");
      expect(image).toHaveAttribute("fetchpriority", "low");
    }

    fireEvent.click(screen.getByRole("button", { name: "Next images" }));
    await screen.findByText("Images 13-24 of 300");
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(21));

    fireEvent.click(screen.getByRole("button", { name: "Next lots" }));
    await screen.findByText("Lots 7-12 of 100");
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(21));
  });

  it("keeps a 5,000-image review bounded to visible thumbnail pages", async () => {
    const { draft, grouping } = createReviewState(5000, 50);
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue(grouping);
    render(workspace());
    await screen.findByText("Images 1-12 of 5000");
    await screen.findByText("Lots 1-6 of 100");
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(30));
    fireEvent.click(screen.getByRole("button", { name: "Next images" }));
    await screen.findByText("Images 13-24 of 5000");
    expect(document.querySelectorAll("img")).toHaveLength(30);
  });

  it.each([4999, 5000, 5001])("checks the Smart Upload image-count boundary at %i without creating another upload", async (count) => {
    mocks.loadDraft.mockResolvedValue(null);
    mocks.createDraft.mockImplementation(async (args: { files: File[]; details: Record<string, unknown> }) => ({
      ...createReviewState(0).draft,
      stage: "selected",
      sessionId: undefined,
      details: args.details,
      files: args.files.map((file, index) => ({ fileId: `images-${index}`, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, originalOrder: index, uploaded: false, file })),
    }));
    render(workspace());
    await screen.findByRole("button", { name: "Select images" });
    expect(screen.getByText(/Up to 5,000 images/)).toBeInTheDocument();
    const files = Array.from({ length: count }, (_, index) => new File(["x"], `IMG_${String(index).padStart(5, "0")}.jpg`, { type: "image/jpeg", lastModified: index + 1 }));
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } });
    if (count <= 5000) {
      await screen.findByRole("button", { name: "Upload & detect lots" });
      expect(mocks.createDraft).toHaveBeenCalledTimes(1);
      expect(mocks.createDraft.mock.calls[0][0].files).toHaveLength(count);
    } else {
      await screen.findByText("Select no more than 5,000 images in one Smart Upload.");
      expect(mocks.createDraft).not.toHaveBeenCalled();
    }
  });

  it("retries completion without reconfirming a grouping whose response failed", async () => {
    const { draft, grouping } = createReviewState();
    const confirmed = { ...grouping, groupingStatus: "confirmed" as const, revision: 1 };
    const submitted = {
      message: "Report queued",
      reportId: "report-1",
      jobId: "job-1",
      status: "queued",
      phase: "queued",
    };
    const onSubmitted = vi.fn();
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping
      .mockResolvedValueOnce(grouping)
      .mockResolvedValueOnce(confirmed);
    mocks.updateGrouping.mockResolvedValue(confirmed);
    mocks.complete
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(submitted);

    render(workspace(onSubmitted));

    fireEvent.click(await screen.findByRole("button", { name: "Create preview" }));
    await screen.findByText(/Connection interrupted/);
    expect(screen.queryByRole("button", { name: "Resume upload" })).not.toBeInTheDocument();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Discard upload" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry preview creation" }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(submitted));
    expect(mocks.updateGrouping).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.complete.mock.calls.every((call) => call[1] === "session-1")).toBe(true);
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("restores submitting state through status recovery without fetching all grouping photos", async () => {
    const { draft } = createReviewState(5000, 50);
    const submitted = { message: "Accepted", reportId: "report-1", jobId: "preview-job-1" };
    mocks.loadDraft.mockResolvedValue({ ...draft, stage: "submitting" });
    mocks.recover.mockRejectedValueOnce(Object.assign(new Error("Still checking the saved upload"), { completionPending: true }))
      .mockResolvedValueOnce(submitted);
    const onSubmitted = vi.fn();
    render(workspace(onSubmitted));
    fireEvent.click(await screen.findByRole("button", { name: "Check preview status" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(submitted));
    expect(mocks.recover).toHaveBeenCalledTimes(2);
    expect(mocks.getGrouping).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
    expect(mocks.updateDraft).toHaveBeenCalledWith("user-1", "asset", { sessionId: "session-1", stage: "submitting" }, "scope-1");
  });

  it("recovers an older review draft if the preview was already accepted", async () => {
    const { draft } = createReviewState();
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getCompletionStatus.mockResolvedValue({ sessionId: "session-1", accepted: true, status: "queued", reportId: "report-1", jobId: "preview-1" });
    mocks.recover.mockResolvedValue({ message: "Accepted", reportId: "report-1", jobId: "preview-1" });
    const onSubmitted = vi.fn();
    render(workspace(onSubmitted));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(mocks.getGrouping).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("retains ready-to-complete recovery without uploading again or falling back to Resume upload", async () => {
    const { draft } = createReviewState();
    mocks.loadDraft.mockResolvedValue({ ...draft, stage: "failed", sessionId: undefined });
    mocks.createSession.mockResolvedValue({ sessionId: "session-1", readyToComplete: true });
    mocks.complete.mockRejectedValue(Object.assign(new Error("Keep the same saved upload"), { completionPending: true }));
    render(workspace());
    fireEvent.click(await screen.findByRole("button", { name: "Resume upload" }));
    await screen.findByRole("button", { name: "Check preview status" });
    expect(screen.queryByRole("button", { name: "Resume upload" })).not.toBeInTheDocument();
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
  });

  it("coalesces repeat clicks and keeps recovery metadata when closed during a status check", async () => {
    const { draft } = createReviewState();
    mocks.loadDraft.mockResolvedValue({ ...draft, stage: "submitting" });
    mocks.recover.mockRejectedValueOnce(new Error("Backend status is unavailable"));
    let resolve!: (value: unknown) => void;
    const onSubmitted = vi.fn();
    const view = render(workspace(onSubmitted));
    const check = await screen.findByRole("button", { name: "Check preview status" });
    mocks.recover.mockImplementation(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(check);
    fireEvent.click(check);
    await waitFor(() => expect(mocks.recover).toHaveBeenCalledTimes(2));
    const signal = mocks.recover.mock.calls[1][2].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ reportId: "report-1", jobId: "preview-1", message: "Accepted" }));
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
  });

  it.each([false, true])("only returns to saved review if a fresh status still confirms no acceptance (accepted=%s)", async (nowAccepted) => {
    const { draft, grouping } = createReviewState();
    mocks.loadDraft.mockResolvedValue({ ...draft, stage: "submitting" });
    mocks.recover.mockRejectedValue(Object.assign(new Error("Saved upload ready"), { completionPending: true, reviewAvailable: true }));
    mocks.getGrouping.mockResolvedValue(grouping);
    render(workspace());
    const back = await screen.findByRole("button", { name: "Return to saved review" });
    mocks.getCompletionStatus.mockResolvedValue({ sessionId: "session-1", accepted: nowAccepted, status: nowAccepted ? "queued" : "ready" });
    fireEvent.click(back);
    if (nowAccepted) {
      await screen.findByText(/The upload status changed/);
      expect(mocks.getGrouping).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Create preview" })).not.toBeInTheDocument();
    } else {
      await screen.findByRole("button", { name: "Create preview" });
      expect(mocks.getGrouping).toHaveBeenCalledOnce();
    }
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.uploadFiles).not.toHaveBeenCalled();
  });

  it("requires an explicit acknowledgement before uploading a timestamp suggestion", async () => {
    mocks.loadDraft.mockResolvedValue(null);
    const files = [
      new File(["a"], "scan-a.jpg", { type: "image/jpeg", lastModified: 3_000 }),
      new File(["b"], "scan-b.jpg", { type: "image/jpeg", lastModified: 1_000 }),
      new File(["c"], "scan-c.jpg", { type: "image/jpeg", lastModified: 2_000 }),
    ];
    mocks.createDraft.mockImplementation(async (args: {
      userId: string;
      kind: SmartUploadDraft["kind"];
      clientSubmissionId: string;
      details: Record<string, unknown>;
      files: File[];
    }) => ({
      version: 1,
      scope: "user-1:asset:scope-1",
      userId: args.userId,
      kind: args.kind,
      clientSubmissionId: args.clientSubmissionId,
      stage: "selected",
      details: args.details,
      savedAt: "2026-08-13T12:00:00.000Z",
      files: args.files.map((file, index) => ({
        fileId: `images-${index}`,
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        originalOrder: index,
        uploaded: false,
        file,
      })),
    }));

    render(workspace());
    await screen.findByRole("button", { name: "Select images" });
    // The full-screen workspace is rendered through a portal into document.body.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });

    const upload = await screen.findByRole("button", { name: "Upload & detect lots" });
    expect(upload).toBeDisabled();
    expect(screen.getByText("Check upload sequence")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Move scan-b.jpg later" })
    );
    await waitFor(() => {
      const persisted =
        mocks.updateDraft.mock.calls[mocks.updateDraft.mock.calls.length - 1]?.[2];
      expect(persisted.files).toMatchObject([
        { fileId: "images-1", name: "scan-c.jpg", originalOrder: 0 },
        { fileId: "images-0", name: "scan-b.jpg", originalOrder: 1 },
        { fileId: "images-2", name: "scan-a.jpg", originalOrder: 2 },
      ]);
      expect(persisted.files.every((file: { file?: File }) => !file.file)).toBe(true);
    });
    expect(upload).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm this image order" }));
    await waitFor(() => expect(upload).toBeEnabled());
  });

  it("does not turn an edge report photo into a divider", async () => {
    const { draft, grouping } = createReviewState();
    const oneLotDraft = { ...draft, files: draft.files.slice(0, 3) };
    const oneLotGrouping: SmartUploadGrouping = {
      ...grouping,
      groups: [grouping.groups[0]],
      files: grouping.files?.slice(0, 3),
      expectedFileCount: 3,
      confirmedFileCount: 3,
    };
    mocks.loadDraft.mockResolvedValue(oneLotDraft);
    mocks.getGrouping.mockResolvedValue(oneLotGrouping);

    render(workspace());
    const firstPhoto = await screen.findByRole("button", {
      name: /photo-0\.jpg\. Use as divider/i,
    });
    fireEvent.click(firstPhoto);

    await screen.findByText(
      "A divider needs report photos on both sides. Select an image between two groups instead."
    );
    expect(mocks.updateGrouping).not.toHaveBeenCalled();
  });

  it("blocks completion when an uploaded image could not be inspected", async () => {
    const { draft, grouping } = createReviewState();
    mocks.loadDraft.mockResolvedValue(draft);
    mocks.getGrouping.mockResolvedValue({
      ...grouping,
      metrics: [
        {
          fileId: "images-7",
          meanLuminance: 0,
          darkPixelRatio: 0,
          variance: 0,
          isDivider: false,
          error: "Input image is unreadable",
        },
      ],
      warnings: ["Could not inspect images-7: Input image is unreadable"],
    });

    render(workspace());

    await screen.findByText("One image could not be checked");
    expect(screen.getByText("photo-7.jpg")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create preview" })
    ).toBeDisabled();
  });
});
