import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PreviewModal from "./PreviewModal";
import LotListingPreviewModal from "./LotListingPreviewModal";

const mocks = vi.hoisted(() => ({ category: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock("@/services/assets", () => ({
  getAssetCategorySpecs: mocks.category, getPreviewData: vi.fn(), getSubmittedPreviewData: vi.fn(),
  updatePreviewData: vi.fn(), submitForApproval: vi.fn(), resubmitReport: vi.fn(),
  uploadPreviewLotImages: vi.fn(), refreshAssetSpecPdf: vi.fn(),
}));
vi.mock("@/services/lotListing", () => ({
  getLotListingPreview: vi.fn(), getLotListingSubmittedPreview: vi.fn(), updateLotListingPreview: vi.fn(),
  submitLotListingForApproval: vi.fn(), resubmitLotListing: vi.fn(),
  uploadLotListingPreviewLotImages: vi.fn(), refreshLotListingSpecPdf: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { error: mocks.error, info: mocks.info, success: mocks.success } }));

type Kind = "asset" | "lot-listing";
function response() {
  return { data: { status: "approved", grouping_mode: "single_lot", imageUrls: [], image_count: 0,
    preview_data: { currency: "USD", contract_no: "CURRENCY-QA", client_name: "Currency QA",
      location: "Regina, Saskatchewan, Canada",
      include_damage_analysis: false, include_valuation_table: false, valuation_methods: ["FML"],
      valuation_data: { baseFMV: 1000, methods: [{ method: "FML", percentage: 100, value: 1000 }] },
      total_value: 1000, total_appraised_value: 1000,
      lots: [{ lot_id: "lot-1", lot_number: "1", title: "Saved lot", estimated_value: "USD 1,000.00",
        categories: "Equipment", image_urls: [], condition_report_specs: {},
        condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" } }] } } };
}
function element(kind: Kind, open: boolean, load: () => Promise<any>, save: (...args: any[]) => Promise<any>, close = vi.fn()) {
  const props = { isOpen: open, reportId: `currency-${kind}`, isResubmitMode: true, onClose: close,
    loadPreviewDataOverride: load, resubmitReportOverride: save };
  return kind === "asset" ? <PreviewModal {...props} /> : <LotListingPreviewModal {...props} />;
}
const saveButton = () => screen.getByRole("button", { name: "Save preview" });
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.category.mockResolvedValue({ categories: [], specs: [] }); });

/*
 * Owner, 2026-10-31: the preview currency conversion was removed. A report keeps
 * the currency it was valued in; the preview shows it and offers no way to
 * change or convert it, and Save carries it unchanged (the server keeps it too:
 * assetinsight-backend/src/utils/reportCurrencyLock.ts).
 */
describe.each<Kind>(["asset", "lot-listing"])("%s preview currency", kind => {
  it("shows the report's currency as text, with nothing to change or convert", async () => {
    render(element(kind, true, vi.fn().mockResolvedValue(response()), vi.fn()));
    await waitFor(() => expect(screen.getByTestId("preview-currency")).toHaveTextContent("USD — US dollar"));
    expect(document.getElementById("preview-currency")).toBeNull();
    expect(screen.queryByRole("button", { name: "Convert amounts" })).toBeNull();
    expect(screen.getByText(/All values are in this currency/)).toBeInTheDocument();
  });

  it("saves with the report's currency unchanged", async () => {
    const save = vi.fn().mockResolvedValue({ status: "processing", files_generating: true });
    render(element(kind, true, vi.fn().mockResolvedValue(response()), save));
    await waitFor(() => expect(screen.getByTestId("preview-currency")).toHaveTextContent("USD"));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toMatchObject({ currency: "USD", lots: [{ lot_id: "lot-1", estimated_value: "USD 1,000.00" }] });
    expect(save.mock.calls[0][1]).not.toHaveProperty("currency_conversion");
  });
});
