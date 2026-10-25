import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetReport } from "@/services/assets";
import type { LotListing } from "@/services/lotListing";
import { toast } from "@/components/ui/toast";
import { advanceAuthSession } from "@/lib/auth-storage";
import ReportsPage from "./page";

const mocks = vi.hoisted(() => ({
  getMyReports: vi.fn(),
  getAssetReports: vi.fn(),
  getRealEstateReports: vi.fn(),
  getSalvageReports: vi.fn(),
  getLotListings: vi.fn(),
  getDeliveries: vi.fn(),
  closeContractPart: vi.fn(),
  deleteReport: vi.fn(),
  downloadReport: vi.fn(),
  downloadCr: vi.fn(),
  downloadCrDocx: vi.fn(),
  deleteAssetReport: vi.fn(),
  resubmitReport: vi.fn(),
  deleteLotListing: vi.fn(),
  resubmitLotListing: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
  }),
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    function DeferredDialog() {
      return null;
    }
    return DeferredDialog;
  },
}));

vi.mock("@/context/AuthContext", () => ({
  useAuthContext: () => ({
    user: {
      _id: "user-1",
      proposalValuationEnabled: true,
    },
  }),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/services/reports", () => ({
  ReportsService: {
    getMyReports: mocks.getMyReports,
    deleteReport: mocks.deleteReport,
    downloadReport: mocks.downloadReport,
    downloadCr: mocks.downloadCr,
    downloadCrDocx: mocks.downloadCrDocx,
  },
}));

vi.mock("@/services/assets", () => ({
  getAssetReports: mocks.getAssetReports,
  deleteAssetReport: mocks.deleteAssetReport,
  resubmitReport: mocks.resubmitReport,
}));

vi.mock("@/services/realEstate", () => ({
  RealEstateService: {
    getReports: mocks.getRealEstateReports,
    deleteReport: vi.fn(),
  },
}));
vi.mock("@/services/salvage", async (original) => ({
  ...await original<typeof import("@/services/salvage")>(),
  SalvageService: { getReports: mocks.getSalvageReports },
}));

vi.mock("@/services/lotListing", () => ({
  getLotListings: mocks.getLotListings,
  deleteLotListing: mocks.deleteLotListing,
  resubmitLotListing: mocks.resubmitLotListing,
}));

vi.mock("@/services/auctioneer", () => ({
  default: {
    getDeliveries: mocks.getDeliveries,
    closeContractPart: mocks.closeContractPart,
  },
}));

const thumbnailUrl =
  "https://cdn.example.test/reports/cv-thumb-100.webp";

const reportWithThumbnail: AssetReport = {
  _id: "asset-thumbnail",
  user: "user-1",
  grouping_mode: "lot",
  imageUrls: [],
  status: "approved",
  lots: [
    {
      lot_number: "7",
      image_urls: [thumbnailUrl],
      estimated_value: "25000",
    },
  ],
  client_name: "Northfield Plant Ltd",
  contract_no: "CV-THUMB-100",
  preview_files: {
    pdf: "/files/cv-thumb-100.pdf",
    spec_pdf: "/files/cv-thumb-100-cr.pdf",
    cr_docx: "/files/cv-thumb-100-cr.docx",
    docx: "/files/cv-thumb-100.docx",
    excel: "/files/cv-thumb-100.xlsx",
    images: "/files/cv-thumb-100.zip",
  },
  createdAt: "2026-08-02T09:00:00.000Z",
  updatedAt: "2026-08-02T09:30:00.000Z",
};

const reportWithoutThumbnail: AssetReport = {
  ...reportWithThumbnail,
  _id: "asset-no-thumbnail",
  imageUrls: [],
  lots: [{ lot_number: "8", estimated_value: "9000" }],
  client_name: "No Image Client",
  contract_no: "CV-NO-IMAGE",
  preview_files: {
    pdf: "/files/cv-no-image.pdf",
  },
};

const previewReadyAsset: AssetReport = {
  ...reportWithThumbnail,
  _id: "asset-preview-ready",
  status: "processing",
  workflow_stage: "preview_ready",
  generation_state: "queued",
  files_generating: false,
  client_name: "Preview Asset Client",
  contract_no: "CV-ASSET-PREVIEW",
  preview_files: undefined,
};

const previewReadyLotListing: LotListing = {
  _id: "lot-preview-ready",
  user: "user-1",
  status: "processing",
  workflow_stage: "preview_ready",
  generation_state: "processing",
  files_generating: false,
  details: {
    contract_no: "CV-LOT-PREVIEW",
    currency: "GBP",
  },
  lots: [
    {
      lot_id: "lot-1",
      lot_number: "1",
      image_indexes: [],
      estimated_value: "18000",
    },
  ],
  imageUrls: [],
  createdAt: "2026-08-02T10:00:00.000Z",
  updatedAt: "2026-08-02T10:30:00.000Z",
};

