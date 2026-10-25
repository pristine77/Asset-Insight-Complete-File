import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProposalValuationExcelButton from "./ProposalValuationExcelButton";

const mocks = vi.hoisted(() => ({
  exportExcel: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  createObjectURL: vi.fn(() => "blob:pv-export"),
  revokeObjectURL: vi.fn(),
}));

vi.mock("@/services/proposalValuation", () => ({
  ProposalValuationService: { exportExcel: mocks.exportExcel },
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

describe("ProposalValuationExcelButton", () => {
  let downloadedFilename = "";

  beforeEach(() => {
    vi.restoreAllMocks();
    downloadedFilename = "";
    mocks.exportExcel.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.createObjectURL.mockClear();
    mocks.revokeObjectURL.mockClear();
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: mocks.createObjectURL,
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: mocks.revokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloadedFilename = this.download;
    });
  });

  it("downloads the server workbook with a safe XLSX fallback and releases its URL", async () => {
    const blob = new Blob(["workbook"]);
    mocks.exportExcel.mockResolvedValue({ blob, filename: undefined });
    const { unmount } = render(
      <ProposalValuationExcelButton
        reportId="report-1"
        title="Fleet / PV: West"
      />
    );

    const button = screen.getByRole("button", {
      name: "Export Fleet / PV: West to Excel",
    });
    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(mocks.exportExcel).toHaveBeenCalledWith("report-1"));
    await waitFor(() => expect(downloadedFilename).toBe("proposal-valuation-Fleet-PV-West.xlsx"));
    expect(mocks.createObjectURL).toHaveBeenCalledWith(blob);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Excel export started: proposal-valuation-Fleet-PV-West.xlsx"
    );

    unmount();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:pv-export");
  });

  it("keeps the control usable and announces a failed export", async () => {
    mocks.exportExcel.mockRejectedValue(new Error("Workbook generation failed."));
    render(
      <ProposalValuationExcelButton reportId="report-2" title="Plant valuation" />
    );

    const button = screen.getByRole("button", {
      name: "Export Plant valuation to Excel",
    });
    fireEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workbook generation failed."
    );
    expect(button).toBeEnabled();
    expect(mocks.toastError).toHaveBeenCalledWith("Workbook generation failed.");
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
  });
});
