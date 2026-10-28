import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proposalValuationColumnTotals } from "./calculations";
import ValuationGrid, { type ValuationGridStatus } from "./ValuationGrid";
import type { ProposalValuationEvaluator, ProposalValuationRow, ProposalValuationSheet } from "./types";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast: toasts }));

const evaluators: ProposalValuationEvaluator[] = [
  { id: "jay", name: "Jay" },
  { id: "femi", name: "Femi" },
];

function makeRow(id: string, values: Record<string, number | null>, category = "Office Equipment"): ProposalValuationRow {
  return {
    lot_id: `lot-${id}`,
    asset_id: id,
    asset_category: category,
    year: "",
    make: "",
    model: "",
    serial_number: "",
    cr_details: `Details for ${id}`,
    condition_score: "3",
    location: "Regina, SK",
    pictures: 0,
    picture_urls: [],
    market_check: {
      comparable_count: "",
      avg_retail_asking_price: "",
      market_saturation: "",
      market_velocity: "",
      regional_demand: "",
      notes: "",
    },
    asset_insight: "",
    evaluator_values: values,
    low_est_sale_value: null,
    high_est_sale_value: null,
    buyer_premium_percent: 15,
    buyer_premium_amount: null,
    total_expected_gross: null,
    allocated_value: null,
    notes: "",
    cleaning: null,
    lien_search: null,
    video_cost: null,
    lotting_fee: null,
    advertising: null,
  };
}

let setRowsFromOutside: (update: (rows: ProposalValuationRow[]) => ProposalValuationRow[]) => void = () => undefined;
let latestStatus: ValuationGridStatus = { selection: "", lots: "" };
const rowChanges = vi.fn();
const evaluatorChanges = vi.fn();

function Harness({
  initial,
  canEditAll = true,
  editableEvaluatorId = null,
}: {
  initial: ProposalValuationRow[];
  canEditAll?: boolean;
  editableEvaluatorId?: string | null;
}) {
  const [rows, setRows] = useState(initial);
  useEffect(() => {
    setRowsFromOutside = setRows;
  }, []);
  const sheet: ProposalValuationSheet = {
    evaluator_columns: evaluators,
    rows,
    file_summary: {
      buyers_premium_basis: "uncapped",
      total_risk_weighted_value: null,
      file_risk_multiplier: null,
      commission_percent_no_guarantee: null,
      offer2_nmg_percent: 0.785,
      capped_threshold_percent: 0.1,
    },
  };
  return (
    <ValuationGrid
      rows={rows}
      allRows={rows}
      evaluators={evaluators}
      currency="CAD"
      canEditAll={canEditAll}
      editableEvaluatorId={editableEvaluatorId}
      totals={proposalValuationColumnTotals(sheet)}
      onRowChange={(lotId, key, value) => {
        rowChanges(lotId, key, value);
        setRows((current) => current.map((row) => (row.lot_id === lotId ? { ...row, [key]: value } : row)));
      }}
      onEvaluatorChange={(lotId, evaluatorId, value) => {
        evaluatorChanges(lotId, evaluatorId, value);
        setRows((current) =>
          current.map((row) =>
            row.lot_id === lotId ? { ...row, evaluator_values: { ...row.evaluator_values, [evaluatorId]: value } } : row
          )
        );
      }}
      onOpenGallery={vi.fn()}
      onStatusChange={(status) => {
        latestStatus = status;
      }}
    />
  );
}

const rowsFixture = () => [
  makeRow("20", { jay: 450, femi: 500 }),
  makeRow("21", { jay: 2200, femi: null }, "Warehouse Equipment"),
  makeRow("22", { jay: 150, femi: 175 }),
];

function grid() {
  return screen.getByRole("grid", { name: "Proposal valuation lots" });
}

function cellOf(label: string) {
  return screen.getByLabelText(label).closest("td") as HTMLElement;
}

function calcCell(assetId: string, header: string) {
  const table = grid();
  const headerCell = within(table).getByRole("columnheader", { name: header });
  const index = Array.from(headerCell.parentElement!.children).indexOf(headerCell);
  const row = Array.from(table.querySelectorAll("tbody tr")).find((candidate) => candidate.children[1]?.textContent === assetId)!;
  return row.children[index] as HTMLElement;
}

