import { describe, expect, it, vi } from "vitest";
import { Document, Packer } from "docx";
import PizZip from "pizzip";
const ai = vi.hoisted(() => ({ create: vi.fn(async () => ({ choices: [{ message: { content: "Fixture recommendation." } }] })) }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { chat: { completions: ai } } }));
import { buildValuationTable } from "../src/service/docx/builders/valuationTable.js";
import { buildTransmittalLetter } from "../src/service/docx/builders/transmittal.js";
import { buildCertificateOfAppraisal } from "../src/service/docx/builders/certificate.js";

const textOf = async (children: any[]) => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  return new PizZip(bytes).file("word/document.xml")!.asText();
};
const methods = ["FML", "TKV", "OLV", "FLV"].map((method) => ({
  method, fullName: `Saved ${method} name`, value: 100, percentage: 77,
  description: `Saved ${method} description`, saleConditions: "Fixture sale conditions",
  timeline: "Fixture timeline", useCase: "Fixture use case",
}));

describe("Asset selected methods in appraisal sections", () => {
  it("filters stale comparison records before rendering or generating the recommendation", async () => {
    ai.create.mockClear();
    const report = { valuation_methods: ["TKV"], currency: "CAD", valuation_data: { baseFMV: 160, methods } };
    const before = structuredClone(report);
    const xml = await textOf(await buildValuationTable(report));
    expect(xml).toContain("Saved TKV name");
    expect(xml).not.toContain("Base Fair Market Value");
    for (const code of ["FML", "OLV", "FLV"]) expect(xml).not.toContain(`Saved ${code}`);
    expect(ai.create).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(ai.create.mock.calls);
    expect(prompt).toContain("TKV:");
    expect(prompt).not.toContain("OLV:");
    expect(prompt).not.toContain("FLV:");
    expect(report).toEqual(before);
  });

  it("retains the FMV base when Fair Market Value is selected", async () => {
    const xml = await textOf(await buildValuationTable({ valuation_methods: ["FML"],
      valuation_data: { baseFMV: 160, methods } }));
    expect(xml).toContain("Base Fair Market Value");
    expect(xml).toContain("Saved FML name");
    expect(xml).not.toContain("Saved TKV name");
  });

  it("does not generate comparison content for an explicit empty selection", async () => {
    ai.create.mockClear();
    expect(await buildValuationTable({ valuation_methods: [], valuation_data: { baseFMV: 160, methods } })).toEqual([]);
    expect(ai.create).not.toHaveBeenCalled();
  });

  it("renders an honest empty selection instead of default liquidation claims", async () => {
    const report = { client_name: "Fixture Client", valuation_methods: [], include_valuation_summary_in_transmittal: true,
      valuation_data: { baseFMV: 160, methods } };
    const xml = await textOf([
      ...buildTransmittalLetter(report, "October 17, 2026"),
      ...await buildCertificateOfAppraisal(report, 9360, "October 17, 2026"),
    ]);
    expect(xml).toContain("No valuation methods");
    expect(xml).not.toContain("Forced Liquidation Value");
    expect(xml).not.toContain("Orderly Liquidation Value");
    expect(xml).not.toContain("undefined");
    expect(xml).not.toContain("premise of ,");
  });

  it("keeps the certificate clean when the user selected no valuation methods", async () => {
    const xml = await textOf(await buildCertificateOfAppraisal({
      client_name: "Fixture Client",
      valuation_methods: [],
      valuation_data: { baseFMV: 160, methods },
    }, 9360, "October 17, 2026"));

    expect(xml).toContain("Were personally inspected.");
    expect(xml).not.toContain("No valuation methods selected.");
    expect(xml).not.toContain("Fair Market Value");
    expect(xml).not.toContain("Forced Liquidation Value");
    expect(xml).not.toContain("Orderly Liquidation Value");
  });
});
