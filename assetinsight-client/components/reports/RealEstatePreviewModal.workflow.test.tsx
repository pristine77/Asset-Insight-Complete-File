import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RealEstatePreviewModal from "./RealEstatePreviewModal";
import { RealEstateService } from "@/services/realEstate";

vi.mock("@/services/realEstate", () => ({ RealEstateService: { getPreviewData: vi.fn(), updatePreviewData: vi.fn(), submitForApproval: vi.fn(), resubmitReport: vi.fn() } }));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const response = (address = "Farm one") => ({ message: "Preview", data: {
  status: "preview" as const, reportId: "report-1", property_type: "agricultural", language: "en",
  preview_data: { property_details: { address }, farmland_details: { total_title_acres: 100, cultivated_acres: 0, annual_rent_per_acre: 0 } },
  imageUrls: ["https://images.sellsnap.store/existing.jpg"], extraImageUrls: ["https://assetinsight.pro/map.png"],
} });

beforeEach(() => {
  vi.mocked(RealEstateService.getPreviewData).mockReset().mockResolvedValue(response());
  vi.mocked(RealEstateService.updatePreviewData).mockReset().mockResolvedValue({ message: "Saved", data: {} });
  vi.mocked(RealEstateService.submitForApproval).mockReset().mockResolvedValue({ message: "Accepted", data: {} });
  vi.mocked(RealEstateService.resubmitReport).mockReset().mockResolvedValue({ message: "Accepted", data: {} });
});

describe("Real Estate preview compatibility", () => {
  it("shows the saved agricultural calculation independently from manual valuation fields", async () => {
    vi.mocked(RealEstateService.getPreviewData).mockResolvedValue({ ...response(), data: { ...response().data, preview_data: { ...response().data.preview_data,
      farmland_valuation: { fair_market_value_formatted: "CA$140,000", approaches_used: { direct_comparable: false, income_capitalization: true, cost_approach: true } },
    } } });
    render(<RealEstatePreviewModal reportId="report-1" isOpen onClose={vi.fn()} />);
    expect(await screen.findByText("CA$140,000")).toBeVisible();
    expect(screen.getByText("Income Capitalization · Cost Approach")).toBeVisible();
  });

  it.each(["approved", "pending_approval"] as const)("uses resubmit for the loaded %s status even without a caller flag", async (status) => {
    vi.mocked(RealEstateService.getPreviewData).mockResolvedValue({ ...response(), data: { ...response().data, status } });
    render(<RealEstatePreviewModal reportId="report-1" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resubmit for Approval" }));
    await waitFor(() => expect(RealEstateService.resubmitReport).toHaveBeenCalledWith("report-1", undefined));
    expect(RealEstateService.submitForApproval).not.toHaveBeenCalled();
  });

  it("shows agricultural edits, retains zero values and shows legacy main plus new report-only photos", async () => {
    render(<RealEstatePreviewModal reportId="report-1" isOpen onClose={vi.fn()} />);
    await screen.findByDisplayValue("Farm one");
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("0")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "View main photo 1" }).querySelector("img")).toHaveAttribute("src", "https://images.sellsnap.store/existing.jpg");
    fireEvent.click(screen.getByRole("button", { name: "View report-only photo 1" }));
    expect(screen.getByText("Photo 2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close photo viewer" }));
    expect(screen.queryByText("Photo 2 of 2")).not.toBeInTheDocument();
  });

  it("serializes save/submit and prevents closing during save", async () => {
    let resolveSave!: (value: { message: string; data: object }) => void;
    vi.mocked(RealEstateService.updatePreviewData).mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    const onClose = vi.fn();
    render(<RealEstatePreviewModal reportId="report-1" isOpen onClose={onClose} />);
    fireEvent.change(await screen.findByDisplayValue("Farm one"), { target: { value: "Edited farm" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByDisplayValue("Edited farm")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit for Approval" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close panel" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(RealEstateService.updatePreviewData).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSave({ message: "Saved", data: {} }); });
    fireEvent.click(screen.getByRole("button", { name: "Submit for Approval" }));
    await waitFor(() => expect(RealEstateService.submitForApproval).toHaveBeenCalledTimes(1));
  });

  it("ignores stale preview loads after switching report", async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    vi.mocked(RealEstateService.getPreviewData).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const onClose = vi.fn();
    const { rerender } = render(<RealEstatePreviewModal reportId="old" isOpen onClose={onClose} />);
    rerender(<RealEstatePreviewModal reportId="new" isOpen onClose={onClose} />);
    await screen.findByDisplayValue("Farm one");
    await act(async () => { resolveOld(response("Old stale farm")); });
    expect(screen.queryByDisplayValue("Old stale farm")).not.toBeInTheDocument();
  });

  it("keeps editor and actions disabled while server files are generating", async () => {
    vi.mocked(RealEstateService.getPreviewData).mockResolvedValue({ ...response(), data: { ...response().data, files_generating: true } });
    render(<RealEstatePreviewModal reportId="report-1" isOpen onClose={vi.fn()} />);
    expect(await screen.findByDisplayValue("Farm one")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit for Approval" })).toBeDisabled();
  });
});
