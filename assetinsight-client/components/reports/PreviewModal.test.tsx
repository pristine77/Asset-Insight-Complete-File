import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreviewModal from "./PreviewModal";

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

vi.mock("@/services/assets", () => ({
  getPreviewData: vi.fn(),
  updatePreviewData: vi.fn(),
  submitForApproval: mocks.submitForApproval,
  getSubmittedPreviewData: vi.fn(),
  resubmitReport: vi.fn(),
  getAssetCategorySpecs: mocks.getAssetCategorySpecs,
  refreshAssetSpecPdf: vi.fn(),
  uploadPreviewLotImages: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@/services/browserLocation", () => ({
  BrowserLocationService: {
    reverseGeocode: mocks.reverseGeocode,
  },
}));

vi.mock("@/services/reportDrafts", () => ({
  ReportDraftService: {
    promotePreview: mocks.promoteDraftPreview,
  },
}));

function makePreviewResponse() {
  return {
    data: {
      status: "preview",
      grouping_mode: "single_lot",
      image_count: 0,
      imageUrls: [],
      preview_data: {
        client_name: "Test Client",
        location: "Test Yard, London",
        currency: "USD",
        grouping_mode: "single_lot",
        valuation_methods: ["FML", "TKV", "OLV", "FLV"],
        valuation_data: {
          methods: [
            { method: "FML", fullName: "Fair Market Value", percentage: 100 },
            { method: "TKV", fullName: "Trade Value", percentage: 70 },
            {
              method: "OLV",
              fullName: "Orderly Liquidation Value",
              percentage: 77,
            },
            {
              method: "FLV",
              fullName: "Forced Liquidation Value",
              percentage: 52,
            },
          ],
        },
        lots: [
          {
            lot_number: "1",
            title: "Ford Super Duty",
            categories: "Emergency Vehicles",
            description: "Mobile treatment centre",
            details: "4WD with treatment equipment",
            estimated_value: "US$42,000",
            mixed_group_index: 1,
            sub_mode: "single_lot",
            image_indices: [],
            extra_image_urls: [],
            condition_report_specs: {},
          },
        ],
      },
    },
  };
}

/*
 * WHERE A CONTROL LIVES, SO A QUERY SEARCHES ONLY THERE.
 *
 * The bulk-selection tests render 100–205 lots, and a page of 20 carries about
 * 370 buttons and 60 selects. A role query over the whole modal checks the
 * visibility of every candidate by walking computed styles, which jsdom
 * recomputes after every change: one unscoped button query cost about 9 s
 * after a re-render, an unscoped select query over 1 s (measured 2026-09-30).
 * Three tests here timed out on nothing else — the assertions were never the
 * problem. Scoped to the control's own container, the same query keeps its
 * visibility check and costs milliseconds.
 */
const pagination = () =>
  within(screen.getByRole("navigation", { name: "Asset lots pagination" }));
const lotSelection = () =>
  within(screen.getByRole("group", { name: "Select lots for bulk required selections" }));
/** The table row of one lot, found through its own selection checkbox. */
const lotRow = (lot: number) => {
  const row = screen
    .getByRole("checkbox", { name: `Select lot ${lot}, row ${lot}` })
    .closest("tr");
  if (!row) throw new Error(`No table row for lot ${lot}`);
  return within(row as HTMLElement);
};
/*
 * The Save button sits in the modal's action bar, which has no landmark to
 * scope to, and a role query for it works out the name of every button on the
 * page — about 10 s after a re-render, even with the visibility check off. It
 * is found by its visible label instead, and then held to its accessible name,
 * so the lookup cannot drift onto some other button that says the same thing.
 */
const saveChangesButton = () => {
  const button = screen.getByText("Save", { selector: "span" }).closest("button");
  if (!button) throw new Error('"Save" is not inside a button');
  expect(button).toHaveAccessibleName("Save preview");
  return button;
};

