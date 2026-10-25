import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LotListingPreviewModal from "./LotListingPreviewModal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const mocks = vi.hoisted(() => ({
  getAssetCategorySpecs: vi.fn(),
  reverseGeocode: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  promoteDraftPreview: vi.fn(),
  submitForApproval: vi.fn(),
}));

vi.mock("@/services/lotListing", () => ({
  getLotListingPreview: vi.fn(),
  getLotListingSubmittedPreview: vi.fn(),
  updateLotListingPreview: vi.fn(),
  uploadLotListingPreviewLotImages: vi.fn(),
  refreshLotListingSpecPdf: vi.fn(),
  submitLotListingForApproval: mocks.submitForApproval,
  resubmitLotListing: vi.fn(),
}));

vi.mock("@/services/assets", () => ({
  getAssetCategorySpecs: mocks.getAssetCategorySpecs,
}));

vi.mock("@/services/browserLocation", () => ({
  BrowserLocationService: {
    reverseGeocode: mocks.reverseGeocode,
  },
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@/services/reportDrafts", () => ({
  ReportDraftService: {
    promotePreview: mocks.promoteDraftPreview,
  },
}));

function makeListingPreview() {
  return {
    data: {
      status: "preview",
      imageUrls: [],
      preview_data: {
        contract_no: "LOT-LOCATION-1",
        currency: "CAD",
        location: "Old Inspection Yard",
        latitude: 50.1,
        longitude: -104.2,
        lots: [
          {
            lot_id: "lot-1",
            lot_number: "1",
            title: "Test lot",
            description: "Test description",
            estimated_value: "1000",
            image_indices: [],
            location: "Old Inspection Yard",
            latitude: 50.1,
            longitude: -104.2,
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
}

describe("LotListingPreviewModal inspection location", () => {

  it('submits edited, cleared and deleted specs with authoritative overrides and unchanged lot/media identity', async () => {
    const response: any = makeListingPreview();
    response.data.preview_data.total_value = 9876;
    const lot = response.data.preview_data.lots[0];
    Object.assign(lot, { categories: 'Equipment', condition_report_specs_reviewed: true,
      condition_report_specs: { Length: '10 ft', Width: '5 ft', Height: '6 ft', Notes: 'Scratches visible on left side' },
      condition_report_specs_manual_overrides: { Length: 'old length', Width: 'old width', Height: 'old height' },
      hidden_condition_report_specs: { Length: true, Colour: true },
    });
    mocks.getAssetCategorySpecs.mockResolvedValue({ categories: [], specs: [{ parentCategory: 'Assets', childCategory: 'Equipment', fields: ['Overall Length', 'Overall Width', 'Overall Height'] }] });
    render(<LotListingPreviewModal isOpen reportId="spec-authority" onClose={vi.fn()} loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} />);
    await screen.findByDisplayValue('LOT-LOCATION-1');
    fireEvent.click(screen.getAllByRole('button', { name: '10 ft' })[0]);
    fireEvent.change(screen.getByPlaceholderText('Edit the full field value'), { target: { value: '12 ft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove Overall Width' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '6 ft' })[0]);
    fireEvent.change(screen.getByPlaceholderText('Edit the full field value'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: "Save preview" }));
    await waitFor(() => expect(mocks.submitForApproval).toHaveBeenCalledTimes(1));
    const edited = mocks.submitForApproval.mock.calls[0][1].preview_data.lots[0];
    expect(mocks.submitForApproval.mock.calls[0][1].preview_data.total_value).toBe(9876);
    expect(edited.condition_report_specs).toEqual({ 'Overall Length': '12 ft', 'Overall Height': '', Notes: 'Scratches visible on left side' });
    expect(edited.condition_report_specs_manual_overrides).toEqual({ 'Overall Length': '12 ft', 'Overall Width': '', 'Overall Height': '' });
    expect(edited.condition_report_specs_deleted).toEqual(['Overall Width']);
    expect(edited.hidden_condition_report_specs).toEqual({ Colour: true });
    expect(edited.lot_id).toBe(lot.lot_id);
    expect(edited.description).toBe(lot.description);
    expect(edited.image_indices).toEqual(lot.image_indices);
    expect(edited.condition_report_specs_reviewed).toBe(true);
  });
  it("submits without FMV or appraisal selections and does not display their required blocks", async () => {
    const response = makeListingPreview();
    response.data.preview_data.lots[0].estimated_value = "";
    response.data.preview_data.lots[0].condition_report_selections = { condition: "", completeness: "", legal: "" };
    mocks.submitForApproval.mockResolvedValue({ status: "processing", files_generating: true });
    render(<LotListingPreviewModal isOpen reportId="optional-lot-values" onClose={vi.fn()}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} />);
    await screen.findByDisplayValue("LOT-LOCATION-1");
    expect(screen.queryByText("Required selections")).toBeNull();
    expect(screen.queryByText(/Set Running Condition for all lots/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(mocks.submitForApproval).toHaveBeenCalledTimes(1));
    expect(mocks.submitForApproval.mock.calls[0][1].preview_data.lots[0]).toMatchObject({
      lot_id: "lot-1", description: "Test description", estimated_value: "",
      condition_report_selections: { condition: "", completeness: "", legal: "" },
    });
  });

  it("resubmits an edited failed preview instead of calling the preview-only submit endpoint", async () => {
    const response = makeListingPreview();
    response.data.status = "error";
    const retry = vi.fn().mockResolvedValue({ status: "processing", files_generating: true });
    render(<LotListingPreviewModal isOpen reportId="failed-lot" onClose={vi.fn()}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} resubmitReportOverride={retry} />);
    const contract = await screen.findByDisplayValue("LOT-LOCATION-1");
    expect(screen.getByRole("alert")).toHaveTextContent("saved preview is available");
    fireEvent.change(contract, { target: { value: "93530" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("failed-lot", expect.objectContaining({ contract_no: "93530" })));
    expect(mocks.submitForApproval).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    mocks.getAssetCategorySpecs.mockReset();
    mocks.getAssetCategorySpecs.mockResolvedValue({ categories: [], specs: [] });
    mocks.reverseGeocode.mockReset();
    mocks.reverseGeocode.mockResolvedValue({
      location: "10 Downing Street, London, United Kingdom",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    });
    mocks.promoteDraftPreview.mockReset().mockResolvedValue({
      reportId: "promoted-lot-report",
      reportType: "lotListing",
      status: "approved",
      files_generating: true,
    });
    mocks.submitForApproval.mockReset().mockResolvedValue({ status: "processing", files_generating: true });
  });

  it("reloads for a mode switch and ignores the older in-flight listing", async () => {
    const olderRequest = deferred<ReturnType<typeof makeListingPreview>>();
    const submittedResponse = makeListingPreview();
    submittedResponse.data.status = "approved";
    submittedResponse.data.preview_data.contract_no = "LOT-SUBMITTED-SNAPSHOT";
    const loadPreview = vi
      .fn()
      .mockReturnValueOnce(olderRequest.promise)
      .mockResolvedValueOnce(submittedResponse);
    const onClose = vi.fn();

    const { rerender } = render(
      <LotListingPreviewModal
        isOpen
        reportId="listing-mode-switch"
        isResubmitMode={false}
        onClose={onClose}
        loadPreviewDataOverride={loadPreview}
      />
    );
    await waitFor(() => expect(loadPreview).toHaveBeenCalledTimes(1));

    rerender(
      <LotListingPreviewModal
        isOpen
        reportId="listing-mode-switch"
        isResubmitMode
        onClose={onClose}
        loadPreviewDataOverride={loadPreview}
      />
    );

    await waitFor(() => expect(loadPreview).toHaveBeenCalledTimes(2));
    expect(await screen.findByDisplayValue("LOT-SUBMITTED-SNAPSHOT")).toBeInTheDocument();

    const olderResponse = makeListingPreview();
    olderResponse.data.preview_data.contract_no = "LOT-OLDER-SNAPSHOT";
    olderRequest.resolve(olderResponse);
    await waitFor(() => {
      expect(screen.queryByDisplayValue("LOT-OLDER-SNAPSHOT")).toBeNull();
      expect(screen.getByDisplayValue("LOT-SUBMITTED-SNAPSHOT")).toBeInTheDocument();
    });
  });

  it("resolves a coordinate-only legacy preview without exposing a placeholder", async () => {
    const response = makeListingPreview();
    response.data.preview_data.location = "Current Browser Location";
    response.data.preview_data.lots[0].location = "Current Browser Location";

    render(
      <LotListingPreviewModal
        isOpen
        reportId="listing-location"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
      />
    );

    const location = await screen.findByRole("textbox", {
      name: "Inspection Location *",
    });
    await waitFor(() => {
      expect(location).toHaveValue(
        "10 Downing Street, London, United Kingdom"
      );
    });
    expect(screen.queryByDisplayValue("Current Browser Location")).toBeNull();
  });

  it("sends null coordinate markers when the location name is manually changed", async () => {
    const response = makeListingPreview();
    const updatePreview = vi.fn().mockResolvedValue({
      data: { preview_data: response.data.preview_data, imageUrls: [] },
    });

    mocks.submitForApproval.mockImplementation((id, body) => updatePreview(id, body.preview_data));
    render(
      <LotListingPreviewModal
        isOpen
        reportId="listing-manual-location"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
        updatePreviewDataOverride={updatePreview}
        refreshSpecPdfOverride={vi.fn().mockResolvedValue({
          data: { spec_pdf: "https://example.test/cr.pdf" },
        })}
      />
    );

    const location = await screen.findByRole("textbox", {
      name: "Inspection Location *",
    });
    fireEvent.change(location, { target: { value: "New Inspection Yard" } });
    fireEvent.click(screen.getByRole("button", { name: /^save preview$/i }));

    await waitFor(() => expect(updatePreview).toHaveBeenCalled());
    const savedPreview = updatePreview.mock.calls[0][1];
    expect(savedPreview).toMatchObject({
      location: "New Inspection Yard",
      latitude: null,
      longitude: null,
    });
    expect(savedPreview.lots[0]).toMatchObject({
      location: "New Inspection Yard",
      latitude: null,
      longitude: null,
    });
  });

  it("promotes and submits the exact edited Lot Listing draft preview", async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(
      <LotListingPreviewModal
        isOpen
        reportId="hidden-lot-report"
        draftPreviewId="lot-draft-1"
        onClose={onClose}
        onSuccess={onSuccess}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(makeListingPreview())}
      />
    );

    const contract = await screen.findByDisplayValue("LOT-LOCATION-1");
    fireEvent.change(contract, { target: { value: "LOT-EDITED-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));

    await waitFor(() =>
      expect(mocks.promoteDraftPreview).toHaveBeenCalledWith(
        "lot-draft-1",
        expect.objectContaining({
          submit: true,
          preview_data: expect.objectContaining({
            contract_no: "LOT-EDITED-1",
          }),
        })
      )
    );
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "promoted-lot-report",
        reportId: "promoted-lot-report",
      })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });


  it("saves and regenerates the latest listing once without separate save or CR requests", async () => {
    const response = makeListingPreview();
    response.data.status = "approved";
    const pending = deferred<any>();
    const resubmit = vi.fn().mockReturnValue(pending.promise);
    const updatePreview = vi.fn(), refreshSpecPdf = vi.fn(), uploadImages = vi.fn(), onClose = vi.fn();
    render(<LotListingPreviewModal isOpen reportId="combined-listing" onClose={onClose}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
      updatePreviewDataOverride={updatePreview} resubmitReportOverride={resubmit}
      uploadPreviewLotImagesOverride={uploadImages} refreshSpecPdfOverride={refreshSpecPdf} />);
    fireEvent.change(await screen.findByDisplayValue("Test lot"), { target: { value: "Complete edited title" } });
    expect(screen.queryByRole("button", { name: /^Save changes$/i })).toBeNull();
    const action = screen.getByRole("button", { name: "Save preview" });
    fireEvent.click(action); fireEvent.click(action);
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(["photo"], "locked.jpg", { type: "image/jpeg" })] },
    });
    expect(resubmit).toHaveBeenCalledTimes(1);
    expect(resubmit).toHaveBeenCalledWith("combined-listing", expect.objectContaining({
      lots: [expect.objectContaining({ lot_id: "lot-1", title: "Complete edited title", description: "Test description" })],
    }));
    expect(updatePreview).not.toHaveBeenCalled();
    expect(uploadImages).not.toHaveBeenCalled();
    expect(action).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close panel" })).toBeDisabled();
    expect(document.querySelector(".preview-editor [inert]")).not.toBeNull();
    pending.resolve({ status: "processing", files_generating: true });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(refreshSpecPdf).not.toHaveBeenCalled();
    expect(action).toBeDisabled();
  });

  it("keeps edits and shows the actual generation error for a deliberate retry", async () => {
    const response = makeListingPreview();
    response.data.status = "approved";
    const resubmit = vi.fn()
      .mockRejectedValueOnce({ response: { data: { message: "Another file generation is in progress. Try again when it finishes." } } })
      .mockResolvedValueOnce({ status: "processing" });
    const onClose = vi.fn();
    render(<LotListingPreviewModal isOpen reportId="retry-listing" onClose={onClose}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} resubmitReportOverride={resubmit} />);
    const title = await screen.findByDisplayValue("Test lot");
    fireEvent.change(title, { target: { value: "Retain this edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Another file generation is in progress. Try again when it finishes."));
    expect(title).toHaveValue("Retain this edit");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(resubmit.mock.calls[0][1]).toEqual(resubmit.mock.calls[1][1]);
  });

  it("submits a dirty listing snapshot once without requiring a file-generating Save", async () => {
    const pendingSubmit = deferred<Record<string, unknown>>();
    const onClose = vi.fn();
    mocks.submitForApproval.mockReturnValue(pendingSubmit.promise);

    render(
      <LotListingPreviewModal
        isOpen
        reportId="initial-lot-submit-lock"
        onClose={onClose}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(makeListingPreview())}
      />
    );

    const contract = await screen.findByDisplayValue("LOT-LOCATION-1");
    fireEvent.change(contract, { target: { value: "LOT-FINAL-SNAPSHOT" } });
    const submitButton = screen.getByRole("button", {
      name: "Save preview",
    });
    expect(submitButton).toBeEnabled();

    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    expect(mocks.submitForApproval).toHaveBeenCalledTimes(1);
    expect(mocks.submitForApproval).toHaveBeenCalledWith(
      "initial-lot-submit-lock",
      expect.objectContaining({
        preview_data: expect.objectContaining({
          contract_no: "LOT-FINAL-SNAPSHOT",
        }),
      })
    );
    expect(submitButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close panel" })).toBeDisabled();

    pendingSubmit.resolve({
      _id: "initial-lot-submit-lock",
      status: "approved",
      preview_data: makeListingPreview().data.preview_data,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
