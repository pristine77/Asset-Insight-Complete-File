import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetReport } from "@/services/assets";
import type { LotListing } from "@/services/lotListing";
import PreviewsPage from "./page";

const mocks = vi.hoisted(() => ({
  dynamicIndex: 0,
  getAssetReports: vi.fn(),
  getSubmittedReports: vi.fn(),
  getLotListings: vi.fn(),
  getSubmittedLotListings: vi.fn(),
  getRealEstateReports: vi.fn(),
  getSalvageReports: vi.fn().mockResolvedValue({ data: [] }),
  deleteAssetReport: vi.fn(),
  deleteLotListing: vi.fn(),
  resubmitReport: vi.fn(),
  resubmitLotListing: vi.fn(),
  listDrafts: vi.fn(),
  promoteDraftPreview: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));
vi.mock("@/services/salvage", async (original) => ({
  ...await original<typeof import("@/services/salvage")>(),
  SalvageService: { getReports: mocks.getSalvageReports },
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    const componentIndex = mocks.dynamicIndex++;
    function DeferredDialog({
      isOpen,
      reportId,
      isResubmitMode,
      draftPreviewId,
      onSuccess,
    }: {
      isOpen?: boolean;
      reportId?: string;
      isResubmitMode?: boolean;
      draftPreviewId?: string;
      onSuccess?: (report: unknown) => void;
    }) {
      if (!isOpen) return null;
      if (componentIndex === 1) {
        return (
          <div
            role="dialog"
            aria-label={`Asset preview editor: ${reportId}`}
            data-resubmit={isResubmitMode}
            data-draft-preview-id={draftPreviewId}
          ><button onClick={() => onSuccess?.({ _id: reportId, status: "processing", generation_target_status: "approved" })}>Complete fixture submission</button></div>
        );
      }
      if (componentIndex === 2) {
        return (
          <div
            role="dialog"
            aria-label={`Real Estate preview editor: ${reportId}`}
          />
        );
      }
      if (componentIndex === 3) {
        return (
          <div
            role="dialog"
            aria-label={`Lot Listing preview editor: ${reportId}`}
            data-resubmit={isResubmitMode}
          />
        );
      }
      return null;
    }
    return DeferredDialog;
  },
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/services/assets", () => ({
  getAssetReports: mocks.getAssetReports,
  getSubmittedReports: mocks.getSubmittedReports,
  deleteAssetReport: mocks.deleteAssetReport,
  resubmitReport: mocks.resubmitReport,
}));

vi.mock("@/services/lotListing", () => ({
  getLotListings: mocks.getLotListings,
  getSubmittedLotListings: mocks.getSubmittedLotListings,
  deleteLotListing: mocks.deleteLotListing,
  resubmitLotListing: mocks.resubmitLotListing,
}));

vi.mock("@/services/realEstate", () => ({
  RealEstateService: {
    getReports: mocks.getRealEstateReports,
    deleteReport: vi.fn(),
  },
}));

vi.mock("@/services/reportDrafts", () => ({
  ReportDraftService: {
    list: mocks.listDrafts,
    promotePreview: mocks.promoteDraftPreview,
    processPreview: vi.fn(),
  },
  draftKindForRecord: (draft: { type: string }) =>
    draft.type === "lotListing" ? "lot-listing" : "asset",
}));

const assetPreview: AssetReport = {
  _id: "asset-preview-action",
  user: "user-1",
  grouping_mode: "lot",
  imageUrls: [],
  status: "processing",
  workflow_stage: "preview_ready",
  generation_state: "queued",
  job_status: "processing",
  files_generating: false,
  lots: [{ lot_number: "1" }],
  client_name: "Asset Preview Client",
  contract_no: "CV-ASSET-ACTION",
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:30:00.000Z",
};

const lotListingPreview: LotListing = {
  _id: "lot-preview-action",
  user: "user-1",
  status: "processing",
  workflow_stage: "preview_ready",
  generation_state: "processing",
  job_status: "queued",
  files_generating: false,
  details: {
    contract_no: "CV-LOT-ACTION",
    currency: "GBP",
  },
  lots: [
    {
      lot_id: "lot-1",
      lot_number: "1",
      image_indexes: [],
    },
  ],
  imageUrls: [],
  createdAt: "2026-08-03T09:00:00.000Z",
  updatedAt: "2026-08-03T09:30:00.000Z",
};

