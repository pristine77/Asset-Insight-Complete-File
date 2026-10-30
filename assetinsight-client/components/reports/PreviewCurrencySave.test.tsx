import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PreviewModal from "./PreviewModal";
import LotListingPreviewModal from "./LotListingPreviewModal";

const mocks = vi.hoisted(() => ({ convert: vi.fn(), category: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock("@/services/reportCurrency", () => ({ convertPreviewCurrency: mocks.convert }));
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
      location: "Regina, Saskatchewan, Canada", _currency_base_revision: "opaque-read-revision",
      include_damage_analysis: false, include_valuation_table: false, valuation_methods: ["FML"],
      valuation_data: { baseFMV: 1000, methods: [{ method: "FML", percentage: 100, value: 1000 }] },
      total_value: 1000, total_appraised_value: 1000,
      lots: [{ lot_id: "lot-1", lot_number: "1", title: "Saved lot", estimated_value: "USD 1,000.00",
        categories: "Equipment", image_urls: [], condition_report_specs: {},
        condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" } }] } } };
}
function converted(preview: any) {
  return { preview_data: { ...preview, currency: "CAD", total_value: 1400, total_appraised_value: 1400,
    lots: preview.lots.map((lot: any) => ({ ...lot, estimated_value: "CAD 1,400.00" })),
    currency_conversion: { version: 1, token: "opaque-confirmed-receipt" } },
    quote: { fromCurrency: "USD", toCurrency: "CAD", rate: 1.4, asOf: "2026-10-30", quotedAt: "2026-10-30T12:00:00Z",
      sourceUrl: "https://www.bankofcanada.ca/rates/", sourceTitle: "Bank of Canada" } };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function element(kind: Kind, open: boolean, load: () => Promise<any>, save: (...args: any[]) => Promise<any>, close = vi.fn()) {
  const props = { isOpen: open, reportId: `currency-${kind}`, isResubmitMode: true, onClose: close,
    loadPreviewDataOverride: load, resubmitReportOverride: save };
  return kind === "asset" ? <PreviewModal {...props} /> : <LotListingPreviewModal {...props} />;
}
const select = () => document.getElementById("preview-currency") as HTMLSelectElement;
const saveButton = () => screen.getByRole("button", { name: "Save preview" });
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.category.mockResolvedValue({ categories: [], specs: [] }); });

describe.each<Kind>(["asset", "lot-listing"])("%s preview currency Save", kind => {
  it("never submits the old currency while automatic conversion is pending; saves the exact confirmed snapshot", async () => {
    const source = response(), pending = deferred<ReturnType<typeof converted>>();
    mocks.convert.mockReturnValue(pending.promise);
    const save = vi.fn().mockResolvedValue({ status: "processing", files_generating: true }), close = vi.fn();
    render(element(kind, true, vi.fn().mockResolvedValue(source), save, close));
    await waitFor(() => expect(select()).toHaveValue("USD"));
    fireEvent.change(select(), { target: { value: "CAD" } });
    expect(mocks.convert).toHaveBeenCalledTimes(1);
    expect(mocks.convert.mock.calls[0].slice(0, 3)).toEqual([kind, `currency-${kind}`, "CAD"]);
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(save).not.toHaveBeenCalled();
    const snapshot = mocks.convert.mock.calls[0][3];
    expect(snapshot.currency).toBe("USD");
    await act(async () => pending.resolve(converted(snapshot)));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(select()).toHaveValue("CAD");
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toMatchObject({ currency: "CAD", currency_conversion: { token: "opaque-confirmed-receipt" },
      total_appraised_value: 1400, lots: [{ lot_id: "lot-1", estimated_value: "CAD 1,400.00" }] });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps Save blocked after a lookup failure and retries with the latest unsaved edits", async () => {
    mocks.convert.mockRejectedValueOnce(new Error("Fresh rate unavailable"));
    const save = vi.fn().mockResolvedValue({ status: "processing", files_generating: true });
    render(element(kind, true, vi.fn().mockResolvedValue(response()), save));
    await waitFor(() => expect(select()).toHaveValue("USD"));
    fireEvent.change(select(), { target: { value: "CAD" } });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Fresh rate unavailable"));
    expect(select()).toHaveValue("CAD");
    expect(screen.getByText(/CAD is selected, but the report is still USD/)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled(); fireEvent.click(saveButton()); expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByDisplayValue("CURRENCY-QA"), { target: { value: "CURRENCY-QA-EDITED" } });
    mocks.convert.mockImplementationOnce(async (_kind: string, _id: string, _target: string, preview: any) => converted(preview));
    fireEvent.click(screen.getByRole("button", { name: "Convert amounts" }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton()); await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toMatchObject({ currency: "CAD", contract_no: "CURRENCY-QA-EDITED",
      currency_conversion: { token: "opaque-confirmed-receipt" } });
  });

  it("cancels a failed target by choosing the original currency and resets it on close/reopen", async () => {
    mocks.convert.mockRejectedValue(new Error("Fresh rate unavailable"));
    const load = vi.fn().mockResolvedValue(response()), save = vi.fn();
    const view = render(element(kind, true, load, save));
    await waitFor(() => expect(select()).toHaveValue("USD"));
    fireEvent.change(select(), { target: { value: "CAD" } });
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(saveButton()).toBeDisabled();
    fireEvent.change(select(), { target: { value: "USD" } });
    expect(saveButton()).toBeEnabled(); expect(mocks.convert).toHaveBeenCalledTimes(1);
    fireEvent.change(select(), { target: { value: "CAD" } });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(2));
    view.rerender(element(kind, false, load, save)); view.rerender(element(kind, true, load, save));
    await waitFor(() => expect(select()).toHaveValue("USD"));
    expect(saveButton()).toBeEnabled(); expect(save).not.toHaveBeenCalled();
  });

  it("retains the selected currency and edits when conversion is refused as stale", async () => {
    mocks.convert.mockRejectedValue({ response: { status: 409, data: { message: "This report changed. Refresh before converting currency." } } });
    const save = vi.fn();
    render(element(kind, true, vi.fn().mockResolvedValue(response()), save));
    await waitFor(() => expect(select()).toHaveValue("USD"));
    fireEvent.change(screen.getByDisplayValue("CURRENCY-QA"), { target: { value: "UNSAVED-EDIT" } });
    fireEvent.change(select(), { target: { value: "CAD" } });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("This report changed. Refresh before converting currency."));
    expect(select()).toHaveValue("CAD");
    expect(screen.getByDisplayValue("UNSAVED-EDIT")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled(); expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Convert amounts" })).toBeEnabled();
  });
});
