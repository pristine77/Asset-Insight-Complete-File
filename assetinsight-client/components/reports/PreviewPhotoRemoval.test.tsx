import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PreviewModal from "./PreviewModal";
import LotListingPreviewModal from "./LotListingPreviewModal";

vi.mock("@/services/assets", () => ({ getAssetCategorySpecs: vi.fn(async () => ({ categories: [], specs: [] })) }));
vi.mock("@/services/browserLocation", () => ({ BrowserLocationService: { reverseGeocode: vi.fn() } }));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

function fixture(count = 24, shared = false) {
  const urls = Array.from({ length: count + 1 }, (_, i) => `https://media.example.test/photo-${i}.jpg`);
  const lot = (index: number, indexes: number[]) => ({ lot_id: `lot-${index}`, lot_number: String(index), title: `Lot ${index}`, categories: "Equipment", estimated_value: "1000", mixed_group_index: index, sub_mode: "single_lot", image_indexes: indexes, image_urls: indexes.map(i => urls[i]), condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" } });
  return { data: { status: "approved", grouping_mode: "single_lot", imageUrls: urls, preview_data: { contract_no: "PHOTO-QA", client_name: "Photo QA", location: "Regina, Saskatchewan, Canada", currency: "CAD", grouping_mode: "single_lot", valuation_methods: ["FML"], lots: [lot(1, Array.from({ length: count }, (_, i) => i)), lot(2, shared ? [count - 1, count] : [count])] } } };
}

for (const [kind, Component] of [["Asset", PreviewModal], ["Lot", LotListingPreviewModal]] as const) {
  describe(`${kind} expanded photo removal`, () => {
    beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });
    const show = (response = fixture(), save = vi.fn(async (_id: string, data?: any) => ({ message: "Saved", data: { preview_data: data } }))) => {
      const props = { isOpen: true, reportId: "photo-report", onClose: vi.fn(), loadPreviewDataOverride: vi.fn(async () => response), resubmitReportOverride: save };
      return { ...render(<Component {...props} />), props, save };
    };
    const openMore = async () => {
      fireEvent.click((await screen.findAllByRole("button", { name: /Open \d+ more photos/ }))[0]);
      return screen.getByRole("dialog", { name: /^Lot #?1 photos$/ });
    };

    it("cancels removal then removes the exact hidden photo and saves all other lot references", async () => {
      const response = fixture();
      const { save } = show(response);
      const viewer = await openMore();
      const firstHidden = kind === "Asset" ? 6 : 10;
      expect(within(viewer).getByText(`Photo ${firstHidden + 1} of 24`)).toBeInTheDocument();
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      fireEvent.click(within(viewer).getByRole("button", { name: "Remove current photo" }));
      expect(within(viewer).getByText(`Photo ${firstHidden + 1} of 24`)).toBeInTheDocument();
      fireEvent.click(within(viewer).getByRole("button", { name: "Remove current photo" }));
      expect(within(viewer).getByText(`Photo ${firstHidden + 1} of 23`)).toBeInTheDocument();
      expect(within(viewer).getByAltText(`Photo ${firstHidden + 1} of 23`)).toHaveAttribute("src", response.data.imageUrls[firstHidden + 1]);
      expect(save).not.toHaveBeenCalled();
      fireEvent.click(within(viewer).getByRole("button", { name: "Close photo viewer" }));
      fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      const saved = save.mock.calls[0][1];
      expect(saved.deleted_image_indexes).toEqual([firstHidden]);
      expect(saved.deleted_image_urls).toEqual([response.data.imageUrls[firstHidden]]);
      expect(saved.lots[0].image_urls).not.toContain(response.data.imageUrls[firstHidden]);
      expect(saved.lots[1]).toEqual(response.data.preview_data.lots[1]);
    });

    it("keeps a shared last photo in the other lot and moves to the previous remaining photo", async () => {
      const response = fixture(24, true);
      const { save } = show(response);
      const viewer = await openMore();
      fireEvent.keyDown(window, { key: "End" });
      fireEvent.click(within(viewer).getByRole("button", { name: "Remove current photo" }));
      expect(within(viewer).getByText("Photo 23 of 23")).toBeInTheDocument();
      expect(within(viewer).getByAltText("Photo 23 of 23")).toHaveAttribute("src", response.data.imageUrls[22]);
      fireEvent.click(within(viewer).getByRole("button", { name: "Close photo viewer" }));
      fireEvent.click(screen.getByRole("button", { name: "Save preview" }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      const saved = save.mock.calls[0][1];
      expect(saved.deleted_image_indexes).toEqual([]);
      expect(saved.deleted_image_urls).toEqual([]);
      expect(saved.lots[1].image_urls).toContain(response.data.imageUrls[23]);
    });

    it("disables removal while report files are generating", async () => {
      const response = { data: { ...fixture().data, files_generating: true } };
      show(response);
      const viewer = await openMore();
      expect(within(viewer).getByRole("button", { name: "Remove current photo" })).toBeDisabled();
      fireEvent.click(within(viewer).getByRole("button", { name: "Remove current photo" }));
      expect(window.confirm).not.toHaveBeenCalled();
    });

    it("closes a gallery when its lot is removed so shifted indexes cannot target the next lot", async () => {
      show();
      await openMore();
      fireEvent.click(screen.getAllByRole("button", { name: /^Delete(?: lot 1)?$/ })[0]);
      expect(screen.queryByRole("dialog", { name: /^Lot #?1 photos$/ })).not.toBeInTheDocument();
    });
  });
}