describe("PreviewModal valuation methods", () => {

  it('submits edited, cleared and deleted specs with authoritative overrides and unchanged lot/media identity', async () => {
    const response: any = makePreviewResponse();
    const lot = response.data.preview_data.lots[0];
    Object.assign(lot, { categories: 'Equipment', condition_report_specs_reviewed: true,
      condition_report_specs: { Length: '10 ft', Width: '5 ft', Height: '6 ft', Notes: 'Scratches visible on left side' },
      condition_report_specs_manual_overrides: { Length: 'old length', Width: 'old width', Height: 'old height' },
      hidden_condition_report_specs: { Length: true, Colour: true },
    });
    mocks.getAssetCategorySpecs.mockResolvedValue({ categories: [], specs: [{ parentCategory: 'Assets', childCategory: 'Equipment', fields: ['Overall Length', 'Overall Width', 'Overall Height'] }] });
    render(<PreviewModal isOpen reportId="spec-authority" onClose={vi.fn()} loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} />);
    await screen.findByDisplayValue('Test Client');
    fireEvent.click(screen.getAllByRole('button', { name: '10 ft' })[0]);
    fireEvent.change(screen.getByPlaceholderText('Edit the full field value'), { target: { value: '12 ft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove Overall Width' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '6 ft' })[0]);
    fireEvent.change(screen.getByPlaceholderText('Edit the full field value'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: "Save preview" }));
    await waitFor(() => expect(mocks.submitForApproval).toHaveBeenCalledTimes(1));
    const edited = mocks.submitForApproval.mock.calls[0][1].lots[0];
    expect(edited.condition_report_specs).toEqual({ 'Overall Length': '12 ft', 'Overall Height': '', Notes: 'Scratches visible on left side' });
    expect(edited.condition_report_specs_manual_overrides).toEqual({ 'Overall Length': '12 ft', 'Overall Width': '', 'Overall Height': '' });
    expect(edited.condition_report_specs_deleted).toEqual(['Overall Width']);
    expect(edited.hidden_condition_report_specs).toEqual({ Colour: true });
    expect(edited.lot_id).toBe(lot.lot_id);
    expect(edited.description).toBe(lot.description);
    expect(edited.image_indices).toEqual(lot.image_indices);
    expect(edited.condition_report_specs_reviewed).toBe(true);
  });
  it("resubmits a failed saved Asset preview instead of calling the preview-only submit endpoint", async () => {
    const response = makePreviewResponse();
    response.data.status = "error";
    const retry = vi.fn().mockResolvedValue({ status: "processing", files_generating: true });
    render(<PreviewModal isOpen reportId="failed-asset" onClose={vi.fn()}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} resubmitReportOverride={retry} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("saved preview is available");
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(retry.mock.calls[0][0]).toBe("failed-asset");
    expect(mocks.submitForApproval).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    mocks.getAssetCategorySpecs.mockReset();
    mocks.getAssetCategorySpecs.mockResolvedValue({ categories: [], specs: [] });
    mocks.reverseGeocode.mockReset();
    mocks.reverseGeocode.mockResolvedValue({
      location: "10 Downing Street, London, United Kingdom",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    });
    mocks.promoteDraftPreview.mockReset().mockResolvedValue({
      reportId: "promoted-report-1",
      reportType: "asset",
      status: "pending_approval",
      files_generating: true,
    });
    mocks.submitForApproval.mockReset().mockResolvedValue({ data: { reportId: "generated" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads for a mode switch and ignores the older in-flight preview", async () => {
    const olderRequest = deferred<ReturnType<typeof makePreviewResponse>>();
    const submittedResponse = makePreviewResponse();
    submittedResponse.data.status = "pending_approval";
    submittedResponse.data.preview_data.client_name = "Submitted snapshot";
    const loadPreview = vi
      .fn()
      .mockReturnValueOnce(olderRequest.promise)
      .mockResolvedValueOnce(submittedResponse);
    const onClose = vi.fn();

    const { rerender } = render(
      <PreviewModal
        isOpen
        reportId="asset-mode-switch"
        isResubmitMode={false}
        onClose={onClose}
        loadPreviewDataOverride={loadPreview}
      />
    );
    await waitFor(() => expect(loadPreview).toHaveBeenCalledTimes(1));

    rerender(
      <PreviewModal
        isOpen
        reportId="asset-mode-switch"
        isResubmitMode
        onClose={onClose}
        loadPreviewDataOverride={loadPreview}
      />
    );

    await waitFor(() => expect(loadPreview).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByDisplayValue("Submitted snapshot")).not.toHaveLength(0);

    const olderResponse = makePreviewResponse();
    olderResponse.data.preview_data.client_name = "Older preview snapshot";
    olderRequest.resolve(olderResponse);
    await waitFor(() => {
      expect(screen.queryByDisplayValue("Older preview snapshot")).toBeNull();
      expect(screen.getAllByDisplayValue("Submitted snapshot")).not.toHaveLength(0);
    });
  });

  it("renders every selected method and recalculates each lot value from the editable base", async () => {
    render(
      <PreviewModal
        isOpen
        reportId="report-1"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(makePreviewResponse())}
      />
    );

    expect(
      await screen.findByRole("heading", { name: "Assets / Lots" })
    ).toBeInTheDocument();

    const methodGroups = screen.getAllByLabelText(
      "Selected valuation methods for lot 1"
    );
    const valueGroups = screen.getAllByLabelText(
      "Valuation method values for lot 1"
    );
    expect(methodGroups).toHaveLength(1);
    expect(valueGroups).toHaveLength(1);

    for (const method of ["FML", "TKV", "OLV", "FLV"]) {
      expect(within(methodGroups[0]).getByText(method)).toBeInTheDocument();
    }
    for (const value of [
      "US$42,000",
      "US$29,400",
      "US$32,340",
      "US$21,840",
    ]) {
      expect(within(valueGroups[0]).getByText(value)).toBeInTheDocument();
    }

    const baseFields = screen.getAllByRole("textbox", {
      name: "Base market value for lot 1",
    });
    expect(baseFields).toHaveLength(1);
    fireEvent.change(baseFields[0], { target: { value: "US$50,000" } });

    await waitFor(() => {
      expect(within(valueGroups[0]).getByText("US$35,000")).toBeInTheDocument();
    });
  });

  it("renders only the compact lot editor on mobile viewports", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation(() => ({
        matches: false,
        media: "(min-width: 768px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );

    render(
      <PreviewModal
        isOpen
        reportId="report-mobile"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(makePreviewResponse())}
      />
    );

    expect(
      await screen.findByLabelText("Selected valuation methods for lot 1")
    ).toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Selected valuation methods for lot 1")
    ).toHaveLength(1);
    expect(
      screen.getByRole("textbox", { name: "Base market value for lot 1" })
    ).toBeInTheDocument();
  });

  it("applies each required group only to lots 4, 8, and 9 of 100 and preserves individual overrides after save/reopen", async () => {
    const response = makePreviewResponse();
    response.data.preview_data.lots = Array.from({ length: 100 }, (_, index) => ({
      ...response.data.preview_data.lots[0],
      lot_number: String(index + 1),
      title: `Asset ${index + 1}`,
      condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "" },
    }));
    const updatePreview = vi.fn().mockImplementation(async (_id, previewData) => ({
      message: "Saved",
      data: previewData,
    }));

    mocks.submitForApproval.mockImplementation(updatePreview);
    const view = render(
      <PreviewModal
        isOpen
        reportId="report-selected-lots"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
        updatePreviewDataOverride={updatePreview}
      />
    );

    await screen.findByDisplayValue("Asset 1");
    const saveButton = saveChangesButton();
    const applyControl = screen.getByRole("group", {
      name: "Apply Legal value to selected lots",
    });
    expect(saveButton).toBeEnabled();
    expect(
      within(applyControl).getByRole("button", {
        name: "Apply N/A to 0 selected lots",
      })
    ).toBeDisabled();

    for (const lotNumber of [4, 8, 9]) {
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: `Select lot ${lotNumber}, row ${lotNumber}`,
        })
      );
    }

    expect(
      screen.getByText(
        "3 of 100 lots selected. Apply a value below or adjust any lot individually."
      )
    ).toBeInTheDocument();
    expect(saveButton).toBeEnabled();

    fireEvent.click(
      within(applyControl).getByRole("button", {
        name: "Apply N/A to 3 selected lots",
      })
    );
    expect(saveButton).toBeEnabled();

    for (const [group, option] of [["Running Condition", "Starts and Runs with Boost"], ["Completeness", "Has Keys"]]) {
      fireEvent.click(within(screen.getByRole("group", { name: `Apply ${group} value to selected lots` })).getByRole("button", { name: `Apply ${option} to 3 selected lots` }));
    }
    expect(lotRow(1).getByRole("combobox", { name: "Legal for lot 1, row 1" })).toHaveValue("");
    for (const index of [3, 7, 8]) {
      expect(
        lotRow(index + 1).getByRole("combobox", { name: `Legal for lot ${index + 1}, row ${index + 1}` })
      ).toHaveValue("N/A");
    }

    fireEvent.change(lotRow(8).getByRole("combobox", { name: "Legal for lot 8, row 8" }), { target: { value: "No Title" } });
    fireEvent.change(lotRow(4).getByRole("combobox", { name: "Running Condition for lot 4, row 4" }), { target: { value: "Does not Start or Run" } });
    fireEvent.change(lotRow(9).getByRole("combobox", { name: "Completeness for lot 9, row 9" }), { target: { value: "Missing Parts" } });
    fireEvent.click(saveButton);

    await waitFor(() => expect(updatePreview).toHaveBeenCalledTimes(1));
    const savedPreview = updatePreview.mock.calls[0][1];
    expect(
      savedPreview.lots.map(
        (lot: any) => lot.condition_report_selections?.legal || ""
      )
    ).toEqual(Array.from({ length: 100 }, (_, index) => index === 7 ? "No Title" : [3, 8].includes(index) ? "N/A" : ""));
    for (let index = 0; index < 100; index += 1) {
      expect(savedPreview.lots[index].condition_report_selections.condition).toBe(index === 3 ? "Does not Start or Run" : [7, 8].includes(index) ? "Starts and Runs with Boost" : "N/A");
      expect(savedPreview.lots[index].condition_report_selections.completeness).toBe(index === 8 ? "Missing Parts" : [3, 7].includes(index) ? "Has Keys" : "N/A");
      for (const key of ["lot_number", "description", "details", "image_indices", "extra_image_urls"]) expect(savedPreview.lots[index][key]).toEqual((response.data.preview_data.lots[index] as any)[key]);
    }
    expect(savedPreview.lots[3].condition_report_specs["Running Condition"]).toBe("Does not Start or Run");
    await waitFor(() => {
      expect(
        screen.getByText("Select the lots that should receive the same required selections.")
      ).toBeInTheDocument();
    });
    expect(
      within(applyControl).getByRole("button", {
        name: "Apply N/A to 0 selected lots",
      })
    ).toBeDisabled();
    view.unmount();
    render(<PreviewModal isOpen reportId="report-selected-lots" onClose={vi.fn()} loadPreviewDataOverride={vi.fn().mockResolvedValue({ data: { ...response.data, preview_data: savedPreview } })} />);
    await screen.findByDisplayValue("Asset 1");
    expect(lotRow(4).getByRole("combobox", { name: "Running Condition for lot 4, row 4" })).toHaveValue("Does not Start or Run");
    expect(lotRow(9).getByRole("combobox", { name: "Completeness for lot 9, row 9" })).toHaveValue("Missing Parts");
    expect(lotRow(8).getByRole("combobox", { name: "Legal for lot 8, row 8" })).toHaveValue("No Title");
    expect(screen.getByRole("checkbox", { name: "Select lot 8, row 8" })).not.toBeChecked();
  }, 20_000);

  it("pages large reports, preserves focus, and selects every off-page lot", async () => {
    const response = makePreviewResponse();
    response.data.preview_data.lots = Array.from({ length: 205 }, (_, index) => ({
      ...response.data.preview_data.lots[0],
      lot_number: String(index + 1),
      title: `Asset ${index + 1}`,
      condition_report_selections: {
        legal: index === 0 ? "No Title" : "",
      },
    }));
    const updatePreview = vi.fn().mockImplementation(async (_id, previewData) => ({
      message: "Saved",
      data: previewData,
    }));

    mocks.submitForApproval.mockImplementation(updatePreview);
    render(
      <PreviewModal
        isOpen
        reportId="report-large"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
        updatePreviewDataOverride={updatePreview}
      />
    );

    const firstTitle = await screen.findByDisplayValue("Asset 1");
    // A collapsed content-visibility placeholder can move the bottom pager
    // between scrolling it into view and clicking. These 20 rows stay laid out.
    expect(firstTitle.closest(".app-render-row")).toBeNull();
    expect(screen.getByDisplayValue("Asset 20").closest(".app-render-row")).toBeNull();
    expect(screen.queryByDisplayValue("Asset 21")).toBeNull();
    expect(pagination().getByText("Showing 1–20 of 205 lots")).toBeInTheDocument();

    firstTitle.focus();
    fireEvent.change(firstTitle, { target: { value: "Focused asset" } });
    expect(firstTitle).toHaveFocus();

    const selectionControl = screen.getByRole("group", {
      name: "Select lots for bulk required selections",
    });
    fireEvent.click(
      within(selectionControl).getByRole("button", {
        name: "Select all 205 lots",
      })
    );
    expect(
      screen.getByText(
        "205 of 205 lots selected. Apply a value below or adjust any lot individually."
      )
    ).toBeInTheDocument();

    const applyControl = screen.getByRole("group", {
      name: "Apply Legal value to selected lots",
    });
    fireEvent.click(
      within(applyControl).getByRole("button", {
        name: "Apply N/A to 205 selected lots",
      })
    );
    const firstLegalControl = lotRow(1).getByRole("combobox", { name: "Legal for lot 1, row 1" });
    expect(firstLegalControl).toHaveValue("N/A");

    fireEvent.change(firstLegalControl, { target: { value: "No Title" } });
    fireEvent.click(saveChangesButton());

    await waitFor(() => expect(updatePreview).toHaveBeenCalledTimes(1));
    const savedPreview = updatePreview.mock.calls[0][1];
    expect(savedPreview.lots[0].condition_report_selections.legal).toBe("No Title");
    expect(savedPreview.lots[204].condition_report_selections.legal).toBe("N/A");
    expect(
      screen.getByText("Select the lots that should receive the same required selections.")
    ).toBeInTheDocument();

    fireEvent.click(pagination().getByRole("button", { name: "Next lots page" }));
    expect(await screen.findByDisplayValue("Asset 21")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Focused asset")).toBeNull();
    // The same budget as the other heavy bulk-selection tests: 205 lots.
  }, 20_000);

  it.each(["desktop", "mobile"])("navigates the bottom pager and saves all 142 lots and 1824 photo references on %s", async (layout) => {
    if (layout === "mobile") {
      vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    }
    const response: any = makePreviewResponse();
    response.data.status = "approved";
    const photos = Array.from({ length: 1824 }, (_, index) => `https://media.example.test/qa-photo-${index}.jpg`);
    let photoIndex = 0;
    response.data.image_count = photos.length;
    response.data.imageUrls = photos;
    response.data.preview_data.lots = Array.from({ length: 142 }, (_, index) => {
      const count = index < 120 ? 13 : 12;
      const indexes = Array.from({ length: count }, () => photoIndex++);
      return { ...response.data.preview_data.lots[0], lot_id: `qa-stable-${index}`, lot_number: String(index + 1),
        title: `Asset ${index + 1}`, image_indices: indexes, image_urls: indexes.map(i => photos[i]),
        cover_image_url: photos[indexes[0]], description: `Original description ${index + 1}` };
    });
    const expectedLots = structuredClone(response.data.preview_data.lots);
    expectedLots[0].title = "First page edit";
    expectedLots[20].title = "Second page edit";
    expectedLots[141].title = "Last page edit";
    const submit = vi.fn().mockResolvedValue({ message: "Queued", data: {} });
    render(<PreviewModal isOpen reportId="qa-142" isResubmitMode onClose={vi.fn()}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} resubmitReportOverride={submit} />);
    const firstTitle = await screen.findByDisplayValue("Asset 1");
    expect(firstTitle.closest(".app-render-row")).toBeNull();
    expect(screen.getByDisplayValue("Asset 20").closest(".app-render-row")).toBeNull();
    const bottom = () => within(screen.getByRole("navigation", { name: "Asset lots pagination bottom" }));
    expect(pagination().getByText("Page 1 of 8")).toBeInTheDocument();
    expect(bottom().getByText("Showing 1–20 of 142 lots")).toBeInTheDocument();
    expect(bottom().getByRole("button", { name: "Previous lots page" })).toBeDisabled();
    expect(screen.getByText("Saving generates files for all 142 lots across all 8 pages, not only this page.")).toBeInTheDocument();
    firstTitle.focus();
    fireEvent.change(firstTitle, { target: { value: "First page edit" } });
    const start = screen.getByRole("group", { name: "Lot page 1 of 8" });
    const scroll = vi.fn();
    Object.defineProperty(start, "scrollIntoView", { configurable: true, value: scroll });
    fireEvent.click(bottom().getByRole("button", { name: "Next lots page" }));
    expect(start).toHaveFocus();
    expect(start).toHaveAccessibleName("Lot page 2 of 8");
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    fireEvent.change(screen.getByDisplayValue("Asset 21"), { target: { value: "Second page edit" } });
    for (let page = 3; page <= 8; page++) fireEvent.click(bottom().getByRole("button", { name: "Next lots page" }));
    expect(bottom().getByText("Showing 141–142 of 142 lots")).toBeInTheDocument();
    expect(bottom().getByText("Page 8 of 8")).toBeInTheDocument();
    expect(bottom().getByRole("button", { name: "Next lots page" })).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue("Asset 142"), { target: { value: "Last page edit" } });
    fireEvent.click(bottom().getByRole("button", { name: "Previous lots page" }));
    expect(start).toHaveFocus();
    expect(pagination().getByText("Showing 121–140 of 142 lots")).toBeInTheDocument();
    for (let page = 6; page >= 1; page--) fireEvent.click(pagination().getByRole("button", { name: "Previous lots page" }));
    expect(screen.getByDisplayValue("First page edit")).toBeInTheDocument();
    fireEvent.click(saveChangesButton());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const saved = submit.mock.calls[0][1];
    expect(saved.lots).toEqual(expectedLots);
    expect(saved.lots.flatMap((lot: any) => lot.image_urls)).toEqual(photos);
    expect(saved.lots.flatMap((lot: any) => lot.image_indices)).toEqual(Array.from({ length: 1824 }, (_, i) => i));
    expect(mocks.submitForApproval).not.toHaveBeenCalled();
  }, 20_000);

  it("preserves selected lots across pages, applies page/all groups, and clears without changing values", async () => {
    const response = makePreviewResponse();
    response.data.preview_data.lots = Array.from({ length: 100 }, (_, index) => ({ ...response.data.preview_data.lots[0], lot_number: String(index + 1), title: `Asset ${index + 1}` }));
    const update = vi.fn().mockImplementation(async (_id, data) => ({ message: "Saved", data }));
    mocks.submitForApproval.mockImplementation(update);
    render(<PreviewModal isOpen reportId="page-selections" onClose={vi.fn()} loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} updatePreviewDataOverride={update} />);
    await screen.findByDisplayValue("Asset 1");
    for (const label of ["Running Condition", "Completeness", "Legal"]) {
      expect(within(screen.getByRole("group", { name: `Apply ${label} value to selected lots` })).getByRole("button", { name: "Apply N/A to 0 selected lots" })).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "Select lot 4, row 4" }));
    fireEvent.click(pagination().getByRole("button", { name: "Next lots page" }));
    fireEvent.click(lotSelection().getByRole("button", { name: "Select 20 lots on this page" }));
    expect(screen.getByText("21 of 100 lots selected. Apply a value below or adjust any lot individually.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Apply Running Condition value to selected lots" })).getByRole("button", { name: "Apply Unverified Running Condition to 21 selected lots" }));
    fireEvent.click(lotSelection().getByRole("button", { name: "Unselect 20 lots on this page" }));
    fireEvent.click(pagination().getByRole("button", { name: "Previous lots page" }));
    expect(screen.getByRole("checkbox", { name: "Select lot 4, row 4" })).toBeChecked();
    fireEvent.click(lotSelection().getByRole("button", { name: "Select all 100 lots" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Apply Completeness value to selected lots" })).getByRole("button", { name: "Apply Incomplete Unit to 100 selected lots" }));
    fireEvent.click(lotSelection().getByRole("button", { name: "Clear selection" }));
    expect(lotSelection().getByRole("button", { name: "Clear selection" })).toBeDisabled();
    expect(lotRow(4).getByRole("combobox", { name: "Running Condition for lot 4, row 4" })).toHaveValue("Unverified Running Condition");
    expect(lotRow(1).getByRole("combobox", { name: "Completeness for lot 1, row 1" })).toHaveValue("Incomplete Unit");
    fireEvent.click(saveChangesButton());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const lots = update.mock.calls[0][1].lots;
    lots.forEach((lot: any, index: number) => {
      expect(lot.condition_report_selections.completeness).toBe("Incomplete Unit");
      expect(lot.condition_report_selections.condition || "").toBe(index === 3 || (index >= 20 && index < 40) ? "Unverified Running Condition" : "");
      expect(lot.condition_report_selections.legal).toBeUndefined();
    });
  }, 20_000);

  it.each([0, 1])("handles %i lots without bulk controls and keeps single-lot overrides available", async (count) => {
    const response = makePreviewResponse();
    response.data.preview_data.lots = response.data.preview_data.lots.slice(0, count);
    render(<PreviewModal isOpen reportId={`lot-count-${count}`} onClose={vi.fn()} loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} />);
    await screen.findByRole("heading", { name: "Assets / Lots" });
    expect(screen.queryByRole("region", { name: "Bulk required selections" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select lot/ })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Asset lots pagination" })).toBeNull();
    if (count === 1) for (const label of ["Running Condition", "Completeness", "Legal"]) {
      const field = screen.getByRole("combobox", { name: `${label} for lot 1, row 1` });
      fireEvent.change(field, { target: { value: "N/A" } });
      expect(field).toHaveValue("N/A");
    }
  });

  it("clears transient selection on lot insertion, deletion and explicit reload", async () => {
    const response = makePreviewResponse();
    response.data.preview_data.lots = Array.from({ length: 3 }, (_, index) => ({ ...response.data.preview_data.lots[0], lot_number: String(index + 1) }));
    const load = vi.fn().mockResolvedValue(response);
    const view = render(<PreviewModal isOpen reportId="structure-selection" onClose={vi.fn()} loadPreviewDataOverride={load} />);
    await screen.findByRole("heading", { name: "Assets / Lots" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select lot 2, row 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Lot" }));
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select lot 2, row 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete lot 1" }));
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select lot 2, row 1" }));
    view.rerender(<PreviewModal isOpen={false} reportId="structure-selection" onClose={vi.fn()} loadPreviewDataOverride={load} />);
    view.rerender(<PreviewModal isOpen reportId="structure-selection" onClose={vi.fn()} loadPreviewDataOverride={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled());
  });

  it("saves the selected appraiser cover images in the chosen order", async () => {
    const response: any = makePreviewResponse();
    const coverImages = [
      "https://images.test/cover-one.jpg",
      "https://images.test/cover-two.jpg",
      "https://images.test/cover-three.jpg",
    ];
    response.data.imageUrls = coverImages;
    response.data.image_count = coverImages.length;
    Object.assign(response.data.preview_data.lots[0], {
      image_urls: coverImages.slice(0, 2),
      image_indexes: [0, 1],
    });
    const updatePreview = vi.fn().mockImplementation(async (_id, previewData) => ({
      message: "Saved",
      data: previewData,
      imageUrls: coverImages,
    }));

    mocks.submitForApproval.mockImplementation(updatePreview);
    render(
      <PreviewModal
        isOpen
        reportId="report-cover"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
        updatePreviewDataOverride={updatePreview}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Select cover images" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Select cover image 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Select cover image 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply cover images" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));

    await waitFor(() => expect(updatePreview).toHaveBeenCalledTimes(1));
    expect(updatePreview.mock.calls[0][1].cover_image_urls).toEqual([
      coverImages[1],
      coverImages[0],
    ]);
    expect(screen.getByText("2 of 4 cover images selected.")).toBeInTheDocument();
  });

  it("resolves a legacy coordinate-only preview before showing a location", async () => {
    const response = makePreviewResponse();
    Object.assign(response.data.preview_data, {
      location: "Current Browser Location",
      latitude: 51.503407,
      longitude: -0.127592,
    });

    render(
      <PreviewModal
        isOpen
        reportId="report-location"
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
    expect(mocks.reverseGeocode).toHaveBeenCalledWith(
      { latitude: 51.503407, longitude: -0.127592 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("clears stale report and inherited lot coordinates after a manual location edit", async () => {
    const response = makePreviewResponse();
    Object.assign(response.data.preview_data, {
      location: "Old Inspection Yard",
      latitude: 50.1,
      longitude: -104.2,
    });
    Object.assign(response.data.preview_data.lots[0], {
      location: "Old Inspection Yard",
      latitude: 50.1,
      longitude: -104.2,
    });
    const updatePreview = vi.fn().mockResolvedValue({
      message: "Saved",
      data: response.data.preview_data,
    });

    mocks.submitForApproval.mockImplementation(updatePreview);
    render(
      <PreviewModal
        isOpen
        reportId="report-manual-location"
        onClose={vi.fn()}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
        updatePreviewDataOverride={updatePreview}
        refreshAssetSpecPdfOverride={vi.fn().mockResolvedValue({
          message: "Refreshed",
          data: { spec_pdf: "https://example.test/cr.pdf" },
        })}
      />
    );

    const location = await screen.findByRole("textbox", {
      name: "Inspection Location *",
    });
    fireEvent.change(location, { target: { value: "New Inspection Yard" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));

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

  it("promotes and submits a draft from the exact edited preview snapshot", async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    render(
      <PreviewModal
        isOpen
        reportId="hidden-report-1"
        draftPreviewId="draft-1"
        onClose={onClose}
        onSuccess={onSuccess}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(makePreviewResponse())}
      />
    );

    const clientName = (await screen.findAllByDisplayValue("Test Client"))[0];
    fireEvent.change(clientName, { target: { value: "Edited Draft Client" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save preview",
      })
    );

    await waitFor(() =>
      expect(mocks.promoteDraftPreview).toHaveBeenCalledWith(
        "draft-1",
        expect.objectContaining({
          submit: true,
          preview_data: expect.objectContaining({
            client_name: "Edited Draft Client",
          }),
        })
      )
    );
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "promoted-report-1",
        reportId: "promoted-report-1",
      })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });


  it("saves and regenerates once, blocking duplicate clicks and concurrent uploads", async () => {
    const response = makePreviewResponse();
    response.data.status = "approved";
    const pending = deferred<any>();
    const resubmit = vi.fn().mockReturnValue(pending.promise);
    const updatePreview = vi.fn(), refreshSpecPdf = vi.fn(), uploadImages = vi.fn(), onClose = vi.fn();
    render(<PreviewModal isOpen reportId="combined-asset" onClose={onClose}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)}
      updatePreviewDataOverride={updatePreview} resubmitReportOverride={resubmit}
      uploadPreviewLotImagesOverride={uploadImages} refreshAssetSpecPdfOverride={refreshSpecPdf} />);
    fireEvent.change((await screen.findAllByDisplayValue("Test Client"))[0], { target: { value: "Latest client" } });
    expect(screen.queryByRole("button", { name: /^Save changes$/i })).toBeNull();
    const action = screen.getByRole("button", { name: "Save preview" });
    fireEvent.click(action); fireEvent.click(action);
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(["photo"], "locked.jpg", { type: "image/jpeg" })] },
    });
    expect(resubmit).toHaveBeenCalledTimes(1);
    expect(resubmit).toHaveBeenCalledWith("combined-asset", expect.objectContaining({ client_name: "Latest client" }));
    expect(updatePreview).not.toHaveBeenCalled();
    expect(uploadImages).not.toHaveBeenCalled();
    expect(action).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close panel" })).toBeDisabled();
    expect(document.querySelector(".preview-editor [inert]")).not.toBeNull();
    pending.resolve({ data: {}, message: "Queued" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(refreshSpecPdf).not.toHaveBeenCalled();
    expect(action).toBeDisabled();
  });


  it("retains edits on rejection and sends the latest corrections on deliberate retry", async () => {
    const response = makePreviewResponse();
    response.data.status = "approved";
    const resubmit = vi.fn()
      .mockRejectedValueOnce({ response: { data: { message: "Please enter FMV for Lot 1" } } })
      .mockResolvedValueOnce({ data: {}, message: "Queued" });
    const onClose = vi.fn();
    render(<PreviewModal isOpen reportId="retry-asset" onClose={onClose}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(response)} resubmitReportOverride={resubmit} />);
    const title = await screen.findByDisplayValue("Ford Super Duty");
    fireEvent.change(title, { target: { value: "Reviewed asset" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Please enter FMV for Lot 1"));
    expect(onClose).not.toHaveBeenCalled();
    expect(title).toHaveValue("Reviewed asset");
    fireEvent.change(title, { target: { value: "Corrected asset" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(resubmit).toHaveBeenLastCalledWith("retry-asset", expect.objectContaining({
      lots: [expect.objectContaining({ title: "Corrected asset" })],
    }));
  });

  it("keeps approval explicit and uses only the assigned-approver generation endpoint", async () => {
    const resubmit = vi.fn().mockResolvedValue({ data: {}, message: "Queued" });
    render(<PreviewModal isOpen isAssignedApprovalMode reportId="assigned-asset" onClose={vi.fn()}
      loadPreviewDataOverride={vi.fn().mockResolvedValue(makePreviewResponse())} resubmitReportOverride={resubmit} />);
    fireEvent.change(await screen.findByDisplayValue("Ford Super Duty"), { target: { value: "Approver edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and approve preview" }));
    await waitFor(() => expect(resubmit).toHaveBeenCalledOnce());
    expect(resubmit).toHaveBeenCalledWith("assigned-asset", expect.objectContaining({
      lots: [expect.objectContaining({ title: "Approver edit" })],
    }));
    expect(mocks.submitForApproval).not.toHaveBeenCalled();
  });

  it("submits a dirty preview snapshot once without requiring a file-generating Save", async () => {
    const pendingSubmit = deferred<{
      message: string;
      data: { reportId: string };
    }>();
    const onClose = vi.fn();
    mocks.submitForApproval.mockReturnValue(pendingSubmit.promise);

    render(
      <PreviewModal
        isOpen
        reportId="initial-submit-lock"
        onClose={onClose}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(makePreviewResponse())}
      />
    );

    const clientName = (await screen.findAllByDisplayValue("Test Client"))[0];
    fireEvent.change(clientName, { target: { value: "Final Snapshot Client" } });
    const submitButton = screen.getByRole("button", { name: "Save preview" });
    expect(submitButton).toBeEnabled();

    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    expect(mocks.submitForApproval).toHaveBeenCalledTimes(1);
    expect(mocks.submitForApproval).toHaveBeenCalledWith(
      "initial-submit-lock",
      expect.objectContaining({ client_name: "Final Snapshot Client" })
    );
    expect(submitButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close panel" })).toBeDisabled();

    pendingSubmit.resolve({
      message: "Submitted",
      data: { reportId: "initial-submit-lock" },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("keeps an approved hidden draft on the promotion path when saving and resubmitting", async () => {
    const onSuccess = vi.fn();
    const approvedPreview = makePreviewResponse();
    approvedPreview.data.status = "approved";

    render(
      <PreviewModal
        isOpen
        reportId="hidden-approved-report"
        draftPreviewId="approved-draft"
        onClose={vi.fn()}
        onSuccess={onSuccess}
        loadPreviewDataOverride={vi.fn().mockResolvedValue(approvedPreview)}
      />
    );

    await screen.findByRole("heading", { name: "Assets / Lots" });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save preview",
      })
    );

    await waitFor(() =>
      expect(mocks.promoteDraftPreview).toHaveBeenCalledWith(
        "approved-draft",
        expect.objectContaining({ submit: true })
      )
    );
    expect(screen.queryByRole("button", { name: /^Save changes$/i })).toBeNull();
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: "promoted-report-1" })
    );
  });
});
