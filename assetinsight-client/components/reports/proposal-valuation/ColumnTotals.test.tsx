import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { formatColumnTotal, MobileColumnTotals } from "./ColumnTotals";
import { formatMoney, type ProposalValuationColumnTotals } from "./calculations";

it("shows two-decimal currency totals without changing row formatting", () => {
  const totals: ProposalValuationColumnTotals = {
    lotCount: 1,
    evaluators: [{ id: "riley", name: "Riley", total: 24833.333333333 }],
    average: 24833.333333333,
    low: 24800.125,
    high: 25000,
    buyerPremium: 2000,
    totalExpectedGross: 27000.125,
    allocatedValue: 27000.125,
    cleaning: 250.125,
    lienSearch: 50.25,
    videoCost: 100.75,
    lottingFee: 250.125,
    advertising: 250.125,
  };
  render(<MobileColumnTotals totals={totals} currency="USD" />);
  const mobile = screen.getByRole("region", { name: "All-lot valuation totals" });
  expect(within(mobile).getAllByText("US$24,833.33")).toHaveLength(2);
  expect(within(mobile).getByText("US$24,800.13")).toBeInTheDocument();
  expect(within(mobile).getAllByText("US$27,000.13")).toHaveLength(2);
  expect(within(mobile).getByText("Total expected gross")).toBeInTheDocument();
  expect(within(mobile).getByText("Allocated value")).toBeInTheDocument();
  expect(within(mobile).getByText("US$50.25")).toBeInTheDocument();
  expect(within(mobile).getByText("US$100.75")).toBeInTheDocument();
  expect(formatColumnTotal(totals.low, "USD")).toBe("US$24,800.13");
  expect(formatMoney(totals.average, "USD")).toBe("US$24,833");
});
