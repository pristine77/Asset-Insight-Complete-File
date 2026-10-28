import { describe, expect, it } from "vitest";
import {
  buildGridColumns,
  cellFormula,
  columnLetter,
  compareCellValues,
  EXPORT_FIRST_DATA_ROW,
  parseCellNumber,
  parseClipboardText,
  toClipboardText,
} from "./gridColumns";

const evaluators = [
  { id: "jay", name: "Jay Francis" },
  { id: "chad", name: "Chad Guay" },
  { id: "femi", name: "Femi John" },
];

describe("Proposal Valuation sheet columns", () => {
  it("uses the exported workbook's column letters, skipping columns not on screen", () => {
    const letters = Object.fromEntries(buildGridColumns(evaluators).map((column) => [column.label, column.letter]));
    // buildDetailColumns in the backend's proposalValuationExcelService.ts, with three evaluators.
    expect(letters).toEqual({
      "Asset ID": "A",
      "Asset Category": "B",
      Year: "C",
      Make: "D",
      Model: "E",
      "Serial Number": "F",
      "Condition (1-5)": "G",
      "Location (City, State/Prov)": "H",
      Pictures: "I",
      "CR Details": "J",
      "Asset Insight": "Q",
      "Jay Francis": "R",
      "Chad Guay": "S",
      "Femi John": "T",
      Average: "U",
      "Low Est. Sale Value ($)": "V",
      "High Est. Sale Value ($)": "W",
      "Buyer Premium %": "X",
      "Buyer Premium ($)": "Y",
      "Total Expected Gross ($)": "Z",
      "Allocated Value ($)": "AA",
      Notes: "AD",
      Cleaning: "AE",
      "Lien Search": "AF",
      "Video Cost": "AG",
      "Lotting Fee": "AH",
      Advertising: "AI",
    });
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(53)).toBe("BA");
  });

  it("shows the same formulas the exported workbook writes", () => {
    const columns = buildGridColumns(evaluators);
    const formula = (label: string) =>
      cellFormula(columns.find((column) => column.label === label)!, columns, EXPORT_FIRST_DATA_ROW, 15);
    expect(formula("Average")).toBe("=IFERROR(AVERAGE(R8:T8),0)");
    expect(formula("Low Est. Sale Value ($)")).toBe('=IF(COUNT(R8:T8)=0,"",MIN(R8:T8))');
    expect(formula("High Est. Sale Value ($)")).toBe('=IF(COUNT(R8:T8)=0,"",MAX(R8:T8))');
    expect(formula("Buyer Premium %")).toBe("15%");
    expect(formula("Buyer Premium ($)")).toBe('=IF(COUNT(R8:T8)=0,"",MIN(U8*X8,2000))');
    expect(formula("Total Expected Gross ($)")).toBe('=IF(COUNT(R8:T8)=0,"",U8+Y8)');
    expect(formula("Allocated Value ($)")).toBe('=IF(COUNT(R8:T8)=0,"",Z8)');
    expect(formula("Cleaning")).toBe('=IF(W8="","",W8*1%)');
    expect(formula("Jay Francis")).toBeNull();
  });

  it("reads numbers the way Excel copies them", () => {
    expect(parseCellNumber("1200")).toEqual({ ok: true, value: 1200 });
    expect(parseCellNumber(" $1,200.50 ")).toEqual({ ok: true, value: 1200.5 });
    expect(parseCellNumber("CA$18,000")).toEqual({ ok: true, value: 18000 });
    expect(parseCellNumber("US$9,500.00")).toEqual({ ok: true, value: 9500 });
    expect(parseCellNumber("(250)")).toEqual({ ok: true, value: -250 });
    expect(parseCellNumber("-$40")).toEqual({ ok: true, value: -40 });
    expect(parseCellNumber("")).toEqual({ ok: true, value: null });
    expect(parseCellNumber("about 1200")).toEqual({ ok: false });
    expect(parseCellNumber("12-00")).toEqual({ ok: false });
    expect(parseCellNumber("(250")).toEqual({ ok: false });
  });

  it("round-trips Excel clipboard text, including quoted cells with tabs and line breaks", () => {
    const text = toClipboardText([
      ["Office desk", 450.004, null],
      ['Desk "A"\tleft', "two\nlines", 0],
    ]);
    expect(text).toBe('Office desk\t450\t\n"Desk ""A""\tleft"\t"two\nlines"\t0');
    expect(parseClipboardText(text)).toEqual([
      ["Office desk", "450", ""],
      ['Desk "A"\tleft', "two\nlines", "0"],
    ]);
    expect(parseClipboardText("1200\r\n1500\r\n")).toEqual([["1200"], ["1500"]]);
  });

  it("sorts blanks last in both directions", () => {
    const values = [300, null, 100, "", 200];
    expect([...values].sort((left, right) => compareCellValues(left, right, "asc"))).toEqual([100, 200, 300, null, ""]);
    expect([...values].sort((left, right) => compareCellValues(left, right, "desc"))).toEqual([300, 200, 100, null, ""]);
    expect(["10", "9", "100"].sort((left, right) => compareCellValues(left, right, "asc"))).toEqual(["9", "10", "100"]);
  });
});
