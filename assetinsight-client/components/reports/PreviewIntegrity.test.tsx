import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreviewModal from "./PreviewModal";
import LotListingPreviewModal from "./LotListingPreviewModal";

vi.mock("@/services/assets", () => ({
  getAssetCategorySpecs: vi.fn().mockResolvedValue({ categories: [], specs: [] }),
  getPreviewData: vi.fn(), updatePreviewData: vi.fn(), submitForApproval: vi.fn(),
  getSubmittedPreviewData: vi.fn(), resubmitReport: vi.fn(), refreshAssetSpecPdf: vi.fn(),
  uploadPreviewLotImages: vi.fn(),
}));
vi.mock("@/services/lotListing", () => ({
  getLotListingPreview: vi.fn(), getLotListingSubmittedPreview: vi.fn(),
  updateLotListingPreview: vi.fn(), uploadLotListingPreviewLotImages: vi.fn(),
  refreshLotListingSpecPdf: vi.fn(), submitLotListingForApproval: vi.fn(), resubmitLotListing: vi.fn(),
}));
vi.mock("@/services/browserLocation", () => ({ BrowserLocationService: { reverseGeocode: vi.fn() } }));
vi.mock("@/services/reportDrafts", () => ({ ReportDraftService: { promotePreview: vi.fn() } }));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

