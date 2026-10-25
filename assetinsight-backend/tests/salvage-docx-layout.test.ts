import PizZip from "pizzip";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/service/salvagePdfService.js", () => ({
  renderSalvageDocxCover: vi.fn(async () => Buffer.from("cover-plate-fixture")),
}));

vi.mock("../src/service/salvageImagePreparation.js", () => ({
  prepareSalvagePhotos: vi.fn(async () => []),
}));
import { generateSalvageDocx } from "../src/service/docx/salvageDocxBuilder.js";
import { prepareSalvagePhotos } from "../src/service/salvageImagePreparation.js";
import { renderSalvageDocxCover } from "../src/service/salvagePdfService.js";

afterEach(() => { vi.mocked(prepareSalvagePhotos).mockResolvedValue([]); vi.clearAllMocks(); });

const fixture = (language = "en") => ({
  language, currency: "CAD", file_number: "LOCAL-LAYOUT-01",
  report_date: "2026-09-07", company_name: "Fixture Company", appraiser_name: "Fixture Appraiser",
  item_type: "Truck", item_model: "Saved truck model", year: "2010", vin: "SAVED-VIN",
  damage_description: "Saved damage notes", imageUrls: [],
  repair_items: [{ name: "Saved replacement panel", quantity: 2, unit_price: 1234.5, vendor: "Saved supplier", notes: "Saved part notes" }],
  labour_breakdown: [{ task: "Saved installation task", hours: 4, rate_per_hour: 125, notes: "Saved labour notes" }],
  repair_estimate: { taxes: 0, shop_supplies: 0, miscellaneous: 0, less_betterment: 0 },
  comparableItems: [{ title: "Saved comparable", price: "CAD 8000", link: "https://example.test/1", details: { YEAR: "2011" } }],
  specialty_data: { client_vehicle: { YEAR: "2010" }, comparable_1: { YEAR: "2011" }, adjustments: { YEAR: -150 } },
  valuation: { fairMarketValue: 7000, confidence_level: "Low" },
});
const documentXml = async (data = fixture()) => new PizZip(await generateSalvageDocx(data)).file("word/document.xml")!.asText();

