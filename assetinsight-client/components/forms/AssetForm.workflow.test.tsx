import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";
import type { ReportDraftRecord } from "@/services/reportDrafts";
import AssetForm from "./AssetForm";
import type { MixedLot } from "./mixed/types";
import type { BackgroundUploadRequest } from "@/services/backgroundUploadManager";
import { advanceAuthSession } from "@/lib/auth-storage";

type DraftProgress = {
  phase: "preparing" | "uploading" | "verifying" | "complete";
  percent: number;
  message: string;
  totalFiles: number;
  uploadedFiles: number;
  totalBytes: number;
  uploadedBytes: number;
};

type DraftProgressCallback = (
  percent: number,
  message: string,
  details: DraftProgress
) => void;

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  upsertWithMedia: vi.fn(),
  deleteDraftByClientId: vi.fn(),
  createAsset: vi.fn(),
  deleteScopedDraft: vi.fn(),
  deleteSmartUploadDraft: vi.fn(),
  geolocation: vi.fn(),
  reverseGeocode: vi.fn(),
  restoreLots: vi.fn(),
  getDraft: vi.fn(),
  authUser: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  enqueue: vi.fn(),
  isForegroundRequired: vi.fn(),
  createDraftId: vi.fn(),
}));

vi.mock("@/services/backgroundUploadManager", () => ({
  backgroundUploads: {
    enqueue: mocks.enqueue,
    isForegroundRequired: mocks.isForegroundRequired,
    // One switch for both marks (this tab's, and a saved upload's after reload).
    requiresFormSubmission: async (_ownerId: string, kind: string, scopeId?: string) =>
      Boolean(mocks.isForegroundRequired(kind, scopeId)),
    clearForegroundRequirement: vi.fn(),
  },
}));

/**
 * Lets the mocked line start each handed-off upload, as the real one does
 * right after hand-off, so a test can read what reaches AssetService.create.
 */
function runEnqueuedUploads() {
  mocks.enqueue.mockImplementation(async (request: BackgroundUploadRequest) => {
    setTimeout(() => {
      void Promise.resolve(request.upload(() => undefined, new AbortController().signal)).catch(() => undefined);
    }, 0);
    return "background-job";
  });
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  let dynamicIndex = 0;

  return {
    default: () => {
      const componentIndex = dynamicIndex++;
      if (componentIndex !== 0) {
        return function DeferredWorkspace({ open, groupingMethod, details }: { open: boolean; groupingMethod?: string; details?: Record<string, unknown> }) {
          return open ? React.createElement("output", { "data-testid": "asset-upload-method", "data-currency": details?.currency }, groupingMethod) : null;
        };
      }

      return function TestMixedSection({
        value,
        onChange,
        sourceMappedLots,
      }: {
        value: MixedLot[];
        onChange: (value: MixedLot[]) => void;
        sourceMappedLots?: boolean;
      }) {
        const selectedName = value[0]?.files[0]?.name || "No media selected";
        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () =>
                onChange((value.length ? value : [{
                  id: "lot-test-1",
                  files: [],
                  extraFiles: [],
                  coverIndex: 0,
                }]).map((lot) => ({
                    ...lot,
                    mode: "single_lot",
                    files: [
                      new File(["asset-photo"], "asset-photo.jpg", {
                        type: "image/jpeg",
                        lastModified: 1,
                      }),
                    ],
                    extraFiles: [],
                    videoFiles: [],
                    coverIndex: 0,
                  }))),
            },
            "Add test media"
          ),
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () => onChange([0, 2, 0, 1].map((count, index) => ({
                id: `video-lot-${index}`,
                mode: "single_lot",
                files: [new File([`photo-${index}`], `photo-${index}.jpg`, { type: "image/jpeg" })],
                extraFiles: [],
                videoFiles: Array.from({ length: count }, (_, videoIndex) => new File([`video-${index}-${videoIndex}`], `video-${index}-${videoIndex}.mp4`, { type: "video/mp4" })),
                coverIndex: 0,
              }))),
            },
            "Add sparse lot videos"
          ),
          React.createElement(
            "output",
            { "data-testid": "selected-asset-media" },
            selectedName
          ),
          React.createElement(
            "output",
            { "data-testid": "asset-source-locks" },
            JSON.stringify({
              sourceMappedLots: Boolean(sourceMappedLots),
              sources: value.map((lot) => lot.source),
            })
          )
        );
      };
    },
  };
});

vi.mock("@/context/AuthContext", () => ({
  useAuthContext: () => ({
    user: mocks.authUser(),
  }),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
    warning: mocks.toastWarning,
  },
}));

vi.mock("@/services/asset", () => ({
  AssetService: { create: mocks.createAsset },
}));

vi.mock("@/services/browserLocation", () => ({
  BrowserLocationService: { reverseGeocode: mocks.reverseGeocode },
}));

vi.mock("@/services/reportDrafts", () => ({
  ReportDraftService: {
    upsertWithMedia: mocks.upsertWithMedia,
    deleteByClientId: mocks.deleteDraftByClientId,
    restoreLots: mocks.restoreLots,
    get: mocks.getDraft,
  },
  createReportDraftClientId: mocks.createDraftId,
  getDuplicateLotWarning: () => null,
  getReportDraftDeviceId: () => "asset-workflow-device",
}));

vi.mock("@/services/savedInputs", () => ({
  SavedInputService: { create: vi.fn() },
  getDraftFileMetadata: (file: File) => ({
    name: file.name,
    size: file.size,
    mimeType: file.type,
    lastModified: file.lastModified,
  }),
}));

vi.mock("./drafts/storage", () => ({
  recordBrowserObservation: vi.fn(async () => undefined),
  FORM_DRAFT_VERSION: 3,
  deleteScopedDraft: mocks.deleteScopedDraft,
  getScopedDraftKey: () => "asset-workflow-storage-key",
  loadScopedDraft: vi.fn(),
  parseScopedDraftEnvelope: vi.fn(),
  requestDurableDraftStorage: vi.fn(),
  saveScopedDraft: vi.fn(),
}));

vi.mock("./smartUpload/storage", () => ({
  deleteSmartUploadDraft: mocks.deleteSmartUploadDraft,
}));

const originalGeolocation = Object.getOwnPropertyDescriptor(
  window.navigator,
  "geolocation"
);

