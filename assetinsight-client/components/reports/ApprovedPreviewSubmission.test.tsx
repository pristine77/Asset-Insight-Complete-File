import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LotListingPreviewModal from "./LotListingPreviewModal";
import PreviewModal from "./PreviewModal";

const mocks = vi.hoisted(() => ({
  getAssetCategorySpecs: vi.fn(),
  resubmitLotListing: vi.fn(),
  resubmitReport: vi.fn(),
  submitForApproval: vi.fn(),
  submitLotListingForApproval: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/services/assets", () => ({
  getPreviewData: vi.fn(),
  updatePreviewData: vi.fn(),
  submitForApproval: mocks.submitForApproval,
  getSubmittedPreviewData: vi.fn(),
  resubmitReport: mocks.resubmitReport,
  getAssetCategorySpecs: mocks.getAssetCategorySpecs,
  refreshAssetSpecPdf: vi.fn(),
  uploadPreviewLotImages: vi.fn(),
}));

vi.mock("@/services/lotListing", () => ({
  getLotListingPreview: vi.fn(),
  getLotListingSubmittedPreview: vi.fn(),
  updateLotListingPreview: vi.fn(),
  uploadLotListingPreviewLotImages: vi.fn(),
  refreshLotListingSpecPdf: vi.fn(),
  submitLotListingForApproval: mocks.submitLotListingForApproval,
  resubmitLotListing: mocks.resubmitLotListing,
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

const approvedAssetResponse = {
  data: {
    status: "approved",
    grouping_mode: "single_lot",
    image_count: 0,
    imageUrls: [],
    preview_data: {
      client_name: "Approved Asset Client",
      currency: "USD",
      grouping_mode: "single_lot",
      location: "10 Downing Street, London SW1A 2AA, United Kingdom",
      valuation_methods: ["FML"],
      lots: [
        {
          lot_number: "1",
          title: "Approved asset",
          description: "Approved asset description",
          details: "Approved asset details",
          estimated_value: "US$42,000",
          image_indices: [],
          extra_image_urls: [],
          condition_report_specs: {},
        },
      ],
    },
  },
};

const approvedLotListingResponse = {
  data: {
    _id: "approved-lot-listing",
    status: "approved",
    imageUrls: [],
    preview_data: {
      client_name: "Approved Lot Listing Client",
      currency: "USD",
      location: "10 Downing Street, London SW1A 2AA, United Kingdom",
      valuation_methods: ["FML"],
      lots: [
        {
          lot_number: "1",
          title: "Approved lot",
          description: "Approved lot description",
          details: "Approved lot details",
          estimated_value: "US$24,000",
          image_indices: [],
          extra_image_urls: [],
          condition_report_specs: {},
          condition_report_selections: {
            condition: "N/A",
            completeness: "N/A",
            legal: "N/A",
          },
        },
      ],
    },
  },
};

const declinedAssetResponse = {
  data: {
    ...approvedAssetResponse.data,
    status: "declined",
    decline_reason: "Please revise the asset report.",
    preview_data: {
      ...approvedAssetResponse.data.preview_data,
      client_name: "Declined Asset Client",
    },
  },
};

const declinedLotListingResponse = {
  data: {
    ...approvedLotListingResponse.data,
    _id: "declined-lot-listing",
    status: "declined",
    decline_reason: "Please revise the lot listing.",
    preview_data: {
      ...approvedLotListingResponse.data.preview_data,
      client_name: "Declined Lot Listing Client",
    },
  },
};

describe("preview submission routing by loaded status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    mocks.getAssetCategorySpecs.mockResolvedValue({ categories: [], specs: [] });
    mocks.resubmitReport.mockResolvedValue({ message: "Regeneration queued", data: {} });
    mocks.resubmitLotListing.mockResolvedValue(approvedLotListingResponse.data);
    mocks.submitForApproval.mockResolvedValue({
      message: "Initial submission queued",
      data: { reportId: "approved-asset" },
    });
    mocks.submitLotListingForApproval.mockResolvedValue(approvedLotListingResponse.data);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("regenerates an approved Asset even when isResubmitMode is false", async () => {
    render(
      <PreviewModal
        isOpen
        isResubmitMode={false}
        reportId="approved-asset"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(approvedAssetResponse)}
      />
    );

    const resubmitButton = await screen.findByRole("button", {
      name: "Save preview",
    });
    expect(
      screen.getAllByRole("button", { name: "Save preview" })
    ).toHaveLength(1);
    fireEvent.click(resubmitButton);

    await waitFor(() => {
      expect(mocks.resubmitReport).toHaveBeenCalledWith(
        "approved-asset",
        expect.objectContaining({ client_name: "Approved Asset Client" })
      );
    });
    expect(mocks.submitForApproval).not.toHaveBeenCalled();
  });

  it("regenerates an approved Lot Listing even when isResubmitMode is false", async () => {
    render(
      <LotListingPreviewModal
        isOpen
        isResubmitMode={false}
        reportId="approved-lot-listing"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(approvedLotListingResponse)}
      />
    );

    const regenerateButton = await screen.findByRole("button", {
      name: "Save preview",
    });
    expect(
      screen.getAllByRole("button", { name: "Save preview" })
    ).toHaveLength(1);
    fireEvent.click(regenerateButton);

    await waitFor(() => {
      expect(mocks.resubmitLotListing).toHaveBeenCalledWith(
        "approved-lot-listing",
        expect.objectContaining({
          preview_data: expect.objectContaining({
            client_name: "Approved Lot Listing Client",
          }),
        })
      );
    });
    expect(mocks.submitLotListingForApproval).not.toHaveBeenCalled();
  });

  it("initially submits a declined Asset even when isResubmitMode is stale true", async () => {
    render(
      <PreviewModal
        isOpen
        isResubmitMode
        reportId="declined-asset"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(declinedAssetResponse)}
      />
    );

    const submitButton = await screen.findByRole("button", {
      name: "Save preview",
    });
    expect(
      screen.getAllByRole("button", { name: "Save preview" })
    ).toHaveLength(1);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mocks.submitForApproval).toHaveBeenCalledWith(
        "declined-asset",
        expect.objectContaining({ client_name: "Declined Asset Client" })
      );
    });
    expect(mocks.resubmitReport).not.toHaveBeenCalled();
  });

  it("initially submits a declined Lot Listing even when isResubmitMode is stale true", async () => {
    render(
      <LotListingPreviewModal
        isOpen
        isResubmitMode
        reportId="declined-lot-listing"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi
          .fn()
          .mockResolvedValue(declinedLotListingResponse)}
      />
    );

    const generateButton = await screen.findByRole("button", {
      name: "Save preview",
    });
    expect(
      screen.getAllByRole("button", { name: "Save preview" })
    ).toHaveLength(1);
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(mocks.submitLotListingForApproval).toHaveBeenCalledWith(
        "declined-lot-listing",
        expect.objectContaining({
          preview_data: expect.objectContaining({
            client_name: "Declined Lot Listing Client",
          }),
        })
      );
    });
    expect(mocks.resubmitLotListing).not.toHaveBeenCalled();
  });
});