class ImmediatelyIntersectingObserver {
  readonly root = null;
  readonly rootMargin = "320px 0px";
  readonly thresholds = [0.01];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe = (target: Element) => {
    this.callback(
      [
        {
          isIntersecting: true,
          target,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver
    );
  };

  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

describe("My Reports thumbnails", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    mocks.getMyReports.mockReset().mockResolvedValue([]);
    mocks.getAssetReports
      .mockReset()
      .mockResolvedValue({
        message: "ok",
        data: [reportWithThumbnail, reportWithoutThumbnail],
      });
    mocks.getRealEstateReports.mockReset().mockResolvedValue({ data: [] });
    mocks.getSalvageReports.mockReset().mockResolvedValue({ data: [] });
    mocks.getLotListings.mockReset().mockResolvedValue({ data: [] });
    mocks.getDeliveries.mockReset().mockResolvedValue([]);
    mocks.closeContractPart.mockReset();
    mocks.downloadReport.mockReset();
    mocks.downloadCr.mockReset();
    mocks.downloadCrDocx.mockReset();
    mocks.routerPush.mockReset();
    mocks.resubmitLotListing.mockReset().mockResolvedValue({});
    vi.stubGlobal("IntersectionObserver", ImmediatelyIntersectingObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["approved", "error", "preview"] as const)("shows a failed Lot Listing's actual error despite old files and status %s", async (status) => {
    mocks.getAssetReports.mockResolvedValue({ data: [] });
    mocks.getLotListings.mockResolvedValue({ data: [{
      ...previewReadyLotListing, status,
      workflow_stage: "error", generation_state: "error", downloadable: false,
      job_error: "Photo archive could not be generated",
      preview_files: { excel: "/old.xlsx", images: "/old.zip" },
    }] });
    render(<ReportsPage />);
    const table = await screen.findByRole("table", { name: "Generated reports" });
    const row = within(table).getByRole("row", { name: /CV-LOT-PREVIEW/ });
    expect(within(row).getByText("Photo archive could not be generated")).toBeInTheDocument();
    expect(screen.queryByText("Files available after release")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Preview Lot Listing report/ })).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getByText("Photo archive could not be generated")).toBeInTheDocument();

    let finishRetry!: () => void;
    mocks.resubmitLotListing.mockReturnValueOnce(new Promise<void>((resolve) => { finishRetry = resolve; }));
    const retry = within(row).getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(mocks.resubmitLotListing).toHaveBeenCalledTimes(1);
    expect(mocks.resubmitLotListing).toHaveBeenCalledWith("lot-preview-ready");
    expect(retry).toBeDisabled();
    mocks.getLotListings.mockResolvedValue({ data: [{
      ...previewReadyLotListing, workflow_stage: "generating_files", downloadable: false,
      workflow_message: "Generating updated files", files_generating: true,
    }] });
    finishRetry();
    await waitFor(() => expect(within(row).getByText("Generating updated files")).toBeInTheDocument());
    expect(within(row).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("keeps Asset release gates while explaining automatic Lot Listing release", async () => {
    mocks.getAssetReports.mockResolvedValue({ data: [{
      ...reportWithThumbnail, workflow_stage: "awaiting_release", downloadable: false,
    }] });
    mocks.getLotListings.mockResolvedValue({ data: [{
      ...previewReadyLotListing, status: "approved", workflow_stage: "awaiting_release",
      generation_state: "ready", downloadable: false,
      preview_files: { excel: "/old.xlsx", images: "/old.zip" },
    }] });
    render(<ReportsPage />);
    const table = await screen.findByRole("table", { name: "Generated reports" });
    const asset = within(table).getByRole("row", { name: /CV-THUMB-100/ });
    const lot = within(table).getByRole("row", { name: /CV-LOT-PREVIEW/ });
    expect(within(asset).getByText("Approved; awaiting release")).toBeInTheDocument();
    expect(within(lot).getByText(/Lot Listings release automatically/)).toBeInTheDocument();
    expect(within(lot).queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("describes an initial-processing retry without claiming files were queued", async () => {
    mocks.getAssetReports.mockResolvedValue({ data: [{
      ...reportWithThumbnail, status: "error", job_status: "error",
      workflow_stage: "error", downloadable: false, preview_available: false,
      job_error: "The imported contract needs an auction event before automatic lot numbers can be assigned. Ask the auction team to check its event.",
    }] });
    mocks.resubmitReport.mockReset().mockResolvedValue({ retry_stage: "initial_preview" });
    vi.mocked(toast.success).mockClear();
    render(<ReportsPage />);
    const table = await screen.findByRole("table", { name: "Generated reports" });
    const row = within(table).getByRole("row", { name: /CV-THUMB-100/ });
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Report processing queued again."));
    expect(mocks.resubmitReport).toHaveBeenCalledWith(reportWithThumbnail._id);
    expect(toast.success).not.toHaveBeenCalledWith("File generation queued again.");
  });

  it("shows legacy error_message when no canonical workflow state is available", async () => {
    mocks.getAssetReports.mockResolvedValue({ data: [] });
    mocks.getLotListings.mockResolvedValue({ data: [{
      ...previewReadyLotListing, status: "error", workflow_stage: undefined, generation_state: undefined,
      error_message: "Unable to publish report files", downloadable: false,
    }] });
    render(<ReportsPage />);
    const table = await screen.findByRole("table", { name: "Generated reports" });
    const row = within(table).getByRole("row", { name: /CV-LOT-PREVIEW/ });
    expect(within(row).getByText("Failed")).toBeInTheDocument();
    expect(within(row).getByText("Unable to publish report files")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("wires a source thumbnail into both responsive report presentations", async () => {
    render(<ReportsPage />);

    expect(
      await screen.findByRole("heading", { name: "My reports" })
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.getAssetReports).toHaveBeenCalledTimes(1));

    const accessibleName =
      /Preview image for Asset Report CV-THUMB-100 — Northfield Plant Ltd/i;
    const mobileList = screen.getByRole("list");
    const desktopTable = screen.getByRole("table", {
      name: "Generated reports",
    });

    expect(
      await within(mobileList).findByRole("img", { name: accessibleName })
    ).toBeInTheDocument();
    expect(
      await within(desktopTable).findByRole("img", {
        name: accessibleName,
      })
    ).toBeInTheDocument();
  });

  it("keeps every rendered thumbnail lazy, asynchronously decoded, and low priority", async () => {
    render(<ReportsPage />);

    const thumbnails = await screen.findAllByRole("img", {
      name: /Preview image for Asset Report CV-THUMB-100 — Northfield Plant Ltd/i,
    });

    expect(thumbnails.length).toBeGreaterThan(0);
    for (const thumbnail of thumbnails) {
      expect(thumbnail).toHaveAttribute("src", thumbnailUrl);
      expect(thumbnail).toHaveAttribute("loading", "lazy");
      expect(thumbnail).toHaveAttribute("decoding", "async");
      expect(thumbnail).toHaveAttribute("fetchpriority", "low");
    }
  });

  it("uses a non-network placeholder when a report has no image source", async () => {
    render(<ReportsPage />);

    expect(
      (
        await screen.findAllByLabelText(
          /No preview image available for Asset Report CV-NO-IMAGE — No Image Client/i
        )
      ).length
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole("img", {
        name: /Preview image for Asset Report CV-NO-IMAGE — No Image Client/i,
      })
    ).not.toBeInTheDocument();
  });

  it("exposes the responsive filter disclosure without hiding the desktop controls", async () => {
    render(<ReportsPage />);

    await screen.findByRole("heading", { name: "My reports" });
    const filterToggle = screen.getByRole("button", { name: /filters/i });
    expect(filterToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("searchbox", { name: "Search reports" })).toBeInTheDocument();

    fireEvent.click(filterToggle);
    expect(filterToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("offers direct, report-specific preview actions for Asset and Lot Listing", async () => {
    mocks.getAssetReports.mockResolvedValue({
      message: "ok",
      data: [previewReadyAsset],
    });
    mocks.getLotListings.mockResolvedValue({
      data: [previewReadyLotListing],
    });
    render(<ReportsPage />);

    const assetActions = await screen.findAllByRole("button", {
      name: "Preview Asset report: Asset · CV-ASSET-PREVIEW",
    });
    const lotActions = await screen.findAllByRole("button", {
      name: "Preview Lot Listing report: Lot Listing · CV-LOT-PREVIEW",
    });
    expect(assetActions.length).toBeGreaterThan(0);
    expect(lotActions.length).toBeGreaterThan(0);

    fireEvent.click(assetActions[0]);
    expect(mocks.routerPush).toHaveBeenLastCalledWith(
      "/previews?reportId=asset-preview-ready&reportType=asset"
    );

    fireEvent.click(lotActions[0]);
    expect(mocks.routerPush).toHaveBeenLastCalledWith(
      "/previews?reportId=lot-preview-ready&reportType=lotListing"
    );
  });

  it("opens Proposal Valuation in its dedicated full-page route", async () => {
    render(<ReportsPage />);

    const actions = await screen.findAllByRole("button", {
      name: /Open Proposal Valuation for Asset .* CV-THUMB-100/i,
    });
    fireEvent.click(actions[0]);

    expect(mocks.routerPush).toHaveBeenLastCalledWith(
      "/proposal-valuations/asset-thumbnail"
    );
  });

  it("keeps report files aligned and exposes every row action without an overflow menu", async () => {
    mocks.getDeliveries.mockResolvedValue([
      {
        workItemId: "delivery-work-item",
        reportId: reportWithThumbnail._id,
        reportModel: "AssetReport",
        reportType: "asset",
        contractNo: reportWithThumbnail.contract_no,
        state: "ready",
        canSend: true,
      },
    ]);
    render(<ReportsPage />);

    const desktopTable = await screen.findByRole("table", {
      name: "Generated reports",
    });
    const reportRow = within(desktopTable).getByRole("row", {
      name: /CV-THUMB-100/i,
    });
    const fileGroup = within(reportRow).getByRole("group", {
      name: "Available files for CV-THUMB-100",
    });
    const actionGroup = within(reportRow).getByRole("group", {
      name: /Actions for Asset .* CV-THUMB-100/i,
    });

    for (const label of [
      "Schedule A",
      "CR PDF",
      "CR DOCX",
      "Appraisal report",
      "XLSX",
      "ZIP",
    ]) {
      expect(
        within(fileGroup).getByRole("button", {
          name: `Download ${label}`,
        })
      ).toBeInTheDocument();
    }
    expect(
      within(actionGroup).getByRole("button", {
        name: /Preview Asset report/i,
      })
    ).toBeInTheDocument();
    expect(
      within(actionGroup).getByRole("button", {
        name: /Merge reports for Asset .* CV-THUMB-100/i,
      })
    ).toBeInTheDocument();
    expect(
      within(actionGroup).getByRole("button", {
        name: /Send for Asset .* CV-THUMB-100/i,
      })
    ).toBeInTheDocument();
    expect(
      within(actionGroup).getByRole("button", {
        name: /Delete report Asset .* CV-THUMB-100/i,
      })
    ).toBeInTheDocument();
    expect(
      within(reportRow).queryByRole("button", { name: /More actions/i })
    ).not.toBeInTheDocument();
  });

  it("downloads canonical Asset CR files without calling legacy report routes", async () => {
    const clickAnchor = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<ReportsPage />);

    const table = await screen.findByRole("table", { name: "Generated reports" });
    const row = within(table).getByRole("row", { name: /CV-THUMB-100/i });
    const fileGroup = within(row).getByRole("group", {
      name: "Available files for CV-THUMB-100",
    });
    fireEvent.click(
      within(fileGroup).getByRole("button", { name: "Download CR PDF" })
    );
    fireEvent.click(
      within(fileGroup).getByRole("button", { name: "Download CR DOCX" })
    );

    expect(clickAnchor).toHaveBeenCalledTimes(2);
    expect(mocks.downloadCr).not.toHaveBeenCalled();
    expect(mocks.downloadCrDocx).not.toHaveBeenCalled();
  });

  it("uses every canonical artifact URL from a structured Asset aggregate", async () => {
    const clickAnchor = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    mocks.getAssetReports.mockResolvedValue({ message: "ok", data: [] });
    mocks.getMyReports.mockResolvedValue([
      {
        _id: "promoted-asset-report",
        filename: "Promoted Asset.docx",
        address: "Promoted Asset",
        fairMarketValue: "CAD 10,000",
        createdAt: "2026-08-04T09:00:00.000Z",
        type: "Asset",
        approvalStatus: "approved",
        downloadable: true,
        preview_files: {
          pdf: "https://cdn.example.test/promoted.pdf",
          spec_pdf: "https://cdn.example.test/promoted-cr.pdf",
          cr_docx: "https://cdn.example.test/promoted-cr.docx",
          docx: "https://cdn.example.test/promoted.docx",
          excel: "https://cdn.example.test/promoted.xlsx",
          images: "https://cdn.example.test/promoted.zip",
        },
      },
    ]);

    render(<ReportsPage />);

    const table = await screen.findByRole("table", { name: "Generated reports" });
    const row = within(table).getByRole("row", { name: /Promoted Asset/i });
    const fileGroup = within(row).getByRole("group", {
      name: "Available files for Promoted Asset",
    });
    for (const label of [
      "Schedule A",
      "CR PDF",
      "CR DOCX",
      "Appraisal report",
      "XLSX",
      "ZIP",
    ]) {
      expect(
        within(fileGroup).getByRole("button", { name: `Download ${label}` })
      ).toBeInTheDocument();
    }

    fireEvent.click(
      within(fileGroup).getByRole("button", {
        name: "Download Appraisal report",
      })
    );
    expect(clickAnchor).toHaveBeenCalledTimes(1);
    expect(mocks.downloadReport).not.toHaveBeenCalled();
  });

  it("does not invent a legacy Appraisal download for a URL-less aggregate", async () => {
    mocks.getAssetReports.mockResolvedValue({ message: "ok", data: [] });
    mocks.getMyReports.mockResolvedValue([
      {
        _id: "hidden-aggregate-without-files",
        filename: "Hidden Draft.docx",
        address: "Hidden Draft",
        fairMarketValue: "CAD 0.00",
        createdAt: "2026-08-04T09:00:00.000Z",
        type: "Asset",
        approvalStatus: "approved",
        downloadable: true,
        preview_files: {},
      },
    ]);

    render(<ReportsPage />);

    await screen.findByRole("table", { name: "Generated reports" });
    expect(
      screen.queryByRole("button", { name: "Download Appraisal report" })
    ).not.toBeInTheDocument();
  });

  it("shows the generated Schedule A for a Lot Listing", async () => {
    mocks.getAssetReports.mockResolvedValue({ message: "ok", data: [] });
    mocks.getLotListings.mockResolvedValue({
      data: [
        {
          ...previewReadyLotListing,
          _id: "lot-with-schedule-a",
          status: "approved",
          details: { contract_no: "LOT-SCHEDULE-A", currency: "CAD" },
          preview_files: {
            schedule_a_pdf: "https://cdn.example.test/lot-schedule-a.pdf",
            excel: "https://cdn.example.test/lot.xlsx",
            images: "https://cdn.example.test/lot.zip",
          },
        },
      ],
    });

    render(<ReportsPage />);

    const table = await screen.findByRole("table", { name: "Generated reports" });
    const row = within(table).getByRole("row", { name: /LOT-SCHEDULE-A/i });
    expect(
      within(row).getByRole("button", { name: "Download Schedule A" })
    ).toBeInTheDocument();
  });

  it("downloads canonical Lot Listing CR files without calling legacy report routes", async () => {
    const clickAnchor = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    mocks.getAssetReports.mockResolvedValue({ message: "ok", data: [] });
    mocks.getLotListings.mockResolvedValue({
      data: [
        {
          ...previewReadyLotListing,
          _id: "lot-canonical-cr",
          status: "approved",
          generation_state: "ready",
          files_generating: false,
          details: { contract_no: "LOT-CANONICAL-CR", currency: "CAD" },
          preview_files: {
            spec_pdf: "https://cdn.example.test/lot-cr.pdf",
            cr_docx: "https://cdn.example.test/lot-cr.docx",
          },
        },
      ],
    });

    render(<ReportsPage />);

    const table = await screen.findByRole("table", { name: "Generated reports" });
    const row = within(table).getByRole("row", { name: /LOT-CANONICAL-CR/i });
    const fileGroup = within(row).getByRole("group", {
      name: "Available files for LOT-CANONICAL-CR",
    });
    fireEvent.click(
      within(fileGroup).getByRole("button", { name: "Download CR PDF" })
    );
    fireEvent.click(
      within(fileGroup).getByRole("button", { name: "Download CR DOCX" })
    );

    expect(clickAnchor).toHaveBeenCalledTimes(2);
    expect(mocks.downloadCr).not.toHaveBeenCalled();
    expect(mocks.downloadCrDocx).not.toHaveBeenCalled();
  });

  /*
     ── THE OUTSTANDING / COMPLETED TABS ──────────────────────────────────────────────────────────
     OWNER, 2026-09-29: "Add Outstanding and Completed Tab here too. Any
     task sent to Auctioneer 2.0 goes to Completed." The same words the Incoming
     queue uses, so the two screens describe one idea in one vocabulary.

     A report that has reached Auctioneer needs nothing further, but it stayed
     in the list competing with the rows that still need a Send or a Retry —
     and the list sorts newest-first, so the two were interleaved.

     What counts as sent is delivery.state === "sent", the same value the green
     "Sent" badge already renders from. Nothing new decides it, so the badge and
     the tab cannot disagree.
  */
  async function renderWithTwoDeliveries() {
    mocks.getAssetReports.mockResolvedValue({
      data: [reportWithThumbnail, reportWithoutThumbnail],
    });
    mocks.getDeliveries.mockResolvedValue([
      {
        workItemId: "wi-sent",
        reportId: reportWithThumbnail._id,
        reportModel: "AssetReport",
        reportType: "asset",
        contractNo: reportWithThumbnail.contract_no,
        state: "sent",
        canSend: false,
      },
      {
        workItemId: "wi-ready",
        reportId: reportWithoutThumbnail._id,
        reportModel: "AssetReport",
        reportType: "asset",
        contractNo: reportWithoutThumbnail.contract_no,
        state: "ready",
        canSend: true,
      },
    ]);
    render(<ReportsPage />);
    return screen.findByRole("tablist", { name: "Queue" });
  }

  it("moves a sent report out of the working list and onto the Completed tab", async () => {
    const tabs = await renderWithTwoDeliveries();

    // Scoped to the desktop table: the page also renders a mobile list, so an
    // unscoped query matches every contract twice.
    const table = () => screen.getByRole("table", { name: "Generated reports" });

    // Outstanding is where you land: the row still needing a Send is here,
    // the delivered one is not.
    await waitFor(() => {
      expect(within(table()).getByText(/CV-NO-IMAGE/i)).toBeInTheDocument();
    });
    expect(within(table()).queryByText(/CV-THUMB-100/i)).not.toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole("tab", { name: /Completed/i }));

    await waitFor(() => {
      expect(within(table()).getByText(/CV-THUMB-100/i)).toBeInTheDocument();
    });
    expect(within(table()).queryByText(/CV-NO-IMAGE/i)).not.toBeInTheDocument();
  });

  it("counts each tab so the rows on screen are explained", async () => {
    const tabs = await renderWithTwoDeliveries();
    await waitFor(() => {
      expect(within(tabs).getByRole("tab", { name: /Outstanding/i })).toHaveTextContent("1");
    });
    expect(within(tabs).getByRole("tab", { name: /Completed/i })).toHaveTextContent("1");
  });

  it("keeps the counts still while the search box is used", async () => {
    /*
       The counts come from every group, not from the filtered output. A count
       that moved as you typed could not answer "how much is left to send",
       which is the only question the tab exists to answer.
    */
    const tabs = await renderWithTwoDeliveries();
    await waitFor(() => {
      expect(within(tabs).getByRole("tab", { name: /Completed/i })).toHaveTextContent("1");
    });

    fireEvent.change(screen.getByPlaceholderText(/Search reports/i), {
      target: { value: "nothing will match this" },
    });

    await waitFor(() => {
      expect(screen.getByText(/No reports found/i)).toBeInTheDocument();
    });
    expect(within(tabs).getByRole("tab", { name: /Completed/i })).toHaveTextContent("1");
    expect(within(tabs).getByRole("tab", { name: /Outstanding/i })).toHaveTextContent("1");
  });

  it("marks the tab in force for assistive technology", async () => {
    const tabs = await renderWithTwoDeliveries();
    expect(within(tabs).getByRole("tab", { name: /Outstanding/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.click(within(tabs).getByRole("tab", { name: /Completed/i }));

    await waitFor(() => {
      expect(within(tabs).getByRole("tab", { name: /Completed/i })).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });
    expect(within(tabs).getByRole("tab", { name: /Outstanding/i })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("says why the Completed tab is empty rather than blaming the filters", async () => {
    // "No reports match the current search and filters" on a tab with no
    // filters applied reads as a fault rather than as an empty state.
    mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
    mocks.getDeliveries.mockResolvedValue([
      {
        workItemId: "wi-ready-only",
        reportId: reportWithThumbnail._id,
        reportModel: "AssetReport",
        reportType: "asset",
        contractNo: reportWithThumbnail.contract_no,
        state: "ready",
        canSend: true,
      },
    ]);
    render(<ReportsPage />);

    const tabs = await screen.findByRole("tablist", { name: "Queue" });
    fireEvent.click(within(tabs).getByRole("tab", { name: /Completed/i }));

    await waitFor(() => {
      expect(screen.getByText(/Nothing completed yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Reports appear here once they have been sent to Auctioneer/i)
    ).toBeInTheDocument();
  });

  it("keeps a report with no delivery record on the Outstanding tab", async () => {
    /*
       Most reports have no delivery row at all — they were never eligible, or
       nothing has been attempted yet. Undefined must read as "not sent", not
       fall through a strict equality into the Sent tab.
    */
    mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
    mocks.getDeliveries.mockResolvedValue([]);
    render(<ReportsPage />);

    const tabs = await screen.findByRole("tablist", { name: "Queue" });
    await waitFor(() => {
      expect(within(tabs).getByRole("tab", { name: /Outstanding/i })).toHaveTextContent("1");
    });
    expect(within(tabs).getByRole("tab", { name: /Completed/i })).toHaveTextContent("0");
    const table = screen.getByRole("table", { name: "Generated reports" });
    expect(within(table).getByText(/CV-THUMB-100/i)).toBeInTheDocument();
  });

  /*
     ── ?contract=, THE DEEP LINK FROM INCOMING ───────────────────────────────
     OWNER, 2026-09-29, of Open report on the Incoming screen: "A bug here, when
     i clicked marked area, it is not opening."

     It pushed /reports — the whole list — so the reader arrived at dozens of
     rows with nothing selected. Nothing opened because nothing had been named.

     The link now carries the contract number and this page seeds its search box
     from it, reusing the narrowing that already existed rather than adding a
     second filter to keep in step with the first.
  */
  /*
     history.replaceState, not a redefined window.location: jsdom serves
     location as non-configurable, so Object.defineProperty throws
     "Cannot redefine property: location". Pushing a real URL changes
     location.search the way the browser would, which is what the page reads.
  */
  function withSearchParam(value: string) {
    const original = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({}, "", `/reports?search=${encodeURIComponent(value)}`);
    return () => window.history.replaceState({}, "", original);
  }

  it("narrows to the contract named in the link", async () => {
    mocks.getAssetReports.mockResolvedValue({
      data: [reportWithThumbnail, reportWithoutThumbnail],
    });
    mocks.getDeliveries.mockResolvedValue([]);
    const restore = withSearchParam("CV-THUMB-100");
    try {
      render(<ReportsPage />);
      const table = await screen.findByRole("table", { name: "Generated reports" });
      /*
         Wait on the EXCLUSION, not the inclusion. Both rows render on the first
         paint; the seeding effect runs after it, so asserting the wanted row is
         present passes immediately and proves nothing about the narrowing.
      */
      await waitFor(() => {
        expect(within(table).queryByText(/CV-NO-IMAGE/i)).not.toBeInTheDocument();
      });
      expect(within(table).getByText(/CV-THUMB-100/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Search reports/i)).toHaveValue("CV-THUMB-100");
    } finally {
      restore();
    }
  });

  it("opens on the Completed tab when the named report was already sent", async () => {
    /*
       Without this the link lands on Outstanding, which by definition cannot
       contain a sent report — the same "nothing happened" from the other
       direction, and the more likely case, since Open report only appears once
       a report exists.
    */
    mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
    mocks.getDeliveries.mockResolvedValue([
      {
        workItemId: "wi-deep-sent",
        reportId: reportWithThumbnail._id,
        reportModel: "AssetReport",
        reportType: "asset",
        contractNo: reportWithThumbnail.contract_no,
        state: "sent",
        canSend: false,
      },
    ]);
    const restore = withSearchParam("CV-THUMB-100");
    try {
      render(<ReportsPage />);
      const tabs = await screen.findByRole("tablist", { name: "Queue" });
      await waitFor(() => {
        expect(within(tabs).getByRole("tab", { name: /Completed/i })).toHaveAttribute(
          "aria-selected",
          "true"
        );
      });
      const table = screen.getByRole("table", { name: "Generated reports" });
      expect(within(table).getByText(/CV-THUMB-100/i)).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("stays on Outstanding for a report that has not been sent", async () => {
    mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
    mocks.getDeliveries.mockResolvedValue([
      {
        workItemId: "wi-deep-ready",
        reportId: reportWithThumbnail._id,
        reportModel: "AssetReport",
        reportType: "asset",
        contractNo: reportWithThumbnail.contract_no,
        state: "ready",
        canSend: true,
      },
    ]);
    const restore = withSearchParam("CV-THUMB-100");
    try {
      render(<ReportsPage />);
      const tabs = await screen.findByRole("tablist", { name: "Queue" });
      await waitFor(() => {
        expect(within(tabs).getByRole("tab", { name: /Outstanding/i })).toHaveAttribute(
          "aria-selected",
          "true"
        );
      });
    } finally {
      restore();
    }
  });

  it("shows the whole list when no contract is named", async () => {
    // The fallback Incoming uses when a queue row has no contract number.
    mocks.getAssetReports.mockResolvedValue({
      data: [reportWithThumbnail, reportWithoutThumbnail],
    });
    mocks.getDeliveries.mockResolvedValue([]);
    render(<ReportsPage />);
    const table = await screen.findByRole("table", { name: "Generated reports" });
    await waitFor(() => {
      expect(within(table).getByText(/CV-THUMB-100/i)).toBeInTheDocument();
    });
    expect(within(table).getByText(/CV-NO-IMAGE/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search reports/i)).toHaveValue("");
  });

  /*
     ── CLOSE MY PART OF THIS CONTRACT (owner, 2026-10-02) ───────────────────
     A person may have nothing left to send. Delivered Auctioneer work stays on
     this page (Incoming drops sent rows), so this is where an assigned user
     tells Auctioneer they have finished; the contract completes once every
     assigned person has closed theirs.
  */
  describe("Close my part of this contract", () => {
    const sentAssigned = {
      workItemId: "wi-sent-assigned",
      reportId: reportWithThumbnail._id,
      reportModel: "AssetReport" as const,
      reportType: "asset" as const,
      contractId: "contract-thumb",
      contractNo: reportWithThumbnail.contract_no,
      state: "sent" as const,
      canSend: false,
      canCompleteContract: true,
      contractCompletionScope: "user" as const,
    };

    async function completedTable() {
      render(<ReportsPage />);
      const tabs = await screen.findByRole("tablist", { name: "Queue" });
      fireEvent.click(within(tabs).getByRole("tab", { name: /Completed/i }));
      const table = screen.getByRole("table", { name: "Generated reports" });
      await waitFor(() => expect(within(table).getByText(/CV-THUMB-100/i)).toBeInTheDocument());
      return table;
    }

    it("closes the user's part after confirmation and says where the contract stands", async () => {
      const confirm = vi.fn(() => true);
      vi.stubGlobal("confirm", confirm);
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      mocks.closeContractPart.mockResolvedValue({
        contractId: "contract-thumb",
        closedAt: "2026-10-02T12:00:00.000Z",
        taskCompleted: false,
        alreadyCompleted: false,
        userStatus: "completed",
      });
      const table = await completedTable();

      fireEvent.click(
        within(table).getByRole("button", { name: /Close my part of this contract: CV-THUMB-100/ })
      );

      await waitFor(() => expect(mocks.closeContractPart).toHaveBeenCalledWith("contract-thumb", undefined));
      expect(mocks.closeContractPart).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Close your part of contract CV-THUMB-100?"));
      await waitFor(() =>
        expect(within(table).queryByRole("button", { name: /Close my part of this contract/ })).not.toBeInTheDocument()
      );
      expect(within(table).getByText("Sent · your part closed")).toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith(
        "Your part of contract CV-THUMB-100 is closed. It completes when every assigned person has closed theirs."
      );
    });

    it("says so when the user's close completed the whole contract", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      mocks.closeContractPart.mockResolvedValue({
        contractId: "contract-thumb", closedAt: "2026-10-03T12:00:00.000Z", taskCompleted: true, alreadyCompleted: false, userStatus: "completed",
      });
      const table = await completedTable();
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      await waitFor(() => expect(within(table).getByText("Sent · contract complete")).toBeInTheDocument());
    });

    it.each([0, "reopen-revision-2"])("passes the delivery's exact re-open revision to close: %s", async (accessRevision) => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([{ ...sentAssigned, accessRevision }]);
      mocks.closeContractPart.mockResolvedValue({ contractId: "contract-thumb", closedAt: "2026-10-03T12:00:00.000Z", taskCompleted: false, userStatus: "completed" });
      const table = await completedTable();
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      await waitFor(() => expect(mocks.closeContractPart).toHaveBeenCalledExactlyOnceWith("contract-thumb", accessRevision));
      expect(toast.success).toHaveBeenCalled();
    });

    it.each([undefined, "old-revision"])("retains the report and explains an epoch refusal for revision %s", async (accessRevision) => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([{ ...sentAssigned, accessRevision }]);
      mocks.closeContractPart.mockRejectedValue({ response: { status: 409, data: {
        code: "auctioneer_contract_capture_changed", message: "status code 409 http://127.0.0.1/private",
      } } });
      const table = await completedTable();
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This contract's access changed after it was re-opened. Refresh Reports, then close your current part when all new deliveries are finished."));
      expect(mocks.closeContractPart).toHaveBeenCalledExactlyOnceWith("contract-thumb", accessRevision);
      expect(toast.success).not.toHaveBeenCalled();
      expect(within(table).getByRole("button", { name: /Close my part of this contract/ })).toBeEnabled();
      expect(within(table).queryByText("Sent · your part closed")).not.toBeInTheDocument();
    });

    it("does nothing when the confirmation is declined", async () => {
      vi.stubGlobal("confirm", vi.fn(() => false));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      const table = await completedTable();
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      expect(mocks.closeContractPart).not.toHaveBeenCalled();
      expect(within(table).getByRole("button", { name: /Close my part of this contract/ })).toBeEnabled();
    });

    it.each(["saved summary", "close receipt"])("distinguishes revoked assignment from a successful part close: %s", async (source) => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([{ ...sentAssigned, ...(source === "saved summary" ? {
        contractClosedAt: "2026-10-03T12:00:00.000Z", contractCloseUserStatus: "revoked", contractTaskCompleted: false,
      } : {}) }]);
      mocks.closeContractPart.mockResolvedValue({ contractId: "contract-thumb", closedAt: "2026-10-03T12:00:00.000Z", taskCompleted: false, userStatus: "revoked" });
      const table = await completedTable();
      if (source === "close receipt") fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      await waitFor(() => expect(within(table).getByText("Sent · assignment removed")).toBeInTheDocument());
      expect(within(table).queryByText("Sent · your part closed")).not.toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("locks repeated clicks and ignores a result after the account session changes", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      let resolveClose!: (value: unknown) => void;
      mocks.closeContractPart.mockReturnValue(new Promise((resolve) => { resolveClose = resolve; }));
      const table = await completedTable();
      const button = within(table).getByRole("button", { name: /Close my part of this contract/ });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(mocks.closeContractPart).toHaveBeenCalledTimes(1);
      advanceAuthSession();
      resolveClose({ contractId: "contract-thumb", closedAt: "2026-10-03T12:00:00.000Z", taskCompleted: true, userStatus: "completed" });
      await waitFor(() => expect(button).toBeEnabled());
      expect(toast.success).not.toHaveBeenCalled();
      expect(within(table).queryByText("Sent · contract complete")).not.toBeInTheDocument();
    });

    it("does not close a stale row after the session changed before the click", async () => {
      const confirm = vi.fn(() => true);
      vi.stubGlobal("confirm", confirm);
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      const table = await completedTable();
      advanceAuthSession();
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      expect(mocks.closeContractPart).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("Your account session changed. Refresh Reports before closing your part of a contract.");
    });

    it("does not let a pre-close refresh undo the confirmed receipt", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      const table = await completedTable();
      let resolveRefresh!: (value: unknown) => void;
      mocks.getDeliveries.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
      fireEvent(window, new Event("focus"));
      await waitFor(() => expect(mocks.getDeliveries).toHaveBeenCalledTimes(2));
      mocks.closeContractPart.mockResolvedValue({ contractId: "contract-thumb", closedAt: "2026-10-03T12:00:00.000Z", taskCompleted: false, userStatus: "completed" });
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      await waitFor(() => expect(within(table).getByText("Sent · your part closed")).toBeInTheDocument());
      resolveRefresh([sentAssigned]);
      await waitFor(() => expect(screen.getByRole("button", { name: /Refresh/i })).toBeEnabled());
      expect(within(table).queryByRole("button", { name: /Close my part of this contract/ })).not.toBeInTheDocument();
    });

    it("keeps malformed server errors out of the rendered toast", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      mocks.closeContractPart.mockRejectedValue({ response: { data: { message: { secret: "not displayable" } } } });
      const table = await completedTable();
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Your contract completion could not be confirmed. Refresh Reports to check its status before trying again."));
      expect(within(table).getByRole("button", { name: /Close my part of this contract/ })).toBeEnabled();
    });

    it("keeps the action and shows the server's reason when the close is refused", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([sentAssigned]);
      mocks.closeContractPart.mockRejectedValue({
        response: { status: 409, data: { message: "One of your deliveries for this contract has not finished.", code: "auctioneer_contract_delivery_unfinished" } },
      });
      const table = await completedTable();
      fireEvent.click(within(table).getByRole("button", { name: /Close my part of this contract/ }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("One of your deliveries for this contract has not finished.")
      );
      expect(within(table).getByRole("button", { name: /Close my part of this contract/ })).toBeEnabled();
      expect(within(table).queryByText("Sent · your part closed")).not.toBeInTheDocument();
    });

    it.each([
      ["older unassigned work", { contractCompletionScope: "contract" as const }],
      ["a part already closed", { contractClosedAt: "2026-10-01T09:00:00.000Z", contractTaskCompleted: false }],
      ["a server that names no scope", { contractCompletionScope: undefined }],
      ["a delivery without its contract", { contractId: undefined }],
    ])("is not offered for %s", async (_case, overrides) => {
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([{ ...sentAssigned, ...overrides }]);
      const table = await completedTable();
      expect(within(table).queryByRole("button", { name: /Close my part of this contract/ })).not.toBeInTheDocument();
    });

    it("treats a part closed by one delivery as closed on every report of the contract", async () => {
      // Two reports on one contract; only the second delivery carried the close.
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail, reportWithoutThumbnail] });
      mocks.getDeliveries.mockResolvedValue([
        sentAssigned,
        {
          ...sentAssigned,
          workItemId: "wi-sent-assigned-2",
          reportId: reportWithoutThumbnail._id,
          contractClosedAt: "2026-10-02T09:00:00.000Z",
          contractTaskCompleted: false,
        },
      ]);
      const table = await completedTable();
      await waitFor(() => expect(within(table).getByText(/CV-NO-IMAGE/i)).toBeInTheDocument());

      expect(within(table).queryByRole("button", { name: /Close my part of this contract/ })).not.toBeInTheDocument();
      expect(within(table).getAllByText("Sent · your part closed")).toHaveLength(2);
    });

    it("is not offered before the delivery has reached Auctioneer", async () => {
      mocks.getAssetReports.mockResolvedValue({ data: [reportWithThumbnail] });
      mocks.getDeliveries.mockResolvedValue([{ ...sentAssigned, state: "ready", canSend: true }]);
      render(<ReportsPage />);
      const table = await screen.findByRole("table", { name: "Generated reports" });
      await waitFor(() => expect(within(table).getByText(/CV-THUMB-100/i)).toBeInTheDocument());
      expect(within(table).queryByRole("button", { name: /Close my part of this contract/ })).not.toBeInTheDocument();
    });
  });
});