const position = {
  coords: {
    latitude: 51.507351,
    longitude: -0.127758,
    accuracy: 7.4,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: 1,
} as GeolocationPosition;

const RESOLVED_ASSET_LOCATION =
  "10 Downing Street, London SW1A 2AA, United Kingdom";
const OPENSTREETMAP_COPYRIGHT_URL =
  "https://www.openstreetmap.org/copyright";

const uploadingProgress: DraftProgress = {
  phase: "uploading",
  percent: 35,
  message: "Uploading asset-photo.jpg",
  totalFiles: 1,
  uploadedFiles: 0,
  totalBytes: 11,
  uploadedBytes: 4,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function addTestMedia() {
  fireEvent.click(screen.getByRole("button", { name: "Add test media" }));
}

function fillRequiredReportFields() {
  fireEvent.change(screen.getByLabelText(/Client name/i), {
    target: { value: "Workflow Client" },
  });
  fireEvent.change(screen.getByLabelText(/Appraisal purpose/i), {
    target: { value: "Insurance valuation" },
  });
  fireEvent.change(screen.getByLabelText(/Currency/i), {
    target: { value: "GBP" },
  });
}

function makeAuctioneerSetup(
  kind: AuctioneerWorkItemSetup["kind"] = "unknown"
): AuctioneerWorkItemSetup {
  return {
    workItemId: "asset-work-imported",
    cycleKey: "asset-cycle-imported",
    kind,
    reportType: "asset",
    clientSubmissionId: "asset-imported-submission",
    status: "claimed",
    contract: {
      id: "imported-contract",
      contractNo: "IMPORTED-100",
      customerName: "Imported customer",
      eventTitle: "Imported auction",
      eventDate: "2026-09-14T10:00:00.000Z",
      location: "Imported inspection yard",
      currency: "CAD",
    },
    lots: kind === "scheduleA" ? [
      { sourceKey: "source-1", lotId: "upstream-lot-1", submissionId: "task-1", lotNumber: "10" },
      { sourceKey: "source-2", lotId: "upstream-lot-2", submissionId: "task-2", lotNumber: "11" },
    ] : [],
  };
}

async function waitForResolvedAssetLocation() {
  const location = screen.getByLabelText(/Inspection location/i);
  await waitFor(() =>
    expect(location).toHaveValue(RESOLVED_ASSET_LOCATION)
  );
  return location;
}

function makeAssetResumeDraft(
  location = "Lat 51.507351 / Long -0.127758"
): ReportDraftRecord {
  return {
    _id: "asset-resume-id",
    user: "user-asset-workflow",
    clientDraftId: "asset-resume-draft",
    type: "asset",
    storageMode: "r2_media",
    revision: 4,
    contractNo: "ASSET-RESTORE-1",
    formData: {
      location,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      currency: "GBP",
    },
    lots: [],
    media: [],
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
  };
}

describe("AssetForm manual save and submission workflow", () => {
  const originalWorkflowScrollIntoView = HTMLElement.prototype.scrollIntoView;
  beforeEach(() => {
    // Validation may focus a newly remounted input after its 80 ms timer.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: vi.fn() });
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.isForegroundRequired.mockReturnValue(false);
    mocks.createDraftId.mockReturnValue("asset-workflow-draft");
    mocks.authUser.mockReturnValue({ _id: "user-asset-workflow", username: "Alex Appraiser", companyName: "Asset Insight QA" });
    mocks.deleteDraftByClientId.mockResolvedValue(undefined);
    mocks.deleteScopedDraft.mockResolvedValue(undefined);
    mocks.deleteSmartUploadDraft.mockResolvedValue(undefined);
    mocks.reverseGeocode.mockResolvedValue({
      location: RESOLVED_ASSET_LOCATION,
      currency: "GBP",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
      source: "nominatim",
    });
    mocks.restoreLots.mockResolvedValue([]);
    mocks.getDraft.mockResolvedValue(makeAssetResumeDraft());
    mocks.geolocation.mockImplementation(
      (success: PositionCallback, _error?: PositionErrorCallback, _options?: PositionOptions) => {
        success(position);
      }
    );
    Object.defineProperty(window.navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition: mocks.geolocation },
    });
    window.localStorage.clear();
  });

  afterAll(() => {
    if (originalWorkflowScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalWorkflowScrollIntoView });
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalGeolocation) {
      Object.defineProperty(
        window.navigator,
        "geolocation",
        originalGeolocation
      );
    } else {
      Reflect.deleteProperty(window.navigator, "geolocation");
    }
  });

  it("keeps the selected FLV in the durable submission when the optional comparison table is off", async () => {
    render(<AssetForm continuationDetails={{ selectedValuationMethods: ["FLV"], includeValuationTable: false }} />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    const request = mocks.enqueue.mock.calls[0][0] as BackgroundUploadRequest;
    expect(request.details).toMatchObject({ include_valuation_table: false, valuation_methods: ["FLV"] });
  });

  it("closes only after durable handoff and protects the next report from late upload cleanup", async () => {
    const persistence = deferred<string>();
    const upload = deferred<Record<string, unknown>>();
    const onSuccess = vi.fn();
    mocks.enqueue.mockReturnValueOnce(persistence.promise);
    mocks.createAsset.mockReturnValueOnce(upload.promise);
    let sequence = 0;
    mocks.createDraftId.mockImplementation(() => `independent-asset-${++sequence}`);
    const view = render(<AssetForm onSuccess={onSuccess} />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    const request = mocks.enqueue.mock.calls[0][0] as BackgroundUploadRequest;
    expect(request).toMatchObject({ ownerId: "user-asset-workflow", kind: "asset", totalFiles: 1, scopeId: "independent-asset-1" });
    expect(request.files[0]).toMatchObject({ name: "asset-photo.jpg", size: request.media[0].size, lastModified: 1 });
    expect(request.draftSnapshot).toMatchObject({ formData: { clientName: "Workflow Client", clientSubmissionId: request.clientSubmissionId }, lots: [{ files: [request.media[0]] }] });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.createAsset).not.toHaveBeenCalled();
    await act(async () => persistence.resolve("background-job"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(onSuccess).toHaveBeenCalledWith(expect.stringContaining("while this tab stays open"));
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("No media selected");
    expect(request.signal?.aborted).toBe(false);
    fillRequiredReportFields(); addTestMedia();
    fireEvent.change(screen.getByLabelText(/Client name/i), { target: { value: "Next client" } });
    fireEvent.change(screen.getByLabelText(/Inspection location/i), { target: { value: "Next yard" } });
    const lateResult = request.upload(vi.fn(), new AbortController().signal);
    await act(async () => upload.resolve({ reportId: "accepted-old", jobId: "job-old", status: "processing" }));
    await lateResult;
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Next client");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(mocks.deleteScopedDraft).not.toHaveBeenCalled();
    const nextPersistence = deferred<string>();
    mocks.enqueue.mockReturnValueOnce(nextPersistence.promise);
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
    const next = mocks.enqueue.mock.calls[1][0] as BackgroundUploadRequest;
    expect(next.scopeId).not.toBe(request.scopeId);
    expect(next.clientSubmissionId).not.toBe(request.clientSubmissionId);
    expect(next.details.client_name).toBe("Next client");
    await act(async () => nextPersistence.reject(new Error("Storage unavailable. Retry this same report.")));
    view.unmount();
    expect(request.signal?.aborted).toBe(false);
  });

  it("keeps an ordinary form and media when durable handoff fails", async () => {
    const onSuccess = vi.fn();
    mocks.enqueue.mockRejectedValueOnce(new Error("Browser storage is full. Free space and retry this same report."));
    render(<AssetForm onSuccess={onSuccess} />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await screen.findByText(/Browser storage is full/);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.createAsset).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Workflow Client");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
    expect(mocks.deleteScopedDraft).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
  });

  it.each(["cancel", "session", "unmount"] as const)("ignores a late handoff after %s", async (interruption) => {
    const persistence = deferred<string>();
    const onSuccess = vi.fn();
    mocks.enqueue.mockReturnValueOnce(persistence.promise);
    const view = render(<AssetForm onSuccess={onSuccess} />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    const request = mocks.enqueue.mock.calls[0][0] as BackgroundUploadRequest;
    if (interruption === "cancel") fireEvent.click(screen.getByRole("button", { name: "Stop upload" }));
    else if (interruption === "session") advanceAuthSession();
    else view.unmount();
    await act(async () => persistence.resolve("late-job"));
    if (interruption !== "session") expect(request.signal?.aborted).toBe(true);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.deleteScopedDraft).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
  });

  it.each([
    { failure: new Error("Network Error"), expected: /connection|network/i },
    { failure: Object.assign(new Error("Request failed with status code 409"), { response: { status: 409, data: { code: "DRAFT_REVISION_CONFLICT", message: "This draft changed on another device. Review the latest saved version." } } }), expected: /version already saved/i },
  ])("keeps an unsuccessful draft save open with actionable guidance", async ({ failure, expected }) => {
    mocks.upsertWithMedia.mockRejectedValue(failure);
    render(<AssetForm />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: /Save draft/i }));
    await waitFor(() => expect(screen.getByText(expected)).toBeVisible());
    expect(screen.queryByText("Network Error")).not.toBeInTheDocument();
    expect(screen.queryByText(/Request failed with status code/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Workflow Client");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
    expect(mocks.deleteScopedDraft).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it.each([{}, { reportId: "unaccepted-placeholder", phase: "upload", status: "uploading" }])("does not clear a form for an incomplete acceptance receipt %j", async (receipt) => {
    const onSuccess = vi.fn();
    mocks.createAsset.mockResolvedValue(receipt);
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" onSuccess={onSuccess} />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Create report" })).toBeEnabled());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.deleteScopedDraft).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Workflow Client");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
  });

  it("keeps current data when an earlier accepted report is found", async () => {
    const onSuccess = vi.fn();
    mocks.createAsset.mockResolvedValue({ reportId: "old-report", jobId: "old-job", status: "processed", reusedAcceptance: true });
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" onSuccess={onSuccess} />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await screen.findByText(/earlier submission was already accepted/);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(mocks.deleteScopedDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
  });

  it.each([true, false])("offers separate saved recovery only for authoritative eligibility %s", async (canCreateSeparate) => {
    mocks.createAsset.mockRejectedValue({ response: { status: 409, data: { code: "UPLOAD_SESSION_REPORT_UNAVAILABLE", data: { sessionId: "old-session", accepted: true, reportAvailable: false, canCreateSeparate } } } });
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await screen.findByText(/old submission cannot be reused/);
    expect(Boolean(screen.queryByRole("button", { name: "Save separate draft" }))).toBe(canCreateSeparate);
    expect(mocks.upsertWithMedia).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
  });

  it("checks an existing report in another tab without closing the unsent form", async () => {
    const onSuccess = vi.fn();
    mocks.createAsset.mockRejectedValue({ response: { status: 409, data: { code: "ACTIVE_REPORT_EXISTS" } } });
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" onSuccess={onSuccess} />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    const dialog = await screen.findByRole("dialog", { name: "Report already processing" });
    const link = within(dialog).getByRole("link", { name: "Open My Reports (new tab)" });
    expect(link).toHaveAttribute("target", "_blank"); fireEvent.click(link);
    expect(onSuccess).not.toHaveBeenCalled(); expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Workflow Client");
  });

  it.each([["Smart Upload", "black_divider"], ["Lot Number Upload", "lot_number"]])("opens %s with its own method", async (label, method) => {
    render(<AssetForm />);
    fillRequiredReportFields();
    fireEvent.change(screen.getByRole("textbox", { name: /inspection location/i }), { target: { value: "Regina" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Currency/i }), { target: { value: "USD" } });
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(await screen.findByTestId("asset-upload-method")).toHaveTextContent(method);
    expect(screen.getByTestId("asset-upload-method")).toHaveAttribute("data-currency", "USD");
    expect(mocks.createAsset).not.toHaveBeenCalled();
  });

  it("prefills a fresh continuation with edited details without reusing the previous submission", async () => {
    const auctioneer = makeAuctioneerSetup("unknown");
    runEnqueuedUploads();
    render(<AssetForm auctioneer={auctioneer} continuationDetails={{ clientName: "Edited client", location: "Edited yard", currency: "USD", appraisalPurpose: "Continued inspection", bankPhotosEnabled: true }} />);
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Edited client");
    expect(screen.getByLabelText(/Inspection location/i)).toHaveValue("Edited yard");
    expect(screen.getByLabelText(/Currency/i)).toHaveValue("USD");
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
    expect(mocks.createAsset.mock.calls[0][0]).toMatchObject({ client_submission_id: auctioneer.clientSubmissionId, client_name: "Edited client", location: "Edited yard", currency: "USD" });
  });

  /*
     Owner 2026-10-29: "i thought the job works in the background and not hold
     up the screen". Create Lot & Close on an Auctioneer work item hands its
     upload to the line like any report; the payload names the work item.
  */
  it("hands Create Lot & Close for an Auctioneer work item to the background and frees the screen", async () => {
    const persistence = deferred<string>();
    const onAcceptedAndContinue = vi.fn();
    const onSuccess = vi.fn();
    const auctioneer = makeAuctioneerSetup("scheduleA");
    mocks.enqueue.mockReturnValueOnce(persistence.promise);
    mocks.createAsset.mockResolvedValueOnce({ reportId: "accepted-in-background", jobId: "accepted-job", status: "processing" });
    render(<AssetForm auctioneer={auctioneer} onAcceptedAndContinue={onAcceptedAndContinue} onSuccess={onSuccess} />);
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create Lot & Close" }));

    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    const request = mocks.enqueue.mock.calls[0][0] as BackgroundUploadRequest;
    expect(request).toMatchObject({
      ownerId: "user-asset-workflow", kind: "asset", endpoint: "/asset", title: auctioneer.contract.contractNo,
      scopeId: auctioneer.clientSubmissionId, clientSubmissionId: auctioneer.clientSubmissionId,
    });
    expect(request.details).toMatchObject({
      auctioneer_work_item_id: auctioneer.workItemId,
      client_submission_id: auctioneer.clientSubmissionId,
      contract_no: auctioneer.contract.contractNo,
    });
    // A review copy of this saved upload must reopen against the same work item.
    expect(request.draftSnapshot).toMatchObject({ formData: { auctioneerWorkItemId: auctioneer.workItemId, clientSubmissionId: auctioneer.clientSubmissionId } });
    expect(mocks.createAsset).not.toHaveBeenCalled();

    await act(async () => persistence.resolve("background-job"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("while this tab stays open")));
    expect(screen.queryByRole("dialog", { name: "Uploading your report" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Lot & Close" })).toBeEnabled();
    expect(request.signal?.aborted).toBe(false);
    expect(onAcceptedAndContinue).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();

    // The line sends exactly the payload the inline path would have sent.
    await act(async () => { await request.upload(vi.fn(), new AbortController().signal); });
    expect(mocks.createAsset).toHaveBeenCalledOnce();
    expect(mocks.createAsset.mock.calls[0][0]).toBe(request.details);
    expect(onAcceptedAndContinue).not.toHaveBeenCalled();
  });

  it("keeps an Auctioneer work item's form open when it cannot be handed off", async () => {
    const onSuccess = vi.fn();
    mocks.enqueue.mockRejectedValueOnce(new Error("Browser storage is full. Free space and retry this same report."));
    render(<AssetForm auctioneer={makeAuctioneerSetup()} onAcceptedAndContinue={vi.fn()} onSuccess={onSuccess} />);
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create Lot & Close" }));
    await screen.findByText(/Browser storage is full/);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.createAsset).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
    expect(screen.getByLabelText(/Contract number/i)).toHaveValue("IMPORTED-100");
  });

  it.each(["unknown", "scheduleA"] as const)(
    "continues an imported %s report at acceptance without waiting for processing or old-draft cleanup",
    async (kind) => {
      const upload = deferred<Record<string, unknown>>();
      const cleanup = deferred<void>();
      const onAcceptedAndContinue = vi.fn();
      const onSuccess = vi.fn();
      const onDraftStatusChange = vi.fn();
      const auctioneer = makeAuctioneerSetup(kind);
      mocks.createAsset.mockReturnValueOnce(upload.promise);
      mocks.deleteDraftByClientId.mockReturnValueOnce(cleanup.promise);
      render(<AssetForm auctioneer={auctioneer} onAcceptedAndContinue={onAcceptedAndContinue} onSuccess={onSuccess} onDraftStatusChange={onDraftStatusChange} />);
      addTestMedia();

      const sources = JSON.parse(screen.getByTestId("asset-source-locks").textContent || "{}");
      expect(sources.sourceMappedLots).toBe(kind === "scheduleA");
      if (kind === "scheduleA") {
        expect(sources.sources.map((source: { locked: boolean }) => source.locked)).toEqual([true, true]);
      }
      fireEvent.click(screen.getByRole("button", { name: "Create Lot & Continue" }));
      await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(onAcceptedAndContinue).not.toHaveBeenCalled();
      expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
      const details = mocks.createAsset.mock.calls[0][0];
      expect(details).toMatchObject({
        auctioneer_work_item_id: auctioneer.workItemId,
        client_submission_id: auctioneer.clientSubmissionId,
        contract_no: auctioneer.contract.contractNo,
      });
      if (kind === "scheduleA") {
        expect(details.mixed_lots).toEqual(auctioneer.lots.map((lot) => expect.objectContaining({
          source_key: lot.sourceKey,
          source_lot_id: lot.lotId,
          source_submission_id: lot.submissionId,
          mode: "single_lot",
        })));
      }

      await act(async () => upload.resolve({ reportId: "accepted-asset-report", jobId: "accepted-job", status: "processing" }));
      await waitFor(() => expect(mocks.deleteDraftByClientId).toHaveBeenCalledExactlyOnceWith(auctioneer.clientSubmissionId, "asset"));
      expect(onAcceptedAndContinue).toHaveBeenCalledExactlyOnceWith("accepted-asset-report", expect.objectContaining({ contractNo: auctioneer.contract.contractNo }));
      expect(onSuccess).not.toHaveBeenCalled();
      await act(async () => cleanup.resolve());

      await waitFor(() => expect(onAcceptedAndContinue).toHaveBeenCalledExactlyOnceWith("accepted-asset-report", expect.objectContaining({ contractNo: auctioneer.contract.contractNo })));
      expect(onSuccess).not.toHaveBeenCalled();
      expect(mocks.createAsset).toHaveBeenCalledOnce();
      expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("No media selected");
      expect(onDraftStatusChange).not.toHaveBeenCalledWith("saved", "Submission accepted");
    }
  );

  it("preserves imported media and submission identity when the new-lot upload fails and is retried", async () => {
    const onAcceptedAndContinue = vi.fn();
    const onSuccess = vi.fn();
    mocks.createAsset
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({ reportId: "accepted-after-retry", jobId: "accepted-job", status: "processing" });
    render(<AssetForm auctioneer={makeAuctioneerSetup()} onAcceptedAndContinue={onAcceptedAndContinue} onSuccess={onSuccess} />);
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create Lot & Continue" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Create Lot & Continue" })).toBeEnabled());
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
    expect(screen.getByLabelText(/Contract number/i)).toHaveValue("IMPORTED-100");
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(onAcceptedAndContinue).not.toHaveBeenCalled();
    const original = mocks.createAsset.mock.calls[0];
    fireEvent.click(screen.getByRole("button", { name: "Create Lot & Continue" }));

    await waitFor(() => expect(onAcceptedAndContinue).toHaveBeenCalledExactlyOnceWith("accepted-after-retry", expect.objectContaining({ contractNo: "IMPORTED-100" })));
    expect(mocks.createAsset).toHaveBeenCalledTimes(2);
    expect(mocks.createAsset.mock.calls[1][0].client_submission_id).toBe(original[0].client_submission_id);
    expect(mocks.createAsset.mock.calls[1][1]).toEqual(original[1]);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it.each(["continue", "normal", "save"] as const)(
    "keeps rapid new-lot, normal-submit, and save clicks in the first %s intent",
    async (first) => {
      const pending = deferred<Record<string, unknown>>();
      const onAcceptedAndContinue = vi.fn();
      const onSuccess = vi.fn();
      mocks.createAsset.mockReturnValue(pending.promise);
      mocks.upsertWithMedia.mockReturnValue(pending.promise);
      runEnqueuedUploads();
      render(<AssetForm auctioneer={makeAuctioneerSetup()} onAcceptedAndContinue={onAcceptedAndContinue} onSuccess={onSuccess} />);
      addTestMedia();
      const actions = {
        continue: screen.getByRole("button", { name: "Create Lot & Continue" }),
        normal: screen.getByRole("button", { name: "Create Lot & Close" }),
        save: screen.getByRole("button", { name: /Save draft/i }),
      };
      act(() => {
        actions[first].click();
        actions.continue.click();
        actions.normal.click();
        actions.save.click();
      });

      if (first === "save") {
        await waitFor(() => expect(mocks.upsertWithMedia).toHaveBeenCalledOnce());
        expect(mocks.createAsset).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
        expect(mocks.upsertWithMedia).not.toHaveBeenCalled();
      }
      // Close hands off to the upload line (owner, 2026-10-29); Continue stays inline.
      expect(mocks.enqueue).toHaveBeenCalledTimes(first === "normal" ? 1 : 0);
      await act(async () => pending.resolve({ _id: "saved-draft", media: [], reportId: "accepted-single-flight", jobId: "accepted-job", status: "processing" }));
      if (first === "continue") {
        await waitFor(() => expect(onAcceptedAndContinue).toHaveBeenCalledExactlyOnceWith("accepted-single-flight", expect.objectContaining({ contractNo: "IMPORTED-100" })));
        expect(onSuccess).not.toHaveBeenCalled();
      } else if (first === "normal") {
        await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
        expect(onAcceptedAndContinue).not.toHaveBeenCalled();
      } else {
        expect(onAcceptedAndContinue).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
      }
    }
  );

  it("continues accepted imported work even when old-draft cleanup fails", async () => {
    const onAcceptedAndContinue = vi.fn();
    const onSuccess = vi.fn();
    mocks.createAsset.mockResolvedValueOnce({ reportId: "accepted-cleanup-failure", jobId: "accepted-job", status: "processing" });
    mocks.deleteScopedDraft.mockRejectedValueOnce(new Error("Local storage unavailable"));
    render(<AssetForm auctioneer={makeAuctioneerSetup()} onAcceptedAndContinue={onAcceptedAndContinue} onSuccess={onSuccess} />);
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create Lot & Continue" }));

    await waitFor(() => expect(onAcceptedAndContinue).toHaveBeenCalledExactlyOnceWith("accepted-cleanup-failure", expect.objectContaining({ contractNo: "IMPORTED-100" })));
    expect(mocks.toastWarning).toHaveBeenCalledWith(expect.stringContaining("Report submitted"));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.createAsset).toHaveBeenCalledOnce();
  });

  it("shows no new-lot action without both an imported contract and continuation callback", () => {
    const view = render(<AssetForm onAcceptedAndContinue={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Create Lot & Continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create report" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Lot & Close" })).not.toBeInTheDocument();
    view.rerender(<AssetForm auctioneer={makeAuctioneerSetup()} />);
    expect(screen.queryByRole("button", { name: "Create Lot & Continue" })).not.toBeInTheDocument();
  });

  it("saves and resumes a fresh successor under its own work item and submission identity", async () => {
    const previous = makeAuctioneerSetup();
    const next = { ...previous, workItemId: "asset-successor-work", clientSubmissionId: "asset-successor-submission" };
    const onSuccess = vi.fn();
    mocks.upsertWithMedia.mockResolvedValueOnce({ _id: "successor-draft", media: [] });
    const first = render(<AssetForm auctioneer={next} />);
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: /Save draft/i }));
    await waitFor(() => expect(mocks.upsertWithMedia).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Saving your draft" })).not.toBeInTheDocument());
    const [saved, lots] = mocks.upsertWithMedia.mock.calls[0];
    expect(saved).toMatchObject({
      clientDraftId: next.clientSubmissionId,
      formData: { clientSubmissionId: next.clientSubmissionId, auctioneerWorkItemId: next.workItemId },
    });
    expect(saved.clientDraftId).not.toBe(previous.clientSubmissionId);
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    first.unmount();

    const resumeDraft: ReportDraftRecord = {
      ...makeAssetResumeDraft(next.contract.location),
      clientDraftId: saved.clientDraftId,
      contractNo: saved.contractNo,
      revision: saved.revision,
      formData: saved.formData,
      lots,
    };
    mocks.restoreLots.mockResolvedValueOnce(lots);
    mocks.deleteScopedDraft.mockClear();
    mocks.createAsset.mockResolvedValueOnce({ reportId: "successor-accepted", jobId: "accepted-job", status: "processing" });
    runEnqueuedUploads();
    render(<AssetForm auctioneer={next} resumeDraft={resumeDraft} onSuccess={onSuccess} />);
    await waitFor(() => expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());

    // The saved draft's identity is the upload's: the line keeps its media under it.
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({ scopeId: next.clientSubmissionId, clientSubmissionId: next.clientSubmissionId });
    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
    expect(mocks.createAsset.mock.calls[0][0]).toMatchObject({
      auctioneer_work_item_id: next.workItemId,
      client_submission_id: next.clientSubmissionId,
      contract_no: previous.contract.contractNo,
    });
    // A handed-off upload never deletes its draft; the server does on acceptance.
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
    expect(mocks.deleteScopedDraft).not.toHaveBeenCalled();
  });

  /*
     Owner 2026-10-28: a successor work item on a Schedule A contract sends
     nothing until the appraiser chooses the item its lots belong to; the one
     choice covers every lot in the form.
  */
  describe("Schedule A item choice", () => {
    const CHOOSE = "Choose which Schedule A item these lots belong to.";
    const choices = [
      { lineId: "line-1", title: "2021 Ford F150", parentLotId: "lot-10" },
      { lineId: "line-2", title: "Misc Shop Tools", parentLotId: "lot-20" },
    ];
    const requiringSetup = (scheduleAChoices = choices): AuctioneerWorkItemSetup => ({
      ...makeAuctioneerSetup("unknown"),
      requiresScheduleAItem: true,
      scheduleAChoices,
    });
    const picker = () => screen.getByRole("combobox", { name: /Schedule A item/i });
    // A refused submit scrolls to the field, which jsdom does not implement.
    // Kept for the whole block: the form scrolls on a timer after the refusal.
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    beforeAll(() => {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    });
    afterAll(() => {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    });

    it("blocks the upload until an item is chosen, then sends it on every lot", async () => {
      mocks.createAsset.mockResolvedValueOnce({ reportId: "schedule-a-report", jobId: "accepted-job", status: "processing" });
      runEnqueuedUploads();
      render(<AssetForm auctioneer={requiringSetup()} />);
      expect(within(picker()).getAllByRole("option").map((option) => option.textContent)).toEqual([
        "Choose a Schedule A item", "2021 Ford F150", "Misc Shop Tools",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Add sparse lot videos" }));

      fireEvent.click(screen.getByRole("button", { name: "Create report" }));
      expect(await screen.findAllByText(CHOOSE)).not.toHaveLength(0);
      await waitFor(() => expect(picker()).toHaveFocus());
      expect(picker()).toHaveAttribute("aria-invalid", "true");
      expect(mocks.createAsset).not.toHaveBeenCalled();

      fireEvent.change(picker(), { target: { value: "lot-20" } });
      expect(screen.queryByText(CHOOSE)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Create report" }));
      await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
      const details = mocks.createAsset.mock.calls[0][0];
      expect(details.mixed_lots).toHaveLength(4);
      expect(details.mixed_lots.map((lot: any) => lot.schedule_a_parent_lot_id)).toEqual(["lot-20", "lot-20", "lot-20", "lot-20"]);
    });

    it("explains in place of the picker when no item is ticked Several lots", async () => {
      render(<AssetForm auctioneer={requiringSetup([])} />);
      const explanation = "No Schedule A item on this contract is marked Several lots in Auctioneer 2.0. Ask the office to tick it on the contract, then try again.";
      expect(screen.getByText(explanation)).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: /Schedule A item/i })).not.toBeInTheDocument();
      addTestMedia();

      fireEvent.click(screen.getByRole("button", { name: "Create report" }));
      await waitFor(() => expect(screen.getAllByText(explanation).length).toBeGreaterThan(1));
      await waitFor(() => expect(document.getElementById("asset-scheduleAItem")).toHaveFocus());
      expect(mocks.createAsset).not.toHaveBeenCalled();
    });

    it("shows the server's refusal when Auctioneer still lacks the item", async () => {
      const refusal = "Choose which Schedule A item this lot belongs to.";
      mocks.createAsset.mockRejectedValueOnce({
        response: { status: 409, data: { code: "AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED", message: refusal } },
      });
      // A background attempt was sent back with this refusal, so the reopened
      // draft submits inline where the picker can answer it (owner, 2026-10-29).
      mocks.isForegroundRequired.mockReturnValue(true);
      render(<AssetForm auctioneer={requiringSetup()} />);
      addTestMedia();
      fireEvent.change(picker(), { target: { value: "lot-10" } });
      fireEvent.click(screen.getByRole("button", { name: "Create report" }));

      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(refusal));
      expect(screen.getAllByText(refusal).length).toBeGreaterThan(0);
      expect(picker()).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg");
    });

    it("keeps the choice in the draft and drops it when the refreshed setup no longer offers it", async () => {
      mocks.upsertWithMedia.mockResolvedValueOnce({ _id: "schedule-a-draft", media: [] });
      const first = render(<AssetForm auctioneer={requiringSetup()} />);
      addTestMedia();
      fireEvent.change(picker(), { target: { value: "lot-20" } });
      fireEvent.click(screen.getByRole("button", { name: /Save draft/i }));
      await waitFor(() => expect(mocks.upsertWithMedia).toHaveBeenCalledOnce());
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Saving your draft" })).not.toBeInTheDocument());
      const [saved, lots] = mocks.upsertWithMedia.mock.calls[0];
      expect(saved.formData.scheduleAParentLotId).toBe("lot-20");
      first.unmount();

      const resumeDraft: ReportDraftRecord = {
        ...makeAssetResumeDraft(makeAuctioneerSetup().contract.location),
        clientDraftId: saved.clientDraftId,
        contractNo: saved.contractNo,
        revision: saved.revision,
        formData: saved.formData,
        lots,
      };
      mocks.restoreLots.mockResolvedValue(lots);
      const reopened = render(<AssetForm auctioneer={requiringSetup()} resumeDraft={resumeDraft} />);
      await waitFor(() => expect(picker()).toHaveValue("lot-20"));
      reopened.unmount();

      render(<AssetForm auctioneer={requiringSetup([choices[0]])} resumeDraft={resumeDraft} />);
      await waitFor(() => expect(screen.getByTestId("selected-asset-media")).toHaveTextContent("asset-photo.jpg"));
      expect(picker()).toHaveValue("");
      fireEvent.click(screen.getByRole("button", { name: "Create report" }));
      expect(await screen.findAllByText(CHOOSE)).not.toHaveLength(0);
      expect(mocks.createAsset).not.toHaveBeenCalled();
    });

    it("changes nothing on a work item that does not ask for an item", async () => {
      mocks.createAsset.mockResolvedValueOnce({ reportId: "plain-report", jobId: "accepted-job", status: "processing" });
      runEnqueuedUploads();
      render(<AssetForm auctioneer={{ ...makeAuctioneerSetup("unknown"), requiresScheduleAItem: false, scheduleAChoices: choices }} />);
      expect(screen.queryByRole("combobox", { name: /Schedule A item/i })).not.toBeInTheDocument();
      addTestMedia();
      fireEvent.click(screen.getByRole("button", { name: "Create report" }));
      await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
      expect(mocks.createAsset.mock.calls[0][0].mixed_lots[0]).not.toHaveProperty("schedule_a_parent_lot_id");
    });
  });

  it("defaults new Asset reports to no watermark and allows explicit opt-in", async () => {
    render(<AssetForm />);
    await waitForResolvedAssetLocation();
    const watermark = screen.getByRole("checkbox", { name: /Apply watermark/i });
    expect(watermark).not.toBeChecked();
    fireEvent.click(watermark);
    expect(watermark).toBeChecked();
    fireEvent.click(watermark);
    expect(watermark).not.toBeChecked();
  });

  it("submits sparse per-lot video counts with every selected clip in lot order", async () => {
    mocks.createAsset.mockResolvedValueOnce({ reportId: "video-report", jobId: "accepted-job", status: "processing" });
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    fireEvent.click(screen.getByRole("button", { name: "Add sparse lot videos" }));
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
    const [details, photos, clips] = mocks.createAsset.mock.calls[0];
    expect(details.mixed_lots.map((lot: any) => lot.video_count)).toEqual([0, 2, 0, 1]);
    expect(photos.map((file: File) => file.name)).toEqual(["photo-0.jpg", "photo-1.jpg", "photo-2.jpg", "photo-3.jpg"]);
    expect(clips.map((file: File) => file.name)).toEqual(["video-1-0.mp4", "video-1-1.mp4", "video-3-0.mp4"]);
  });

  it.each([undefined, false, true])("restores watermark choice %s without opting missing draft values in", async (watermarkImages) => {
    const draft = makeAssetResumeDraft(RESOLVED_ASSET_LOCATION);
    draft.formData = { ...draft.formData, watermarkImages };
    const onDraftStatusChange = vi.fn();
    render(<AssetForm resumeDraft={draft} onDraftStatusChange={onDraftStatusChange} />);
    await waitFor(() => expect(onDraftStatusChange).toHaveBeenCalledWith("saved", "Draft and photos restored"));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Apply watermark/i })).toHaveProperty("checked", watermarkImages === true));
  });

  it("keeps form and media changes local until Save draft is selected", async () => {
    vi.useFakeTimers();
    render(<AssetForm />);

    fireEvent.change(screen.getByLabelText(/Client name/i), {
      target: { value: "Unsaved workflow client" },
    });
    addTestMedia();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent(
      "asset-photo.jpg"
    );
    expect(mocks.upsertWithMedia).not.toHaveBeenCalled();
  });

  it("persists only after the explicit Save draft action", async () => {
    mocks.upsertWithMedia.mockImplementation(
      async (
        _input: unknown,
        _lots: unknown,
        onProgress?: DraftProgressCallback
      ) => {
        onProgress?.(100, "Draft and photos saved", {
          ...uploadingProgress,
          phase: "complete",
          percent: 100,
          message: "Draft and photos saved",
          uploadedFiles: 1,
          uploadedBytes: 11,
        });
        return { _id: "draft-server-1", media: [] };
      }
    );
    render(<AssetForm />);
    addTestMedia();

    fireEvent.click(screen.getByRole("button", { name: /Save draft/i }));

    await waitFor(() => expect(mocks.upsertWithMedia).toHaveBeenCalledOnce());
    expect(mocks.upsertWithMedia.mock.calls[0][0].formData.watermarkImages).toBe(false);
    expect(mocks.upsertWithMedia.mock.calls[0][0].formData).not.toHaveProperty("auctioneerWorkItemId");
    const [, lots, , signal] = mocks.upsertWithMedia.mock.calls[0];
    expect(lots[0].files[0].name).toBe("asset-photo.jpg");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("locks immediately, ignores a rapid repeated save, and cancels the original save", async () => {
    let saveSignal: AbortSignal | undefined;
    mocks.upsertWithMedia.mockImplementation(
      (
        _input: unknown,
        _lots: unknown,
        _onProgress?: DraftProgressCallback,
        signal?: AbortSignal
      ) => {
        saveSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
    );
    render(<AssetForm />);
    fireEvent.change(screen.getByLabelText(/Client name/i), {
      target: { value: "Keep this client" },
    });
    addTestMedia();

    const saveButton = screen.getByRole("button", { name: /Save draft/i });
    act(() => {
      saveButton.click();
      saveButton.click();
    });

    const dialog = await screen.findByRole("dialog", {
      name: "Saving your draft",
    });
    expect(mocks.upsertWithMedia).toHaveBeenCalledOnce();
    expect(saveSignal).toBeInstanceOf(AbortSignal);
    expect(dialog).toHaveClass("fixed", "inset-0", "z-[1500]");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      within(dialog).getByRole("button", { name: "Cancel save" })
    ).toBeVisible();
    expect(within(dialog).getByText(/keep this page open/i)).toBeVisible();
    const hiddenWorkspace = document
      .getElementById("asset-clientName")
      ?.closest("[inert]");
    expect(hiddenWorkspace).not.toBeNull();
    expect(hiddenWorkspace).toHaveAttribute("inert");
    expect(hiddenWorkspace).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.queryByRole("contentinfo", { name: "Form actions" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /Client name/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create report" })
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel save" })
    );

    await waitFor(() => expect(saveSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Saving your draft" })
      ).not.toBeInTheDocument()
    );
    expect(
      document.getElementById("asset-clientName")?.closest("[inert]")
    ).toBeNull();
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Keep this client");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent(
      "asset-photo.jpg"
    );
  });

  it("detects the currency from the report location and exposes a dropdown override", async () => {
    mocks.reverseGeocode.mockResolvedValue({ location: "London, United Kingdom", currency: "GBP" });
    render(<AssetForm />);
    const currency = screen.getByRole("combobox", { name: /Currency/i });
    await waitFor(() => expect(currency).toHaveValue("GBP"));
    expect(within(currency).getByRole("option", { name: /USD/ })).toBeInTheDocument();
    fireEvent.change(currency, { target: { value: "EUR" } });
    expect(currency).toHaveValue("EUR");
  });

  it("requires an explicit currency when the resolved location has no recognized currency", async () => {
    mocks.reverseGeocode.mockResolvedValue({ location: "Unknown inspection yard, Unmapped country" });
    render(<AssetForm />);
    await waitFor(() => expect(screen.getByLabelText(/^Inspection location/i)).toHaveValue("Unknown inspection yard, Unmapped country"));
    expect(screen.getByRole("combobox", { name: /Currency/i })).toHaveValue("");
    fireEvent.change(screen.getByRole("combobox", { name: /Currency/i }), { target: { value: "EUR" } });
    expect(screen.getByRole("combobox", { name: /Currency/i })).toHaveValue("EUR");
  });

  it("keeps a manual currency when an earlier geolocation request finishes", async () => {
    const lookup = deferred<{ location: string; currency: string }>();
    mocks.reverseGeocode.mockReturnValueOnce(lookup.promise);
    render(<AssetForm />);
    await waitFor(() => expect(mocks.reverseGeocode).toHaveBeenCalledOnce());
    const currency = screen.getByRole("combobox", { name: /Currency/i });
    fireEvent.change(currency, { target: { value: "EUR" } });
    await act(async () => { lookup.resolve({ location: "London, United Kingdom", currency: "GBP" }); await lookup.promise; });
    expect(currency).toHaveValue("EUR");
    expect(screen.getByLabelText(/^Inspection location/i)).toHaveValue("London, United Kingdom");
  });

  it("waits for an automatic currency lookup before submitting a previously resolved report", async () => {
    const lookup = deferred<{ location: string; currency: string }>();
    mocks.enqueue.mockReturnValue(new Promise(() => {}));
    render(<AssetForm />);
    await waitForResolvedAssetLocation();
    fireEvent.change(screen.getByLabelText(/Client name/i), { target: { value: "Workflow Client" } });
    fireEvent.change(screen.getByLabelText(/Appraisal purpose/i), { target: { value: "Insurance valuation" } });
    addTestMedia();
    const currencyField = screen.getByRole("combobox", { name: /Currency/i });
    currencyField.scrollIntoView = vi.fn();
    mocks.reverseGeocode.mockReturnValueOnce(lookup.promise);
    fireEvent.click(screen.getByRole("button", { name: "Re-detect" }));
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    expect(document.getElementById("asset-currency-error")).toHaveTextContent("Wait for currency detection to finish, or choose a currency.");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await waitFor(() => expect(currencyField.scrollIntoView).toHaveBeenCalled());
    await act(async () => { lookup.resolve({ location: "Austin, Texas, United States", currency: "USD" }); await lookup.promise; });
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    expect(mocks.enqueue.mock.calls[0][0].details.currency).toBe("USD");
  });

  it("allows an explicit manual currency while an unrelated location re-detection is pending", async () => {
    const lookup = deferred<{ location: string; currency: string }>();
    mocks.enqueue.mockReturnValue(new Promise(() => {}));
    render(<AssetForm />);
    await waitForResolvedAssetLocation(); fillRequiredReportFields(); addTestMedia();
    mocks.reverseGeocode.mockReturnValueOnce(lookup.promise);
    fireEvent.click(screen.getByRole("button", { name: "Re-detect" }));
    fireEvent.change(screen.getByRole("combobox", { name: /Currency/i }), { target: { value: "EUR" } });
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    expect(mocks.enqueue.mock.calls[0][0].details.currency).toBe("EUR");
    await act(async () => { lookup.resolve({ location: "London, United Kingdom", currency: "GBP" }); await lookup.promise; });
    expect(document.getElementById("asset-currency")).toHaveValue("EUR");
  });

  it("requires a currency for an imported unknown location and can infer a later typed address", async () => {
    const auctioneer = makeAuctioneerSetup();
    delete auctioneer.contract.currency;
    render(<AssetForm auctioneer={auctioneer} />);
    const currency = screen.getByRole("combobox", { name: /Currency/i });
    currency.scrollIntoView = vi.fn();
    expect(currency).toHaveValue("");
    expect(mocks.geolocation).not.toHaveBeenCalled();
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    expect(document.getElementById("asset-currency-error")).toHaveTextContent("Choose a currency.");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await waitFor(() => expect(currency.scrollIntoView).toHaveBeenCalled());
    const location = screen.getByLabelText(/^Inspection location/i);
    fireEvent.change(location, { target: { value: "Austin, TX 78701" } });
    fireEvent.blur(location);
    expect(currency).toHaveValue("USD");
  });

  it("infers a currency for a manually entered country until the user overrides it", async () => {
    render(<AssetForm />);
    await waitForResolvedAssetLocation();
    const location = screen.getByLabelText(/^Inspection location/i);
    fireEvent.change(location, { target: { value: "Austin, Texas, United States" } });
    fireEvent.blur(location);
    const currency = screen.getByRole("combobox", { name: /Currency/i });
    expect(currency).toHaveValue("USD");
    fireEvent.change(currency, { target: { value: "GBP" } });
    fireEvent.change(location, { target: { value: "Delhi, India" } });
    fireEvent.blur(location);
    expect(currency).toHaveValue("GBP");
  });

  it("preserves a saved draft currency while naming the old coordinate location", async () => {
    const draft = makeAssetResumeDraft();
    draft.formData = { ...draft.formData, currency: "EUR" };
    mocks.reverseGeocode.mockResolvedValue({ location: "London, United Kingdom", currency: "GBP" });
    render(<AssetForm resumeDraft={draft} />);
    await waitFor(() => expect(screen.getByLabelText(/^Inspection location/i)).toHaveValue("London, United Kingdom"));
    expect(screen.getByRole("combobox", { name: /Currency/i })).toHaveValue("EUR");
  });

  it("makes rapid Save draft then Submit one cancellable draft-save intent", async () => {
    let saveSignal: AbortSignal | undefined;
    mocks.upsertWithMedia.mockImplementation(
      (
        _input: unknown,
        _lots: unknown,
        _onProgress?: DraftProgressCallback,
        signal?: AbortSignal
      ) => {
        saveSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
    );
    render(<AssetForm />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();

    const saveButton = screen.getByRole("button", { name: /Save draft/i });
    const submitButton = screen.getByRole("button", { name: "Create report" });
    act(() => {
      saveButton.click();
      submitButton.click();
    });

    const dialog = await screen.findByRole("dialog", {
      name: "Saving your draft",
    });
    expect(mocks.upsertWithMedia).toHaveBeenCalledOnce();
    expect(mocks.createAsset).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel save" }));
    await waitFor(() => expect(saveSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Saving your draft" })
      ).not.toBeInTheDocument()
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.createAsset).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "Uploading your report" })
    ).not.toBeInTheDocument();
  });

  it("opens the real more-actions menu and wires discard to confirmation", async () => {
    render(<AssetForm />);

    fireEvent.click(
      screen.getByRole("button", { name: "More asset form actions" })
    );

    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Save as reusable input" })
    ).toBeVisible();
    expect(
      within(menu).getByRole("menuitem", {
        name: "Discard draft and clear form",
      })
    ).toBeVisible();

    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "Discard draft and clear form",
      })
    );

    expect(
      await screen.findByRole("alertdialog", {
        name: "Discard this asset draft?",
      })
    ).toBeVisible();
  });

  it("stops a valid report upload without auto-saving or clearing the form", async () => {
    let submitSignal: AbortSignal | undefined;
    mocks.createAsset.mockImplementation(
      (
        _details: unknown,
        _images: File[],
        _videos: File[],
        options?: { signal?: AbortSignal }
      ) => {
        submitSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          submitSignal?.addEventListener(
            "abort",
            () => reject(submitSignal?.reason),
            { once: true }
          );
        });
      }
    );
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();

    fireEvent.click(screen.getByRole("button", { name: "Create report" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Uploading your report",
    });
    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
    expect(mocks.createAsset.mock.calls[0][0].watermark_images).toBe(false);
    expect(dialog).toHaveClass("fixed", "inset-0", "z-[1500]");
    expect(
      within(dialog).getByRole("button", { name: "Stop upload" })
    ).toBeVisible();
    expect(within(dialog).getByText(/keep this page open/i)).toBeVisible();
    const hiddenWorkspace = document
      .getElementById("asset-clientName")
      ?.closest("[inert]");
    expect(hiddenWorkspace).not.toBeNull();
    expect(hiddenWorkspace).toHaveAttribute("inert");
    expect(hiddenWorkspace).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.queryByRole("contentinfo", { name: "Form actions" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create report" })
    ).not.toBeInTheDocument();
    expect(mocks.upsertWithMedia).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stop upload" })
    );

    await waitFor(() => expect(submitSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Uploading your report" })
      ).not.toBeInTheDocument()
    );
    expect(
      document.getElementById("asset-clientName")?.closest("[inert]")
    ).toBeNull();
    expect(mocks.upsertWithMedia).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Workflow Client");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent(
      "asset-photo.jpg"
    );
  });

  it("recovers a changed submission manifest with a new upload identity", async () => {
    const retryUpload = deferred<Record<string, unknown>>();
    let retrySignal: AbortSignal | undefined;
    mocks.createAsset
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: { code: "SUBMISSION_MANIFEST_CHANGED", data: { accepted: false, canSupersede: true } },
        },
      })
      .mockImplementationOnce(
        (
          _details: unknown,
          _images: File[],
          _videos: File[],
          options?: { signal?: AbortSignal }
        ) => {
          retrySignal = options?.signal;
          retrySignal?.addEventListener(
            "abort",
            () => retryUpload.reject(retrySignal?.reason),
            { once: true }
          );
          return retryUpload.promise;
        }
    );
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();

    fireEvent.click(screen.getByRole("button", { name: "Create report" }));

    const recovery = await screen.findByRole("alertdialog", {
      name: "Start a new upload?",
    });
    expect(within(recovery).getByText(/photos changed/i)).toBeVisible();
    const firstDetails = mocks.createAsset.mock.calls[0][0];
    fireEvent.click(
      within(recovery).getByRole("button", { name: "Start new upload" })
    );

    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledTimes(2));
    const secondDetails = mocks.createAsset.mock.calls[1][0];
    expect(secondDetails.force_new).toBe(false);
    expect(secondDetails.supersedes_client_submission_id).toBe(
      firstDetails.client_submission_id
    );
    expect(secondDetails.client_submission_id).not.toBe(
      firstDetails.client_submission_id
    );
    expect(retrySignal).toBeInstanceOf(AbortSignal);

    const retryDialog = await screen.findByRole("dialog", {
      name: "Uploading your report",
    });
    fireEvent.click(
      within(retryDialog).getByRole("button", { name: "Stop upload" })
    );
    await waitFor(() => expect(retrySignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Uploading your report" })
      ).not.toBeInTheDocument()
    );
    expect(screen.getByLabelText(/Client name/i)).toHaveValue("Workflow Client");
    expect(screen.getByTestId("selected-asset-media")).toHaveTextContent(
      "asset-photo.jpg"
    );
  });

  it("carries the rejected upload identity into an explicit force-new replacement", async () => {
    mocks.createAsset
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: { code: "ACTIVE_REPORT_EXISTS" },
        },
      })
      .mockResolvedValueOnce({ message: "Accepted", reportId: "accepted-report", jobId: "accepted-job", status: "processing" });
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();

    fireEvent.click(screen.getByRole("button", { name: "Create report" }));

    const conflict = await screen.findByRole("dialog", {
      name: "Report already processing",
    });
    const firstDetails = mocks.createAsset.mock.calls[0][0];
    fireEvent.click(
      within(conflict).getByRole("button", {
        name: "Create Separate Report",
      })
    );

    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledTimes(2));
    const replacementDetails = mocks.createAsset.mock.calls[1][0];
    expect(replacementDetails.force_new).toBe(true);
    expect(replacementDetails.supersedes_client_submission_id).toBe(
      firstDetails.client_submission_id
    );
    expect(replacementDetails.client_submission_id).not.toBe(
      firstDetails.client_submission_id
    );
  });

  it("removes cancellation after acceptance while final cleanup is pending", async () => {
    const cleanup = deferred<void>();
    mocks.createAsset.mockResolvedValueOnce({ message: "Accepted", reportId: "accepted-report", jobId: "accepted-job", status: "processing" });
    mocks.deleteDraftByClientId.mockReturnValueOnce(cleanup.promise);
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();

    fireEvent.click(screen.getByRole("button", { name: "Create report" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Uploading your report",
    });
    await waitFor(() =>
      expect(
        within(dialog).getAllByText("Report accepted · finalizing…")
      ).not.toHaveLength(0)
    );
    expect(
      within(dialog).queryByRole("button", { name: /stop upload/i })
    ).not.toBeInTheDocument();
    const acceptedSignal = mocks.createAsset.mock.calls[0][3].signal;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(acceptedSignal.aborted).toBe(false);

    cleanup.resolve();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Uploading your report" })
      ).not.toBeInTheDocument()
    );
  });

  it("does not let a stale geolocation response overwrite a manual location", async () => {
    let resolveLocation: PositionCallback | undefined;
    mocks.geolocation.mockImplementation((success: PositionCallback) => {
      resolveLocation = success;
    });
    render(<AssetForm />);
    await waitFor(() => expect(resolveLocation).toBeTypeOf("function"));

    const location = screen.getByLabelText(/Inspection location/i);
    fireEvent.change(location, { target: { value: "Manual warehouse bay" } });
    act(() => {
      resolveLocation?.(position);
    });

    expect(location).toHaveValue("Manual warehouse bay");
    expect(location).toHaveAccessibleDescription(
      "Manually entered inspection location"
    );
    expect(mocks.reverseGeocode).not.toHaveBeenCalled();
  });

  it("aborts and ignores an in-flight reverse lookup after manual entry", async () => {
    const lookup = deferred<{
      location: string;
      attribution: string;
      attributionUrl: string;
    }>();
    mocks.reverseGeocode.mockReturnValueOnce(lookup.promise);
    render(<AssetForm />);

    await waitFor(() => expect(mocks.reverseGeocode).toHaveBeenCalledOnce());
    const lookupSignal = mocks.reverseGeocode.mock.calls[0][1].signal as AbortSignal;
    const location = screen.getByLabelText(/Inspection location/i);
    fireEvent.change(location, { target: { value: "Manual warehouse bay" } });

    expect(lookupSignal.aborted).toBe(true);
    await act(async () => {
      lookup.resolve({
        location: "Stale automatic location",
        attribution: "© OpenStreetMap contributors",
        attributionUrl: OPENSTREETMAP_COPYRIGHT_URL,
      });
      await lookup.promise;
    });

    expect(location).toHaveValue("Manual warehouse bay");
    expect(location).toHaveAccessibleDescription(
      "Manually entered inspection location"
    );
    expect(
      screen.queryByRole("link", { name: "© OpenStreetMap contributors" })
    ).not.toBeInTheDocument();
  });

  it("preserves the prior location when re-detection is denied", async () => {
    let requestCount = 0;
    mocks.geolocation.mockImplementation(
      (
        success: PositionCallback,
        error?: PositionErrorCallback
      ) => {
        requestCount += 1;
        if (requestCount === 1) success(position);
        else error?.({} as GeolocationPositionError);
      }
    );
    render(<AssetForm />);
    const location = await waitForResolvedAssetLocation();
    fireEvent.change(location, { target: { value: "Existing inspection yard" } });

    fireEvent.click(screen.getByRole("button", { name: "Re-detect" }));

    expect(location).toHaveValue("Existing inspection yard");
    expect(location).toHaveAccessibleDescription(
      "Browser location access was denied or is unavailable"
    );
  });

  it("keeps detected coordinates when a re-detection attempt is denied", async () => {
    let requestCount = 0;
    mocks.geolocation.mockImplementation(
      (
        success: PositionCallback,
        error?: PositionErrorCallback
      ) => {
        requestCount += 1;
        if (requestCount === 1) success(position);
        else error?.({} as GeolocationPositionError);
      }
    );
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    const location = await waitForResolvedAssetLocation();

    fireEvent.click(screen.getByRole("button", { name: "Re-detect" }));
    expect(location).toHaveValue(RESOLVED_ASSET_LOCATION);

    fillRequiredReportFields();
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
    expect(mocks.createAsset.mock.calls[0][0]).toMatchObject({
      location: RESOLVED_ASSET_LOCATION,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
  });

  it("preserves the readable name, exact coordinates, and attribution when the provider fails", async () => {
    render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    const location = await waitForResolvedAssetLocation();
    mocks.reverseGeocode.mockRejectedValueOnce(
      new Error("Reverse geocoding unavailable")
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-detect" }));
    await waitFor(() =>
      expect(location).toHaveAccessibleDescription(
        "The location name could not be refreshed. Keeping the previous location. · © OpenStreetMap contributors"
      )
    );
    expect(location).toHaveValue(RESOLVED_ASSET_LOCATION);
    expect(
      screen.getByRole("link", { name: "© OpenStreetMap contributors" })
    ).toHaveAttribute("href", OPENSTREETMAP_COPYRIGHT_URL);

    fillRequiredReportFields();
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(mocks.createAsset).toHaveBeenCalledOnce());
    expect(mocks.createAsset.mock.calls[0][0]).toMatchObject({
      location: RESOLVED_ASSET_LOCATION,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
  });

  it("does not report draft-save success when a newer location revision remains unsaved", async () => {
    const serverSave = deferred<Record<string, unknown>>();
    let resolveLocation: PositionCallback | undefined;
    const onDraftStatusChange = vi.fn();
    mocks.geolocation.mockImplementation((success: PositionCallback) => {
      resolveLocation = success;
    });
    mocks.upsertWithMedia.mockReturnValueOnce(serverSave.promise);
    render(<AssetForm onDraftStatusChange={onDraftStatusChange} />);
    await waitFor(() => expect(resolveLocation).toBeTypeOf("function"));

    fireEvent.click(screen.getByRole("button", { name: /Save draft/i }));
    await waitFor(() => expect(mocks.upsertWithMedia).toHaveBeenCalledOnce());
    act(() => {
      resolveLocation?.(position);
    });
    await waitFor(() =>
      expect(onDraftStatusChange).toHaveBeenCalledWith(
        "dirty",
        "Location updated · save again"
      )
    );
    serverSave.resolve({ _id: "saved-before-location", media: [] });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Saving your draft" })
      ).not.toBeInTheDocument()
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(onDraftStatusChange).toHaveBeenCalledWith(
      "dirty",
      "Location updated · save again"
    );
    expect(
      onDraftStatusChange.mock.calls.some(([status]) => status === "saved")
    ).toBe(false);
  });

  it("keeps a failed restore locked and retries the latest saved snapshot without saving partial data", async () => {
    mocks.restoreLots.mockRejectedValueOnce(new Error("Lot 2, photo 3: missing original"));
    const draft = makeAssetResumeDraft(RESOLVED_ASSET_LOCATION);
    const latest = { ...draft, revision: 5, contractNo: "LATEST-SAVED" };
    mocks.getDraft.mockResolvedValue(latest);
    render(<AssetForm resumeDraft={draft} />);
    const retry = await screen.findByRole("button", { name: "Retry loading draft" });
    expect(screen.getByRole("button", { name: /Save draft/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create report" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Create report" }).closest("form")!);
    expect(mocks.createAsset).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: /Save draft/i })).toBeEnabled());
    expect(mocks.getDraft).toHaveBeenCalledWith(draft._id, expect.any(AbortSignal));
    expect(mocks.restoreLots).toHaveBeenLastCalledWith(latest, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mocks.upsertWithMedia).not.toHaveBeenCalled();
    expect(mocks.deleteDraftByClientId).not.toHaveBeenCalled();
  });

  it("restarts account restoration in StrictMode and ignores late media after unmount", async () => {
    const loading = deferred<MixedLot[]>();
    mocks.restoreLots.mockReturnValue(loading.promise);
    const view = render(<StrictMode><AssetForm resumeDraft={makeAssetResumeDraft(RESOLVED_ASSET_LOCATION)} /></StrictMode>);
    expect(mocks.restoreLots).toHaveBeenCalledTimes(2);
    expect(mocks.restoreLots.mock.calls[0][1].signal.aborted).toBe(true);
    view.unmount();
    expect(mocks.restoreLots.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => loading.resolve([]));
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.upsertWithMedia).not.toHaveBeenCalled();
  });

  it("rejects another owner's draft before reading media", async () => {
    render(<AssetForm resumeDraft={{ ...makeAssetResumeDraft(), user: "other-owner" }} />);
    await screen.findByRole("button", { name: "Retry loading draft" });
    expect(mocks.restoreLots).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Save draft/i })).toBeDisabled();
  });

  it("waits for authentication and cancels restoration when the signed-in account changes", async () => {
    const download = deferred<MixedLot[]>();
    mocks.authUser.mockReturnValue(null);
    mocks.restoreLots.mockReturnValue(download.promise);
    const draft = makeAssetResumeDraft(RESOLVED_ASSET_LOCATION);
    const view = render(<AssetForm resumeDraft={draft} />);
    expect(mocks.restoreLots).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create report" })).toBeDisabled();
    mocks.authUser.mockReturnValue({ _id: draft.user });
    view.rerender(<AssetForm resumeDraft={draft} />);
    await waitFor(() => expect(mocks.restoreLots).toHaveBeenCalledOnce());
    const signal = mocks.restoreLots.mock.calls[0][1].signal;
    mocks.authUser.mockReturnValue({ _id: "another-user" });
    view.rerender(<AssetForm resumeDraft={draft} />);
    expect(signal.aborted).toBe(true);
    await act(async () => download.resolve([]));
    expect(screen.getByRole("button", { name: /Save draft/i })).toBeDisabled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.upsertWithMedia).not.toHaveBeenCalled();
  });

  it("keeps an immediately resolved legacy draft location marked dirty after hydration", async () => {
    const restoredLots = deferred<[]>();
    const onDraftStatusChange = vi.fn();
    mocks.restoreLots.mockReturnValueOnce(restoredLots.promise);

    render(
      <AssetForm
        resumeDraft={makeAssetResumeDraft()}
        onDraftStatusChange={onDraftStatusChange}
      />
    );
    await waitForResolvedAssetLocation();
    restoredLots.resolve([]);

    await waitFor(() => {
      const calls = onDraftStatusChange.mock.calls;
      expect(calls[calls.length - 1]).toEqual([
        "dirty",
        "Location updated · save again",
      ]);
    });
    expect(mocks.geolocation).not.toHaveBeenCalled();
  });

  it("marks a delayed legacy location migration dirty and saves the readable tuple as a new revision", async () => {
    const lookup = deferred<{
      location: string;
      currency: string;
      attribution: string;
      attributionUrl: string;
    }>();
    const onDraftStatusChange = vi.fn();
    mocks.reverseGeocode.mockReturnValueOnce(lookup.promise);
    mocks.upsertWithMedia.mockResolvedValueOnce({
      _id: "saved-migrated-location",
      media: [],
    });

    render(
      <AssetForm
        resumeDraft={makeAssetResumeDraft()}
        onDraftStatusChange={onDraftStatusChange}
      />
    );
    await waitFor(() =>
      expect(onDraftStatusChange).toHaveBeenCalledWith(
        "saved",
        "Draft and photos restored"
      )
    );

    await act(async () => {
      lookup.resolve({
        location: RESOLVED_ASSET_LOCATION,
        currency: "GBP",
        attribution: "© OpenStreetMap contributors",
        attributionUrl: OPENSTREETMAP_COPYRIGHT_URL,
      });
      await lookup.promise;
    });
    await waitForResolvedAssetLocation();
    await waitFor(() => {
      const calls = onDraftStatusChange.mock.calls;
      expect(calls).toContainEqual([
        "dirty",
        "Location updated · save again",
      ]);
      expect(calls[calls.length - 1]?.[0]).toBe("dirty");
    });

    fireEvent.click(screen.getByRole("button", { name: /Save draft/i }));
    await waitFor(() => expect(mocks.upsertWithMedia).toHaveBeenCalledOnce());
    const draftInput = mocks.upsertWithMedia.mock.calls[0][0];
    expect(draftInput.revision).toBeGreaterThan(4);
    expect(draftInput.formData).toMatchObject({
      location: RESOLVED_ASSET_LOCATION,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
  });

  it("keeps a legacy coordinate-only draft blank when its name cannot be resolved", async () => {
    mocks.reverseGeocode.mockRejectedValueOnce(
      new Error("Reverse geocoding unavailable")
    );

    render(<AssetForm resumeDraft={makeAssetResumeDraft()} />);
    const location = screen.getByLabelText(/Inspection location/i);
    await waitFor(() =>
      expect(location).toHaveAccessibleDescription(
        "The browser coordinates could not be named. Re-detect or enter the location manually."
      )
    );
    expect(location).toHaveValue("");
    expect(location).not.toHaveAccessibleDescription(
      /Keeping the previous location/
    );
    expect(mocks.geolocation).not.toHaveBeenCalled();
  });

  it("aborts active draft saves and submissions when the form unmounts", async () => {
    let saveSignal: AbortSignal | undefined;
    mocks.upsertWithMedia.mockImplementation(
      (
        _input: unknown,
        _lots: unknown,
        _onProgress?: DraftProgressCallback,
        signal?: AbortSignal
      ) => {
        saveSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
    );
    const draftView = render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    fireEvent.click(screen.getByRole("button", { name: /Save draft/i }));
    await waitFor(() => expect(saveSignal).toBeInstanceOf(AbortSignal));
    draftView.unmount();
    await waitFor(() => expect(saveSignal?.aborted).toBe(true));

    let submitSignal: AbortSignal | undefined;
    mocks.createAsset.mockImplementation(
      (
        _details: unknown,
        _images: File[],
        _videos: File[],
        options?: { signal?: AbortSignal }
      ) => {
        submitSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          submitSignal?.addEventListener(
            "abort",
            () => reject(submitSignal?.reason),
            { once: true }
          );
        });
      }
    );
    const submissionView = render(<AssetForm resumeLocalDraftScopeId="upload-review:asset-inline" />);
    await waitForResolvedAssetLocation();
    fillRequiredReportFields();
    addTestMedia();
    fireEvent.click(screen.getByRole("button", { name: "Create report" }));
    await waitFor(() => expect(submitSignal).toBeInstanceOf(AbortSignal));
    submissionView.unmount();
    await waitFor(() => expect(submitSignal?.aborted).toBe(true));
  });

  it("requests exact fresh coordinates but displays a readable attributed location", async () => {
    render(<AssetForm />);

    await waitFor(() => expect(mocks.geolocation).toHaveBeenCalled());
    for (const call of mocks.geolocation.mock.calls) {
      expect(call[2]).toEqual({
        enableHighAccuracy: true,
        timeout: 20_000,
        maximumAge: 0,
      });
    }
    const location = await waitForResolvedAssetLocation();
    expect(location).toHaveAccessibleDescription(
      "Accurate to within approximately 7 m · © OpenStreetMap contributors"
    );
    expect(mocks.reverseGeocode).toHaveBeenCalledWith(
      {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      },
      { signal: expect.any(AbortSignal) }
    );
    const attribution = screen.getByRole("link", {
      name: "© OpenStreetMap contributors",
    });
    expect(attribution).toHaveAttribute("href", OPENSTREETMAP_COPYRIGHT_URL);
    expect(attribution).toHaveAttribute("target", "_blank");
    expect(attribution).toHaveAttribute("rel", "noopener noreferrer");
  });
});