describe("Salvage DOCX layout and navigation", () => {
  it("keeps the designed cover but uses plain headings and logo-only inner-page headers", async () => {
    const zip = new PizZip(await generateSalvageDocx(fixture()));
    const styles = zip.file("word/styles.xml")!.asText();
    for (const id of ["Heading1", "Heading2"]) {
      const matches = [...styles.matchAll(new RegExp(`<w:style[^>]*w:styleId="${id}"[\\s\\S]*?<\\/w:style>`, "g"))];
      expect(matches).toHaveLength(1);
      const style = matches[0]![0];
      expect(style).not.toMatch(/<w:shd|<w:pBdr/);
      expect(style).toContain('<w:color w:val="202126"');
    }
    for (const header of zip.file(/word\/header\d+\.xml/)) {
      expect(header.asText()).not.toContain("behindDoc=");
      expect(header.asText()).not.toContain("stationery");
    }
    const document = zip.file("word/document.xml")!.asText();
    expect(document).toContain("Salvage cover photo composition");
    expect(document.match(/behindDoc="1"/g)).toHaveLength(1);
  });
  it("builds a populated deterministic contents list with one valid link per real heading", async () => {
    const xml = await documentXml();
    const headings = [...xml.matchAll(/<w:p>.*?<w:pStyle w:val="Heading[12]"\/>.*?<\/w:p>/g)].map(match => match[0]);
    const anchors = [...xml.matchAll(/<w:hyperlink[^>]*w:anchor="([^"]+)"/g)].map(match => match[1]);
    const bookmarks = [...xml.matchAll(/<w:bookmarkStart[^>]*w:name="([^"]+)"/g)].map(match => match[1]).filter(name => name !== "salvage_report_end");
    expect(anchors.length).toBeGreaterThan(8);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(anchors).toEqual(bookmarks);
    expect(headings).toHaveLength(anchors.length);
    expect(xml).toContain("Table of Contents");
    expect(xml).toContain('w:pStyle w:val="Contents2"');
    expect(xml.match(/PAGEREF /g)).toHaveLength(anchors.length);
    expect(xml).toContain('w:leader="dot"');
    expect(xml).not.toMatch(/TOC will populate|TERMS OF REFERENCE/);
    // No links to optional sections absent from this saved report.
    expect(xml).not.toContain("Manager Notes");
    expect(xml).not.toContain("Photo appendix");
  });

  it.each([
    ["en", "Table of Contents", "Report Summary", "Cause of Loss"],
    ["fr", "Table des matières", "Résumé du rapport", "Cause du sinistre"],
    ["es", "Tabla de contenido", "Resumen del informe", "Causa del siniestro"],
  ])("localizes actual contents and preserves optional saved text in %s", async (language, title, summary, cause) => {
    const xml = await documentXml({ ...fixture(language), cause_of_loss_summary: "Saved cause of loss", appraiser_comments: "First observation\nSecond observation" } as ReturnType<typeof fixture>);
    expect(xml).toContain(title);
    expect(xml).toContain(summary);
    expect(xml.match(new RegExp(cause, "g"))).toHaveLength(2);
    expect(xml).toContain("Saved cause of loss");
    expect(xml).toContain("Second observation");
    expect(xml).toContain("<w:br/>");
  });

  it("uses fixed printable grids, padded cells, repeated headers and numeric alignment without fixed row heights", async () => {
    const xml = await documentXml();
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(xml.match(/<w:tblHeader\/>/g)).toHaveLength(11);
    expect(xml).toContain('w:color="D9D9D9"');
    expect(xml).toContain('w:fill="EEF0F2"');
    expect(xml).toContain('<w:vAlign w:val="center"/>');
    expect(xml).toContain('<w:top w:type="dxa" w:w="90"/>');
    expect(xml).not.toContain("<w:trHeight");
    for (const grid of xml.matchAll(/<w:tblGrid>(.*?)<\/w:tblGrid>/g)) {
      const widths = [...grid[1].matchAll(/w:w="(\d+)"/g)].map(match => Number(match[1]));
      expect(widths.reduce((total, width) => total + width, 0)).toBe(9865);
    }
    for (const text of ["Saved replacement panel", "Saved part notes", "Saved installation task", "Saved labour notes", "Saved comparable", "SAVED-VIN"]) expect(xml).toContain(text);
    expect(xml).toMatch(/<w:jc w:val="right"\/>[^<]*<\/w:pPr><w:r><w:t[^>]*>\$2,469\.00/);
  });

  it("keeps heading/bookmark registries isolated between simultaneous reports", async () => {
    const [first, second] = await Promise.all([documentXml(), documentXml()]);
    for (const xml of [first, second]) expect(xml).toContain('w:name="salvage_section_1"');
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 29, 30])("retains %i photos in explicit five-photo pages with no empty cells", async count => {
    const photos = Array.from({ length: count }, (_, index) => ({
      buffer: Buffer.from("photo-" + index), width: index % 2 ? 640 : 480, height: index % 2 ? 480 : 640,
      sourceUrl: "https://example.test/" + index,
    }));
    vi.mocked(prepareSalvagePhotos).mockResolvedValue(photos);
    const data = { ...fixture(), imageUrls: photos.map(photo => photo.sourceUrl) };
    const zip = new PizZip(await generateSalvageDocx(data));
    const xml = zip.file("word/document.xml")!.asText();
    const tables = [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/g)].map(match => match[0]).filter(table => table.includes('descr="Salvage report photo '));
    expect(tables.map(table => [...table.matchAll(/descr="Salvage report photo (\d+)"/g)].map(match => Number(match[1]))))
      .toEqual(Array.from({ length: Math.ceil(count / 5) }, (_, page) => Array.from({ length: Math.min(5, count - page * 5) }, (_, index) => page * 5 + index + 1)));
    for (const table of tables) {
      const cells = [...table.matchAll(/<w:tc>.*?<\/w:tc>/g)].map(match => match[0]);
      expect(cells.every(cell => cell.includes('descr="Salvage report photo '))).toBe(true);
      if (cells.length % 2) expect(cells.at(-1)).toContain('<w:gridSpan w:val="2"/>');
    }
    expect(prepareSalvagePhotos).toHaveBeenCalledOnce();
    expect(renderSalvageDocxCover).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: data.imageUrls }), photos);
    expect(xml.match(/<w:sectPr>/g)).toHaveLength(3);
    expect(xml.match(/w:start="1"/g)).toHaveLength(1);
    expect(xml).toContain('w:w="11906" w:h="16838"');
    expect(zip.file(/word\/header\d+\.xml/).some(file => file.asText().includes('Subtle ruby glass stationery'))).toBe(false);
    expect(zip.file(/word\/header\d+\.xml/).some(file => file.asText().includes('Company logo'))).toBe(true);
    expect(zip.file(/word\/footer\d+\.xml/).some(file => file.asText().includes('PAGEREF salvage_report_end'))).toBe(true);
  });

  it("keeps disjoint comparable evidence compact, preserves zero, and never activates unsafe links", async () => {
    const data = { ...fixture(), comparableItems: [
      { title: "One", price: "0", link: "javascript:alert(1)", details: { "Only one": "First evidence", Zero: 0 } },
      { title: "Two", price: "100", link: "https://example.test/2", details: { "Only two": "Second evidence", Notes: "Long observation ".repeat(20) } },
    ] };
    const zip = new PizZip(await generateSalvageDocx(data));
    const xml = zip.file("word/document.xml")!.asText();
    expect(xml.match(/First evidence/g)).toHaveLength(1);
    expect(xml.match(/Second evidence/g)).toHaveLength(1);
    expect(xml).not.toContain("Not Found");
    expect(xml).toContain('<w:gridSpan w:val="3"/>');
    expect(zip.file("word/_rels/document.xml.rels")!.asText()).not.toContain("javascript:");
  });
});