describe("Preview queue affordances", () => {
  it.each(["asset", "lotListing"] as const)("opens a failed unsubmitted %s from its deep link without generating files", async (kind) => {
    const source = kind === "asset" ? assetPreview : lotListingPreview;
    const failed = { ...source, status: "error", workflow_stage: "error", job_status: "error", generation_state: "error",
      preview_data: { lots: [{ lot_number: "5507", title: "Saved report lot" }] } };
    (kind === "asset" ? mocks.getAssetReports : mocks.getLotListings).mockResolvedValue({ data: [failed] });
    window.history.replaceState({}, "", `/previews?reportId=${source._id}&reportType=${kind}`);
    render(<PreviewsPage />);
    expect(await screen.findByRole("dialog", { name: `${kind === "asset" ? "Asset" : "Lot Listing"} preview editor: ${source._id}` })).toHaveAttribute("data-resubmit", "false");
    expect(screen.getByText(/Your saved preview is available/)).toBeVisible();
    expect(mocks.resubmitReport).not.toHaveBeenCalled();
    expect(mocks.resubmitLotListing).not.toHaveBeenCalled();
  });

  it("offers draft recovery, not an empty preview or file retry, when no saved lots exist", async () => {
    mocks.getAssetReports.mockResolvedValue({ data: [] });
    mocks.getLotListings.mockResolvedValue({ data: [{ ...lotListingPreview, status: "error", workflow_stage: "error", lots: [], preview_data: {} }] });
    render(<PreviewsPage />);
    expect(await screen.findByRole("link", { name: "Open saved drafts" })).toHaveAttribute("href", "/drafts");
    expect(screen.queryByRole("button", { name: /^Preview Lot Listing report/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry generation" })).not.toBeInTheDocument();
  });

  beforeEach(() => {
    mocks.getSalvageReports.mockReset().mockResolvedValue({ data: [] });
    mocks.getAssetReports.mockReset().mockResolvedValue({
      data: [assetPreview],
    });
    mocks.getSubmittedReports.mockReset().mockResolvedValue({ data: [] });
    mocks.getLotListings.mockReset().mockResolvedValue({
      data: [lotListingPreview],
    });
    mocks.getSubmittedLotListings.mockReset().mockResolvedValue({ data: [] });
    mocks.getRealEstateReports.mockReset().mockResolvedValue({ data: [] });
    mocks.listDrafts.mockReset().mockResolvedValue([]);
    mocks.promoteDraftPreview.mockReset().mockResolvedValue({
      reportId: "promoted-report",
      reportType: "asset",
      status: "preview",
    });
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("keeps successful report types visible and exposes a server failure instead of a false empty queue", async () => {
    mocks.getAssetReports.mockRejectedValue({ response: { status: 503 } });
    render(<PreviewsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Asset: The server could not load");
    expect(screen.getByRole("button", { name: /Preview Lot Listing report/ })).toBeVisible();
    expect(screen.queryByText("No new previews")).not.toBeInTheDocument();
    expect(mocks.getSubmittedReports).not.toHaveBeenCalled();
    expect(mocks.getSubmittedLotListings).not.toHaveBeenCalled();
    mocks.getAssetReports.mockResolvedValue({ data: [assetPreview] });
    fireEvent.click(screen.getByRole("button", { name: "Retry loading previews" }));
    expect(await screen.findByRole("button", { name: /Preview Asset report/ })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("retains a previously loaded list after timeout and does not label it deleted or empty", async () => {
    render(<PreviewsPage />);
    await screen.findByRole("button", { name: /Preview Lot Listing report/ });
    mocks.getLotListings.mockRejectedValue({ code: "ECONNABORTED" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("request timed out");
    expect(screen.getByRole("button", { name: /Preview Lot Listing report/ })).toBeVisible();
  });

  it("keeps five simultaneous processing uploads visible in New and their accepted successors in Submitted", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ ...lotListingPreview, _id: `new-${index}`, files_generating: true, workflow_stage: "preparing_preview" }));
    mocks.getAssetReports.mockResolvedValue({ data: [] });
    mocks.getLotListings.mockResolvedValue({ data: rows });
    render(<PreviewsPage />);
    expect(await screen.findByRole("tab", { name: "New (5)" })).toBeVisible();
    mocks.getLotListings.mockResolvedValue({ data: rows.map(row => ({ ...row, generation_target_status: "approved", workflow_stage: "generating_files" })) });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "View submitted previews (5)" }));
    expect(screen.getByRole("tab", { name: "Submitted (5)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText(/Generating files/).length).toBeGreaterThanOrEqual(5);
  });

  it.each([{ message: "incomplete" }, { data: [null] }])("reports malformed list responses and preserves the previous list: %j", async (response) => {
    render(<PreviewsPage />);
    await screen.findByRole("button", { name: /Preview Asset report/ });
    mocks.getAssetReports.mockResolvedValue(response);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read");
    expect(screen.getByRole("button", { name: /Preview Asset report/ })).toBeVisible();
  });

  it("discards a poll started before submission and reloads the accepted report into Submitted", async () => {
    render(<PreviewsPage />);
    await screen.findByRole("button", { name: /Preview Asset report/ });
    let finishOld!: (value: any) => void;
    mocks.getAssetReports.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: /Preview Asset report/ }));
    mocks.getAssetReports.mockResolvedValue({ data: [{ ...assetPreview, preview_submitted_at: "2026-10-02T12:00:00Z", generation_target_status: "approved" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Complete fixture submission" }));
    finishOld({ data: [assetPreview] });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Submitted (1)" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(mocks.getAssetReports).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("tab", { name: "New (1)" })).toBeVisible();
  });

  it("keeps an Asset preview action visible and opens the exact lazy editor", async () => {
    render(<PreviewsPage />);

    const action = await screen.findByRole("button", {
      name: "Preview Asset report: Asset Preview Client",
    });
    expect(action).toBeVisible();
    fireEvent.click(action);

    expect(
      screen.getByRole("dialog", {
        name: "Asset preview editor: asset-preview-action",
      })
    ).toHaveAttribute("data-resubmit", "false");
    expect(
      screen.queryByRole("dialog", {
        name: /Lot Listing preview editor/,
      })
    ).not.toBeInTheDocument();
  });

  it("keeps a Lot Listing preview action visible and opens the exact lazy editor", async () => {
    render(<PreviewsPage />);

    const action = await screen.findByRole("button", {
      name: "Preview Lot Listing report: CV-LOT-ACTION",
    });
    expect(action).toBeVisible();
    fireEvent.click(action);

    expect(
      screen.getByRole("dialog", {
        name: "Lot Listing preview editor: lot-preview-action",
      })
    ).toHaveAttribute("data-resubmit", "false");
    expect(
      screen.queryByRole("dialog", {
        name: /Asset preview editor/,
      })
    ).not.toBeInTheDocument();
  });

  it("opens the exact Lot Listing editor from a preview deep link", async () => {
    window.history.replaceState(
      {},
      "",
      "/previews?reportId=lot-preview-action&reportType=lotListing"
    );

    render(<PreviewsPage />);

    expect(
      await screen.findByRole("dialog", {
        name: "Lot Listing preview editor: lot-preview-action",
      })
    ).toHaveAttribute("data-resubmit", "false");
    expect(
      screen.queryByRole("dialog", {
        name: /Asset preview editor/,
      })
    ).not.toBeInTheDocument();
  });

  it("opens Draft Previews from the duplicate recovery deep link", async () => {
    window.history.replaceState({}, "", "/previews?tab=drafts");

    render(<PreviewsPage />);

    expect(
      await screen.findByRole("tab", { name: /Draft Previews/i })
    ).toHaveAttribute("aria-selected", "true");
  });

  it("moves a current ready Asset draft preview into the main preview queue", async () => {
    mocks.listDrafts.mockResolvedValue([
      {
        _id: "draft-1",
        user: "user-1",
        clientDraftId: "client-draft-1",
        type: "asset",
        storageMode: "r2_media",
        revision: 4,
        contractNo: "CV-DRAFT-1",
        title: "Draft asset report",
        formData: {},
        lots: [{ lot_number: "1" }],
        media: [],
        previewStatus: "ready",
        previewReportId: "hidden-report-1",
        previewProcessedRevision: 4,
        createdAt: "2026-08-03T08:00:00.000Z",
        updatedAt: "2026-08-03T08:30:00.000Z",
      },
    ]);

    render(<PreviewsPage />);

    fireEvent.click(await screen.findByRole("tab", { name: /Draft Previews/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Move to previews" })
    );

    await waitFor(() =>
      expect(mocks.promoteDraftPreview).toHaveBeenCalledWith("draft-1", {
        submit: false,
      })
    );
    expect(screen.getByRole("tab", { name: /^New /i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("opens a ready Asset draft with its draft promotion identity", async () => {
    mocks.listDrafts.mockResolvedValue([
      {
        _id: "draft-editor-1",
        user: "user-1",
        clientDraftId: "client-draft-editor-1",
        type: "asset",
        storageMode: "r2_media",
        revision: 1,
        contractNo: "CV-DRAFT-EDITOR",
        formData: {},
        lots: [{ lot_number: "1" }],
        media: [],
        previewStatus: "ready",
        previewReportId: "hidden-editor-report",
        previewProcessedRevision: 1,
        createdAt: "2026-08-03T08:00:00.000Z",
        updatedAt: "2026-08-03T08:30:00.000Z",
      },
    ]);

    render(<PreviewsPage />);

    fireEvent.click(await screen.findByRole("tab", { name: /Draft Previews/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Open preview" }));

    expect(
      screen.getByRole("dialog", {
        name: "Asset preview editor: hidden-editor-report",
      })
    ).toHaveAttribute("data-draft-preview-id", "draft-editor-1");
  });

  it("offers the same move action for a ready Lot Listing draft", async () => {
    mocks.listDrafts.mockResolvedValue([
      {
        _id: "lot-draft-1",
        user: "user-1",
        clientDraftId: "client-lot-draft-1",
        type: "lotListing",
        storageMode: "r2_media",
        revision: 2,
        contractNo: "LOT-DRAFT-1",
        formData: {},
        lots: [{ lot_number: "1" }],
        media: [],
        previewStatus: "ready",
        previewReportId: "hidden-lot-report-1",
        previewProcessedRevision: 2,
        createdAt: "2026-08-03T08:00:00.000Z",
        updatedAt: "2026-08-03T08:30:00.000Z",
      },
    ]);
    mocks.promoteDraftPreview.mockResolvedValue({
      reportId: "lot-report-1",
      reportType: "lotListing",
      status: "preview",
    });

    render(<PreviewsPage />);

    fireEvent.click(await screen.findByRole("tab", { name: /Draft Previews/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to previews" }));

    await waitFor(() =>
      expect(mocks.promoteDraftPreview).toHaveBeenCalledWith("lot-draft-1", {
        submit: false,
      })
    );
  });
});