describe.each(["asset", "lotListing"] as const)("%s preview integrity", (type) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])("edits only the visible Title and preserves hidden prose, structured details and photos after save/reopen (desktop: %s)", async desktop => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: desktop, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    const photos = ["https://images.test/first.jpg", "https://images.test/second.jpg"];
    const originalLots = [1, 2].map(index => ({
      lot_id: `title-authority-${index}`, lot_number: String(index), title: `Saved title ${index}`,
      description: `Hidden original description ${index}`, details: `Hidden legacy prose ${index}`,
      estimated_value: "1000", image_urls: [photos[index - 1]], image_indexes: [index - 1],
      extra_image_urls: [], cover_image_url: photos[index - 1],
      condition_report_specs: { "Operator Note": `Reviewed note ${index}` },
      condition_report_specs_reviewed: true,
      condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" },
    }));
    let preview = { contract_no: "TITLE-AUTHORITY", client_name: "Fixture client", currency: "CAD",
      location: "Fixture yard", grouping_mode: "single_lot", lots: structuredClone(originalLots) };
    const load = vi.fn().mockImplementation(async () => ({ data: { status: "approved", imageUrls: photos, preview_data: preview } }));
    const save = vi.fn().mockImplementation(async (_id, submitted) => {
      preview = structuredClone(submitted);
      return { data: { status: "processing", files_generating: true } };
    });
    const Component = type === "asset" ? PreviewModal : LotListingPreviewModal;
    const props = { isOpen: true, reportId: "title-authority", onClose: vi.fn(), loadPreviewDataOverride: load, resubmitReportOverride: save };
    const view = render(<Component {...props} />);
    const title = await screen.findByDisplayValue("Saved title 1");
    for (const lot of originalLots) {
      expect(screen.queryByDisplayValue(lot.description)).toBeNull();
      expect(screen.queryByDisplayValue(lot.details)).toBeNull();
      expect(screen.getByRole("button", { name: lot.condition_report_specs["Operator Note"] })).toBeInTheDocument();
    }
    expect(screen.queryByPlaceholderText("Description")).toBeNull();
    expect(screen.queryByPlaceholderText("Specs / notes / attributes")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /^Description$|^Specs$/ })).toBeNull();
    fireEvent.change(title, { target: { value: "Reviewed output title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(preview.lots).toEqual([{ ...originalLots[0], title: "Reviewed output title" }, originalLots[1]]);
    view.unmount();
    render(<Component {...props} />);
    await screen.findByDisplayValue("Reviewed output title");
    expect(screen.queryByDisplayValue(originalLots[0].description)).toBeNull();
    expect(screen.queryByDisplayValue(originalLots[0].details)).toBeNull();
    expect(screen.getByRole("button", { name: "Reviewed note 1" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Saved title 2")).toBeInTheDocument();
  });

  it("keeps one atomic Save and a read-only photo viewer even while saving", async () => {
    const photos = ["https://images.test/front.jpg", "https://images.test/rear.jpg"];
    const preview = {
      contract_no: "READ-ONLY-VIEWER", client_name: "Fixture client", currency: "CAD",
      location: "Fixture yard", grouping_mode: "single_lot", lots: [{
        lot_id: "stable-lot", lot_number: "222", title: "Trailer", description: "Reviewed notes",
        estimated_value: "1000", image_urls: photos, image_indexes: [0, 1],
      }],
    };
    const load = vi.fn().mockResolvedValue({ data: { status: "approved", imageUrls: photos, preview_data: preview } });
    let resolve!: (value: unknown) => void;
    const save = vi.fn().mockReturnValue(new Promise(done => { resolve = done; }));
    const Component = type === "asset" ? PreviewModal : LotListingPreviewModal;
    render(<Component isOpen reportId="read-only-viewer" onClose={vi.fn()} loadPreviewDataOverride={load} resubmitReportOverride={save} />);
    const saveButton = await screen.findByRole("button", { name: "Save preview" });
    expect(saveButton).toHaveTextContent(/^Save$/);
    expect(saveButton).toHaveAttribute("title", expect.stringContaining("Photos are not re-read by the AI"));
    expect(screen.queryByRole("button", { name: /Re-Generate/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Save preview" })).toHaveLength(1);
    // Real photo editing stays in the underlying form, not the portalled viewer.
    expect(screen.getAllByRole("button", { name: "Remove photo 1" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("img", { name: "Photo 1" })[0]);
    const viewer = await screen.findByRole("dialog", { name: /Lot #?222 photos/ });
    expect(within(viewer).queryByRole("button", { name: /Remove|Delete/i })).toBeNull();
    fireEvent.click(within(viewer).getByRole("button", { name: "Next photo (Right arrow)" }));
    expect(within(viewer).getByText("Photo 2 of 2")).toBeInTheDocument();
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saveButton).toBeDisabled();
    expect(within(viewer).queryByRole("button", { name: /Remove|Delete/i })).toBeNull();
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1].lots[0]).toMatchObject(preview.lots[0]);
    await act(async () => resolve({ data: { preview_data: preview }, message: "Files queued" }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a late generation receipt after switching reports", async () => {
    let resolve!: (value: any) => void;
    const generate = vi.fn().mockReturnValue(new Promise(done => { resolve = done; }));
    const load = vi.fn().mockImplementation(async id => ({ data: {
      status: "approved", imageUrls: [], preview_data: {
        contract_no: id, client_name: "Fixture", currency: "CAD", location: "Fixture yard", lots: [],
      },
    } }));
    const onClose = vi.fn(), onSuccess = vi.fn();
    const Component = type === "asset" ? PreviewModal : LotListingPreviewModal;
    const props = { isOpen: true, onClose, onSuccess, loadPreviewDataOverride: load, resubmitReportOverride: generate };
    const view = render(<Component {...props} reportId="first-report" />);
    await screen.findByDisplayValue("first-report");
    fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
    expect(generate).toHaveBeenCalledOnce();
    view.rerender(<Component {...props} reportId="second-report" />);
    await screen.findByDisplayValue("second-report");
    await act(async () => resolve({ data: {}, message: "Queued" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("second-report")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save preview" })).toBeEnabled();
  });

  it("saves a serial correction without changing separate lot photo order or cover choices", async () => {
    const photos = Array.from({ length: 41 }, (_, index) => `https://images.test/lot-222-${index}.jpg`);
    const secondPhotos = ["https://images.test/lot-223-front.jpg", "https://images.test/lot-223-rear.jpg"];
    const lots = [photos, secondPhotos].map((urls, index) => ({
      lot_id: `stable-lot-${index}`, lot_number: String(222 + index), title: "2019 Trailer",
      description: `Separate unit ${index}`, estimated_value: "18000", mixed_group_index: index + 1,
      sub_mode: "single_lot", image_urls: urls,
      image_indexes: urls.map((_, position) => position + (index ? photos.length : 0)),
      extra_image_urls: [], serial_number: index ? "SECOND-UNIT" : "OLD-SERIAL",
      condition_report_specs: { "Serial Number": index ? "SECOND-UNIT" : "OLD-SERIAL" },
      condition_report_specs_manual_overrides: { "Serial Number": index ? "SECOND-UNIT" : "OLDER-ADMIN-SERIAL" },
      condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" },
    }));
    const preview = {
      contract_no: "PHOTO-INTEGRITY", client_name: "Fixture client", currency: "CAD",
      location: "Fixture yard", grouping_mode: "mixed", lots,
      cover_image_urls: [photos[2], photos[0]],
    };
    const imageUrls = [...photos, ...secondPhotos];
    const load = vi.fn().mockResolvedValue({ data: { status: "approved", grouping_mode: "mixed", imageUrls, preview_data: preview } });
    const save = vi.fn().mockImplementation(async (_id, submitted) => ({
      data: type === "asset" ? submitted : { preview_data: submitted, imageUrls }, imageUrls,
    }));
    const Component = type === "asset" ? PreviewModal : LotListingPreviewModal;
    render(<Component isOpen reportId="integrity-report" onClose={vi.fn()}
      loadPreviewDataOverride={load} resubmitReportOverride={save} />);

    if (type === "asset") {
      fireEvent.click((await screen.findAllByRole("button", { name: "OLD-SERIAL" }))[0]);
    }
    const serial = (await screen.findAllByDisplayValue("OLD-SERIAL"))[0];
    fireEvent.change(serial, { target: { value: "1FTWW3DR9AEA01459" } });
    if (type === "asset") fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: /^save preview$/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][1];
    expect(saved.lots).toHaveLength(2);
    expect(saved.lots[0]).toMatchObject({
      serial_number: "1FTWW3DR9AEA01459",
      condition_report_specs: { "Serial Number": "1FTWW3DR9AEA01459" },
      condition_report_specs_manual_overrides: { "Serial Number": "1FTWW3DR9AEA01459" },
    });
    for (let index = 0; index < lots.length; index++) {
      for (const key of ["lot_id", "lot_number", "image_urls", "image_indexes", "mixed_group_index", "description"] as const) {
        expect(saved.lots[index][key]).toEqual(lots[index][key]);
      }
    }
    expect(saved.cover_image_urls).toEqual(preview.cover_image_urls);
    expect(saved.lots[1].serial_number).toBe("SECOND-UNIT");
  });

  it("saves and reopens a URL-only deletion without deleting a stale paired image from another lot", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const old = "https://images.test/old-position.jpg";
    const selected = "https://images.test/selected.jpg";
    const remaining = "https://images.test/remaining.jpg";
    const other = "https://images.test/other-lot.jpg";
    const imageUrls = [old, selected, remaining, other];
    const common = { estimated_value: "18000", description: "Reviewed notes", sub_mode: "single_lot" };
    let preview = {
      contract_no: "STALE-PHOTO-INDEX", client_name: "Fixture client", location: "Fixture yard", grouping_mode: "mixed", currency: "CAD",
      lots: [
        { ...common, lot_id: "first", lot_number: "222", title: "Trailer A", image_urls: [selected, remaining], image_indexes: [0, 1] },
        { ...common, lot_id: "second", lot_number: "223", title: "Trailer B", image_urls: [other], image_indexes: [2] },
      ],
    };
    const secondLot = structuredClone(preview.lots[1]);
    const load = vi.fn().mockImplementation(async () => ({ data: { status: "approved", grouping_mode: "mixed", imageUrls, preview_data: preview } }));
    const save = vi.fn().mockImplementation(async (_id, submitted) => {
      preview = submitted;
      return { data: type === "asset" ? submitted : { preview_data: submitted, imageUrls }, imageUrls };
    });
    const Component = type === "asset" ? PreviewModal : LotListingPreviewModal;
    const props = { isOpen: true, reportId: "deletion-integrity", onClose: vi.fn(), loadPreviewDataOverride: load, resubmitReportOverride: save };
    const view = render(<Component {...props} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove photo 1" }))[0]);
    fireEvent.click(screen.getByRole("button", { name: /^save preview$/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][1];
    expect(saved.lots[0].image_urls).toEqual([remaining]);
    expect(saved.lots[0].image_indexes).toEqual([1]);
    expect(saved.deleted_image_indexes).toEqual([]);
    expect(saved.deleted_image_urls).toEqual([selected]);
    expect(saved.lots[1]).toMatchObject(secondLot);
    view.unmount();
    render(<Component {...props} />);
    await waitFor(() => {
      const sources = [...document.body.querySelectorAll("img")].map((image) => image.getAttribute("src"));
      expect(sources).toContain(remaining);
      expect(sources).toContain(other);
      expect(sources).not.toContain(selected);
      expect(sources).not.toContain(old);
    });
  });
});
