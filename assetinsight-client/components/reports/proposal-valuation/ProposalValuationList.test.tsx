import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProposalValuationList from "./ProposalValuationList";

const mocks = vi.hoisted(() => ({ list: vi.fn(), exportExcel: vi.fn() }));

vi.mock("@/services/proposalValuation", () => ({
  ProposalValuationService: {
    list: mocks.list,
    exportExcel: mocks.exportExcel,
  },
}));

describe("ProposalValuationList", () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([
      {
        reportId: "owned-report",
        title: "Owned valuation",
        contractNo: "PV-100",
        status: "approved",
        role: "owner",
        updatedAt: "2026-08-30T12:00:00.000Z",
        revision: 3,
        participantCount: 4,
        currencyCode: "CAD",
      },
      {
        reportId: "assigned-report",
        title: "Assigned valuation",
        contractNo: "PV-101",
        status: "approved",
        role: "evaluator",
        updatedAt: "2026-08-30T13:00:00.000Z",
        revision: 5,
        participantCount: 2,
        currencyCode: "USD",
      },
    ]);
  });

  it("links owned and assigned reports and offers an Excel export for each", async () => {
    render(<ProposalValuationList />);

    expect(await screen.findByRole("link", { name: /Owned valuation/ })).toHaveAttribute(
      "href",
      "/proposal-valuations/owned-report"
    );
    expect(screen.getByRole("link", { name: /Assigned valuation/ })).toHaveAttribute(
      "href",
      "/proposal-valuations/assigned-report"
    );
    expect(
      screen.getByRole("button", { name: "Export Owned valuation to Excel" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Export Assigned valuation to Excel" })
    ).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByText("evaluator")).toBeInTheDocument();
  });
});