function press(key: string, options: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(document.activeElement ?? grid(), { key, ...options });
}

function clipboardEvent(type: "paste" | "copy", text = "") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const data = { getData: vi.fn(() => text), setData: vi.fn() };
  Object.defineProperty(event, "clipboardData", { value: data });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return data;
}

describe("ValuationGrid", () => {
  beforeEach(() => {
    rowChanges.mockReset();
    evaluatorChanges.mockReset();
    toasts.error.mockReset();
    latestStatus = { selection: "", lots: "" };
  });

  it("names the selected cell as the exported workbook does and shows its formula", () => {
    render(<Harness initial={rowsFixture()} />);
    fireEvent.mouseDown(calcCell("21", "Average"), { button: 0 });
    expect(screen.getByLabelText("Selected cell")).toHaveTextContent("T9");
    expect(screen.getByRole("textbox", { name: "Formula bar" })).toHaveValue("=IFERROR(AVERAGE(R9:S9),0)");
    expect(calcCell("21", "Average")).toHaveFocus();

    press("ArrowLeft");
    expect(screen.getByLabelText("Selected cell")).toHaveTextContent("S9");
    expect(screen.getByRole("textbox", { name: "Formula bar" })).toHaveValue("");
    press("ArrowUp");
    expect(screen.getByLabelText("Selected cell")).toHaveTextContent("S8");
    expect(screen.getByRole("textbox", { name: "Formula bar" })).toHaveValue("500");
  });

  it("replaces a value by typing, accepts currency text and moves down on Enter", () => {
    render(<Harness initial={rowsFixture()} />);
    fireEvent.mouseDown(cellOf("Jay valuation for 20"), { button: 0 });
    press("$");
    const editor = screen.getByLabelText("Jay valuation for 20");
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: "$1,250" } });
    press("Enter");

    expect(evaluatorChanges).toHaveBeenCalledWith("lot-20", "jay", 1250);
    expect(screen.getByLabelText("Jay valuation for 20")).toHaveValue("$1,250");
    expect(screen.getByLabelText("Selected cell")).toHaveTextContent("R9");
    expect(calcCell("20", "Average")).toHaveTextContent("$875");
  });

  it("keeps the edit open when a number cell gets text", () => {
    render(<Harness initial={rowsFixture()} />);
    fireEvent.mouseDown(cellOf("Femi valuation for 21"), { button: 0 });
    press("F2");
    fireEvent.change(screen.getByLabelText("Femi valuation for 21"), { target: { value: "about 900" } });
    press("Enter");
    expect(toasts.error).toHaveBeenCalledWith("Enter a number, such as 1200 or $1,200.");
    expect(evaluatorChanges).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Femi valuation for 21")).toHaveFocus();
    press("Escape");
    expect(screen.getByLabelText("Femi valuation for 21")).toHaveValue("");
  });

  it("pastes a block from Excel only into cells the evaluator may edit", () => {
    render(<Harness initial={rowsFixture()} canEditAll={false} editableEvaluatorId="femi" />);
    fireEvent.mouseDown(cellOf("Jay valuation for 20"), { button: 0 });
    clipboardEvent("paste", "999\t$600\r\n888\t700\r\n");

    expect(evaluatorChanges.mock.calls).toEqual([
      ["lot-20", "femi", 600],
      ["lot-21", "femi", 700],
    ]);
    expect(rowChanges).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith("Pasted. 2 locked cells were left unchanged.");
    expect(screen.getByLabelText("Jay valuation for 20")).toBeDisabled();
    expect(screen.getByLabelText("Femi valuation for 21")).toHaveValue("$700");
  });

  it("fills a selected range from one copied value and copies the selection as Excel text", () => {
    render(<Harness initial={rowsFixture()} />);
    fireEvent.mouseDown(cellOf("Femi valuation for 20"), { button: 0 });
    fireEvent.mouseDown(cellOf("Femi valuation for 22"), { button: 0, shiftKey: true });
    clipboardEvent("paste", "300");
    expect(evaluatorChanges.mock.calls).toEqual([
      ["lot-20", "femi", 300],
      ["lot-21", "femi", 300],
      ["lot-22", "femi", 300],
    ]);
    expect(latestStatus.selection).toBe("Average $300.00   Count 3   Sum $900.00");

    press("ArrowLeft", { shiftKey: true });
    const copied = clipboardEvent("copy");
    expect(copied.setData).toHaveBeenCalledWith("text/plain", "450\t300\n2200\t300\n150\t300");
  });

  it("undoes its own edits but leaves a cell another evaluator changed since", () => {
    render(<Harness initial={rowsFixture()} />);
    fireEvent.mouseDown(cellOf("Jay valuation for 20"), { button: 0 });
    fireEvent.mouseDown(cellOf("Jay valuation for 21"), { button: 0, shiftKey: true });
    clipboardEvent("paste", "1000\n2000");
    expect(screen.getByLabelText("Jay valuation for 21")).toHaveValue("$2,000");

    // A live refresh brings another evaluator's newer value for lot 21.
    act(() =>
      setRowsFromOutside((rows) =>
        rows.map((row) => (row.lot_id === "lot-21" ? { ...row, evaluator_values: { ...row.evaluator_values, jay: 2500 } } : row))
      )
    );
    evaluatorChanges.mockReset();
    press("z", { ctrlKey: true });

    expect(evaluatorChanges.mock.calls).toEqual([["lot-20", "jay", 450]]);
    expect(screen.getByLabelText("Jay valuation for 20")).toHaveValue("$450");
    expect(screen.getByLabelText("Jay valuation for 21")).toHaveValue("$2,500");
    expect(toasts.error).toHaveBeenCalledWith("1 cell changed after your edit and was not undone.");
  });

  it("clears a range with Delete and leaves locked cells alone", () => {
    render(<Harness initial={rowsFixture()} />);
    fireEvent.mouseDown(cellOf("Notes for 20"), { button: 0 });
    fireEvent.change(cellOf("Notes for 20").querySelector("input")!, { target: { value: "Check hydraulics" } });
    expect(rowChanges).toHaveBeenCalledWith("lot-20", "notes", "Check hydraulics");
    press("Delete");
    expect(rowChanges).toHaveBeenLastCalledWith("lot-20", "notes", "");
  });

  it("filters to blank values and sorts like Excel without moving rows on edit", () => {
    render(<Harness initial={rowsFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort and filter Femi" }));
    const menu = screen.getByRole("dialog", { name: "Sort and filter Femi" });
    fireEvent.click(within(menu).getByLabelText("(Select all)"));
    fireEvent.click(within(menu).getByLabelText("(Blanks)"));
    fireEvent.click(within(menu).getByRole("button", { name: "OK" }));

    const assetIds = () => Array.from(grid().querySelectorAll("tbody tr")).map((row) => row.children[1]?.textContent);
    expect(assetIds()).toEqual(["21"]);
    expect(latestStatus.lots).toBe("1 of 3 lots shown");
    expect(within(screen.getByRole("rowgroup", { name: "All-lot valuation totals" })).getByText("All 3 lots")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Femi valuation for 21"), { target: { value: "2100" } });
    expect(assetIds()).toEqual(["21"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort and filter Femi" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sort and filter Femi" })).getByRole("button", { name: "Clear filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort and filter Average" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sort and filter Average" })).getByRole("button", { name: "Sort largest to smallest" }));
    expect(assetIds()).toEqual(["21", "20", "22"]);
    expect(latestStatus.lots).toBe("3 lots");
  });

  it("totals every lot in the footer under its own column", () => {
    render(<Harness initial={rowsFixture()} />);
    const footer = screen.getByRole("rowgroup", { name: "All-lot valuation totals" });
    expect(within(footer).getByLabelText("Jay total for all lots")).toHaveTextContent("$2,800.00");
    expect(within(footer).getByLabelText("Femi total for all lots")).toHaveTextContent("$675.00");
    expect(within(footer).getByLabelText("Buyer premium percentages are not summed")).toHaveTextContent("—");
    const header = within(grid()).getByRole("columnheader", { name: "Jay" });
    const index = Array.from(header.parentElement!.children).indexOf(header);
    expect(footer.querySelector("tr")!.children[index]).toHaveAttribute("aria-label", "Jay total for all lots");
  });
});
