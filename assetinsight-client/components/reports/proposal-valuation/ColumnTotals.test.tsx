import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { ColumnTotalsFooter, MobileColumnTotals } from "./ColumnTotals";
import { formatMoney, type ProposalValuationColumnTotals } from "./calculations";

it("shows identical two-decimal currency totals on desktop and mobile without changing row formatting", () => {
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
  render(<><table><ColumnTotalsFooter totals={totals} currency="USD" /></table><MobileColumnTotals totals={totals} currency="USD" /></>);
  const footer = screen.getByRole("rowgroup", { name: "All-lot valuation totals" });
  expect(within(footer).getByLabelText("Riley total for all lots")).toHaveTextContent("US$24,833.33");
  expect(within(footer).getByLabelText("Average total for all lots")).toHaveTextContent("US$24,833.33");
  expect(within(footer).getByLabelText("Low total for all lots")).toHaveTextContent("US$24,800.13");
  expect(within(footer).getByLabelText("Buyer premium total for all lots")).toHaveTextContent("US$2,000.00");
  for (const [label, value] of Object.entries({ "Total expected gross": "US$27,000.13", "Allocated value": "US$27,000.13", Cleaning: "US$250.13", "Lien search": "US$50.25", "Video cost": "US$100.75", "Lotting fee": "US$250.13", Advertising: "US$250.13" })) {
    expect(within(footer).getByLabelText(`${label} total for all lots`)).toHaveTextContent(value);
  }
  const cells = within(footer).getAllByRole("cell", { hidden: true });
  expect(cells.reduce((sum, cell) => sum + Number(cell.getAttribute("colspan") || 1), 1)).toBe(25);
  expect(within(footer).getByLabelText("Allocated value total for all lots").nextElementSibling).toHaveAttribute("aria-hidden", "true");
  const mobile = screen.getByRole("region", { name: "All-lot valuation totals" });
  expect(within(mobile).getAllByText("US$24,833.33")).toHaveLength(2);
  expect(within(mobile).getByText("US$24,800.13")).toBeInTheDocument();
  expect(within(mobile).getAllByText("US$27,000.13")).toHaveLength(2);
  expect(within(mobile).getByText("Total expected gross")).toBeInTheDocument();
  expect(within(mobile).getByText("Allocated value")).toBeInTheDocument();
  expect(within(mobile).getByText("US$50.25")).toBeInTheDocument();
  expect(within(mobile).getByText("US$100.75")).toBeInTheDocument();
  expect(formatMoney(totals.average, "USD")).toBe("US$24,833");
});
