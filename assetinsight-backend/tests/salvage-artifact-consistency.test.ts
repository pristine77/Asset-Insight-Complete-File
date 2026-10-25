import axios from "axios";
import sharp from "sharp";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({
  close: vi.fn(), content: vi.fn(), pdf: vi.fn(), timeout: vi.fn(),
  scripts: vi.fn(), intercept: vi.fn(), on: vi.fn(), media: vi.fn(),
  viewport: vi.fn(), evaluate: vi.fn(), select: vi.fn(), screenshot: vi.fn(),
}));
vi.mock("puppeteer", () => ({ default: { launch: vi.fn(async () => ({ close: browser.close,
  newPage: async () => ({
    setContent: browser.content, pdf: browser.pdf, setDefaultTimeout: browser.timeout,
    setDefaultNavigationTimeout: browser.timeout, setJavaScriptEnabled: browser.scripts,
    setRequestInterception: browser.intercept, on: browser.on, emulateMediaType: browser.media,
    setViewport: browser.viewport, evaluate: browser.evaluate, $: browser.select,
  }) })) } }));
// This suite verifies the real normalized template and prepared photos. The
// isolated layout suite exercises actual destination parsing and TOC passes.
vi.mock("../src/service/salvagePdfLayout.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/salvagePdfLayout.js")>(),
  renderSalvagePdfWithContents: browser.pdf,
}));

import { generateSalvagePdfFromReport } from "../src/service/salvagePdfService.js";
import { generateSalvageDocx } from "../src/service/docx/salvageDocxBuilder.js";
import { generateSalvageXlsx } from "../src/service/xlsx/salvageXlsxService.js";
import { prepareSalvagePhotos } from "../src/service/salvageImagePreparation.js";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";
import { normalizeSalvageReportData } from "../src/service/salvageReportData.js";
import { salvageReportRowNeedsSplit } from "../src/service/salvageReportSections.js";

vi.mock("../src/service/salvagePdfService.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/salvagePdfService.js")>(),
  renderSalvageDocxCover: vi.fn(async () => Buffer.from("cover-plate-fixture")),
}));

const fixture = () => ({
  language: "en", currency: "EUR", report_date: new Date("2026-09-07T00:00:00Z"),
  file_number: "SALVAGE-LOCAL-054", claim_number: "CLAIM-01", policy_number: "POLICY-01",
  date_received: "2026-09-06", date_of_loss: "2026-09-05", cause_of_loss_summary: "Reported storm impact", appraiser_comments: "Reviewed appraiser notes\nSecond observation",
  appraiser_name: "Fixture Appraiser", appraiser_email: "fixture@example.test", company_name: "Fixture Company", insured_name: "Fixture Insured",
  item_type: "Truck", year: "2010", make: "Ford", item_model: "Reviewed model", vin: "REVIEWED-VIN", item_condition: "Reviewed condition",
  damage_description: "Reviewed damage description", inspection_comments: "Reviewed inspection", is_repairable: "To Be Determined",
  repair_items: [{ name: "Replacement panel", sku: "PN-123", quantity: 2, unit_price: 40.25, line_total: 999, vendor: "Supplier pending", notes: "Verify fit before ordering." }],
  labour_breakdown: [{ task: "Fit panel", hours: 2, rate_per_hour: 30, line_total: 999 }],
  repair_estimate: { shop_supplies: 5, miscellaneous: 0, taxes: 10, less_betterment: 0, total: 999 },
  specialty_data: { client_vehicle: { YEAR: "2010", MODEL: "Reviewed model" }, comparable_1: { YEAR: "2011" }, adjustments: { YEAR: 0 } },
  valuation: { fairMarketValue: "EUR 2500", confidence_level: "Low", summary: "Appraiser verification required." },
  aiExtractedDetails: { item_model: "STALE AI MODEL", vin: "STALE AI VIN", item_condition: "STALE AI CONDITION", damage_description: "STALE AI DAMAGE", repair_estimate: { total: 999 } },
  comparableItems: [{ title: "Comparable one", price: "EUR 4000", link: "https://market.example.test/lot/1", details: { YEAR: "2011" } }],
  imageUrls: Array.from({ length: 30 }, (_, i) => `https://assetinsight.test/photo-${i + 1}.png`),
});

// Handlebars escapes attribute '=' characters as well as '&'; compare the
// effective URL/image value rather than treating valid HTML escaping as data loss.
const attributeValue = (value: string) => value
  .replace(/&#x([\da-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function coverMarkup(html: string): string {
  const cover = html.match(/<section\b[^>]*\bid="cover-page"[^>]*>[\s\S]*?<\/section>/)?.[0];
  expect(cover, "The report must contain its cover section").toBeDefined();
  return cover!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  browser.close.mockResolvedValue(undefined); browser.content.mockResolvedValue(undefined); browser.pdf.mockResolvedValue(Buffer.from("fixture-pdf"));
  browser.select.mockResolvedValue({ screenshot: browser.screenshot });
  browser.screenshot.mockResolvedValue(Buffer.from("opaque-cover-plate"));
  const photo = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#1557ed" } }).png().toBuffer();
  vi.spyOn(axios, "get").mockResolvedValue({ data: photo });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Salvage output consistency", () => {
  it('keeps short evidence rows together while allowing oversized context narratives to paginate', () => {
    expect(salvageReportRowNeedsSplit(['Source ID', 'Source excerpt and date.'])).toBe(false);
    expect(salvageReportRowNeedsSplit(['Scope', 'Long narrative '.repeat(300)])).toBe(true);
  });
  it('preserves long editable context in Word/PDF and split Excel continuation cells', async () => {
    const longText = 'BEGIN-SCOPE ' + 'Recorded evidence remains subject to professional review. '.repeat(90) + ' END-SCOPE';
    const source = { ...fixture(), imageUrls: [], report_context: { scope_of_work: longText } };
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    expect(html).toContain(longText);
    expect(html).toContain('class="allow-split"');
    const xml = new PizZip(await generateSalvageDocx(source)).file('word/document.xml')!.asText();
    expect(xml).toContain(longText);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateSalvageXlsx(source) as any);
    const values: string[] = [];
    workbook.getWorksheet('Assessment')!.eachRow(row => row.eachCell(cell => {
      if (!cell.isMerged || cell.address === cell.master.address) values.push(cell.text);
      expect(row.height).toBeLessThanOrEqual(409);
    }));
    expect(values.join('')).toContain(longText);
  });
  it.each(['en', 'fr', 'es'])("renders canonical enrichment in all %s exports, with references last and no duplicate legacy valuations", async language => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2018, make: 'Ford', model: 'F-150', province: 'ON', effectiveDate: '2026-09-08',
      repairItems: [{ id: 'part-1', description: 'Unsupported panel', quantity: 2, unitPrice: 50 }],
      labourItems: [{ id: 'labour-1', description: 'Unknown labour rate', hours: 2, rate: null }],
      charges: [{ id: 'charge-1', description: 'Documented environmental charge', amount: 35, appraiserReason: 'Owner reviewed the attached supplier charge.' }],
      suppliedReferences: [{ id: 'manual-1', kind: 'appraiser', title: 'Saved supplier evidence', url: 'https://suppliers.example.ca/evidence/1', accessedAt: '2026-09-08', excerpt: 'Retained source excerpt', photoIds: [] }],
    }, generatedAt: '2026-09-08T12:00:00Z' });
    const source = { ...fixture(), language, assessment, imageUrls: ['https://assetinsight.test/photo-1.png'],
      report_context: { scope_of_work: 'Review <original> evidence & document unknowns.', client_comments: 'Preserved client narrative.' },
      report_history: { revision: 3, events: [{ revision: 3, at: '2026-09-08T13:00:00Z', changedFields: ['report_context'] }] },
      report_enrichment: { schemaVersion: 1, sections: [{ id: 'forged', title: 'FORGED CONCLUSION' }] },
    };
    const unchanged = structuredClone(source);
    const normalized = normalizeSalvageReportData(source);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const archive = new PizZip(await generateSalvageDocx(source));
    const xml = archive.file('word/document.xml')!.asText();
    const docText = attributeValue(xml.replace(/<w:br\b[^>]*\/>/g, ' ').replace(/<[^>]+>/g, ''));
    const pdfText = attributeValue(html.replace(/<[^>]+>/g, ' '));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateSalvageXlsx(source) as any);
    const cells: string[] = [];
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => cells.push(cell.text))));
    const xlsxText = cells.join('\n');
    const squashed = (text: string) => text.replace(/\s+/g, ' ').trim();
    for (const section of normalized.report_enrichment.sections) {
      for (const output of [pdfText, docText, xlsxText]) {
        expect(output).toContain(section.title);
        for (const paragraph of section.paragraphs) expect(squashed(output)).toContain(squashed(paragraph));
        for (const table of section.tables) for (const row of table.rows) for (const value of row) {
          if (value) expect(squashed(output)).toContain(squashed(value));
        }
      }
    }
    for (const output of [html, xml, xlsxText]) expect(output).not.toContain('FORGED CONCLUSION');
    expect(html).toContain('Review &lt;original&gt; evidence &amp; document unknowns.');
    expect(html).not.toContain('id="salvage-repair-estimate"');
    expect(html).not.toContain('id="salvage-valuation-summary"');
    expect(html).not.toContain('id="salvage-comparable-listings"');
    expect(html.indexOf('id="salvage-enrichment-executive-summary"')).toBeLessThan(html.indexOf('id="salvage-contact-information"'));
    expect(html.indexOf('id="salvage-enrichment-references"')).toBeGreaterThan(html.indexOf('id="salvage-report-photos"'));
    const referenceTitle = normalized.report_enrichment.sections.find((section: any) => section.id === 'references')!.title;
    expect(xml.lastIndexOf(referenceTitle)).toBeGreaterThan(xml.indexOf('1 / 1'));
    expect(workbook.worksheets.at(-1)!.name).toBe(language === 'fr' ? 'Références' : language === 'es' ? 'Referencias' : 'References');
    const partsName = language === 'fr' ? 'Pièces' : language === 'es' ? 'Piezas' : 'Parts';
    const labourName = language === 'fr' ? 'Main-d’œuvre' : language === 'es' ? 'Mano de obra' : 'Labour';
    expect(workbook.getWorksheet(partsName)!.getCell('F2').value).toBeNull();
    expect(workbook.getWorksheet(labourName.replace('’', "'"))!.getCell('D2').value).toBeNull();
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula))));
    expect(archive.file('word/_rels/document.xml.rels')!.asText()).toContain('https://suppliers.example.ca/evidence/1');
    expect(source).toEqual(unchanged);
  });

  it('retains canonical supported charges and totals as numeric Excel values without recalculation', async () => {
    const reason = 'Appraiser checked this local fixture cost line.';
    const assessment = buildSalvageAssessment({ inputs: { repairItems: [{ description: 'Panel', quantity: 2, unitPrice: 40.25, appraiserReason: reason }],
      labourItems: [{ description: 'Fit', hours: 2, rate: 30, appraiserReason: reason }],
      charges: [{ description: 'Documented charge', amount: 15, appraiserReason: reason }],
    } });
    expect(assessment.repairs.total).toBe(155.5);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateSalvageXlsx({ ...fixture(), assessment, imageUrls: [] }) as any);
    const estimate = workbook.getWorksheet('Repair estimate')!;
    expect(estimate.getCell('B8').value).toBe(155.5);
    expect(estimate.getCell('B9').value).toBe(15);
    expect(workbook.getWorksheet('Parts')!.getCell('F2').value).toBe(80.5);
    expect(workbook.getWorksheet('Labour')!.getCell('D2').value).toBe(60);
  });
  it.each(["en", "fr", "es"])("preserves adjustment explanations and explicit monetary signs in %s", async language => {
    const adjustments = { Explanation: "Minus $350", Reduction: -350, Increase: 350, Unknown: "Unknown - requires inspection", Decimal: "-350.25" };
    const source = { ...fixture(), language, imageUrls: [], specialty_data: {
      client_vehicle: Object.fromEntries(Object.keys(adjustments).map(key => [key, "Subject evidence"])),
      comparable_1: {}, adjustments,
    } };
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const section = html.slice(html.indexOf('id="salvage-specialty-valuation"'), html.indexOf('id="salvage-itemized-parts"'));
    const values = [...section.matchAll(/<td class="numeric">([^<]*)<\/td>/g)].map(match => attributeValue(match[1]!));
    const locale = language === "fr" ? "fr-CA" : language === "es" ? "es-ES" : "en-US";
    const money = (amount: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
    expect(values).toEqual(["Minus $350", money(-350), money(350), "Unknown - requires inspection", money(-350.25)]);
    expect(source.specialty_data.adjustments).toEqual(adjustments);
  });
  it("uses neutral system limitation labels in all artifacts without rewriting saved appraiser text", async () => {
    const source = { ...fixture(), imageUrls: [], estimate_warning: "AI-assisted estimates require appraiser verification. Unknown costs are unavailable, not zero.", appraiser_comments: "Quoted source notes: OpenAI publication; this is saved appraiser text." };
    const unchanged = structuredClone(source);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const xml = new PizZip(await generateSalvageDocx(source)).file("word/document.xml")!.asText();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateSalvageXlsx(source) as any);
    const cells: string[] = [];
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => cells.push(String(cell.value ?? "")))));
    for (const output of [html, xml, cells.join("\n")]) {
      expect(output.includes("AI-assisted estimates")).toBe(false);
      expect(output.includes("estimates require appraiser verification. Unknown costs are unavailable, not zero.")).toBe(true);
      expect(output.includes("Quoted source notes: OpenAI publication")).toBe(true);
    }
    expect(source).toEqual(unchanged);
  });
  it("composites only the cover before PDF pagination and keeps the body free of decorative effects", async () => {
    await generateSalvagePdfFromReport(fixture());
    expect(browser.viewport).toHaveBeenCalledWith({ width: 794, height: 1123, deviceScaleFactor: 2.5 });
    expect(browser.screenshot).toHaveBeenCalledWith({ type: "png", omitBackground: false });
    expect(browser.evaluate).toHaveBeenLastCalledWith(expect.any(Function),
      `data:image/png;base64,${Buffer.from("opaque-cover-plate").toString("base64")}`);
    expect(browser.screenshot.mock.invocationCallOrder[0]).toBeLessThan(browser.pdf.mock.invocationCallOrder[0]);
    const html = browser.content.mock.calls[0][0] as string;
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const bodyRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => !selector!.includes(".cover") && !selector!.includes(":root"));
    for (const [, , rule] of bodyRules) expect(rule).not.toMatch(/gradient\(|box-shadow|filter:|opacity:/);
    expect(html.includes('class="detail-card')).toBe(false);
    expect(html.includes('class="details-table"')).toBe(true);
  });
  it.each([0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 29, 30, 31, 49, 50])("paginates all %i appendix photos in ordered groups of five without placeholders", async (count) => {
    const source = { ...fixture(), imageUrls: Array.from({ length: count }, (_, index) => `https://assetinsight.test/photo-${index + 1}.png`) };
    const unchanged = structuredClone(source);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const pages = [...html.matchAll(/<div class="photo-page"[^>]*>[\s\S]*?(?=<div class="photo-page"|<\/section>)/g)].map(match => match[0]);
    expect(pages).toHaveLength(Math.ceil(count / 5));
    expect(pages.map(page => (page.match(/<figure class="report-photo">/g) || []).length))
      .toEqual(Array.from({ length: Math.ceil(count / 5) }, (_, page) => Math.min(5, count - page * 5)));
    expect(pages.flatMap(page => [...page.matchAll(/alt="Photo (\d+)"/g)].map(match => Number(match[1]))))
      .toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(html.match(/id="salvage-report-photos" data-toc/g)).toHaveLength(1);
    expect(html).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(html).toContain("object-fit: contain");
    expect(source).toEqual(unchanged);
  });

  it("keeps dotted-leader contents free of card backgrounds and shadows", async () => {
    await generateSalvagePdfFromReport({ ...fixture(), imageUrls: [] });
    const html = browser.content.mock.calls[0][0] as string;
    const contentsRules = [...html.matchAll(/#contents-list li\s*\{([^}]+)\}/g)].map(match => match[1]).join(" ");
    expect(contentsRules).not.toMatch(/background:|box-shadow:|border-radius:/);
    expect(html).toMatch(/\.toc-leader\s*\{[^}]*border-bottom: 1pt dotted/);
  });

  it("renders each comparable's own fields compactly and preserves long, zero and escaped values", async () => {
    const note = 'Reviewed evidence & condition <not markup>. '.repeat(8);
    const source = { ...fixture(), imageUrls: [], comparableItems: [
      { title: "First comparable", details: { Year: "2020", Mileage: 0, Notes: note, VIN: "VIN-001" } },
      { title: "Second comparable", details: { Type: "Truck", Transmission: "Automatic", Third: "Odd field" } },
      { title: "Listing without details", price: "Price unavailable", details: {} },
    ] };
    const unchanged = structuredClone(source);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const tables = [...html.matchAll(/<div class="comparable-detail">([\s\S]*?)<\/div>/g)].map(match => match[1]!);
    expect(tables).toHaveLength(2);
    expect(tables[0]).toContain('class="comparable-title">First comparable');
    expect(tables[0]).toContain(">0</td>");
    expect(tables[0]).toContain('<td colspan="3">Reviewed evidence &amp; condition &lt;not markup&gt;');
    expect(tables[0]).toContain('<td colspan="3">VIN-001</td>');
    expect(tables[1]).toContain('<td colspan="3">Odd field</td>');
    expect(tables[1]).not.toContain("VIN");
    expect(tables.join("")).not.toContain("Not Found");
    expect(html).toContain("Listing without details");
    expect(source).toEqual(unchanged);
  });

  it("embeds bundled artwork only on the approved cover, never inner pages or report-supplied artwork", async () => {
    const source = { ...fixture(), imageUrls: [], glass_artwork_url: "https://untrusted.example.test/overlay.png" };
    const unchanged = structuredClone(source);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const asset = await readFile("public/report-artwork/salvage-ruby-glass.png");
    expect(asset.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(asset.length).toBeLessThan(2 * 1024 * 1024);
    expect(html).toContain(`--glass-art: url("data:image/png;base64,${asset.toString("base64")}")`);
    expect(html).not.toContain(source.glass_artwork_url);
    expect(html.includes('class="report-glass-art"')).toBe(false);
    expect(coverMarkup(html)).toContain('<div class="cover-art" aria-hidden="true"></div>');
    const frameHighlight = html.match(/\.cover-photo::after\s*\{([^}]+)\}/)?.[1] || "";
    expect(frameHighlight).toContain("border:");
    // CSS masks can be dropped by print compositing, so highlights must not
    // depend on a full-surface gradient being masked off the actual photograph.
    expect(frameHighlight).not.toMatch(/background\s*:|mask\s*:|filter\s*:/);
    expect(source).toEqual(unchanged);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("PDF renders canonical edits, specialty values, correct row currency and all30 embedded photos without external scripts", async () => {
    const source = fixture();
    expect(await generateSalvagePdfFromReport(source)).toEqual(Buffer.from("fixture-pdf"));
    const html = browser.content.mock.calls[0][0];
    expect(html).toContain("Reviewed damage description");
    expect(html).not.toContain("STALE AI");
    expect(html).toContain("€80.50");
    expect(html).toContain("€155.50");
    expect(html).toContain("Reviewed model");
    expect(html).toContain("Claim Number");
    expect(html).toContain("Policy Number");
    expect(html).not.toContain('class="lg:col-span-2"');
    // The cover may reuse photos; the appendix must still include every input.
    const appendixStart = html.indexOf('id="salvage-report-photos"');
    expect(appendixStart).toBeGreaterThan(-1);
    const appendix = html.slice(appendixStart);
    expect(appendix.match(/<img\b/g)).toHaveLength(30);
    expect(html).not.toContain("cdn.tailwindcss.com");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("<script");
    expect(source.imageUrls[0]).toBe("https://assetinsight.test/photo-1.png");
    expect(browser.scripts).toHaveBeenCalledWith(false);
    expect(browser.intercept).toHaveBeenCalledWith(true);
    expect(browser.media).toHaveBeenCalledWith("print");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("permits embedded renderer assets but blocks all remote page requests", async () => {
    await generateSalvagePdfFromReport({ ...fixture(), imageUrls: [] });
    const onRequest = browser.on.mock.calls.find(([event]) => event === "request")![1];
    for (const url of ["data:image/jpeg;base64,cGhvdG8=", "about:blank"]) {
      const request = { url: () => url, continue: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
      onRequest(request);
      expect(request.continue).toHaveBeenCalledOnce();
      expect(request.abort).not.toHaveBeenCalled();
    }
    for (const url of ["https://example.test/photo.png", "http://127.0.0.1/private", "file:///tmp/secret", "javascript:alert(1)"]) {
      const request = { url: () => url, continue: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
      onRequest(request);
      expect(request.abort).toHaveBeenCalledOnce();
      expect(request.continue).not.toHaveBeenCalled();
    }
  });

  it("keeps every original photo in order while reusing valid saved cover choices", async () => {
    const source = {
      ...fixture(),
      imageUrls: fixture().imageUrls.slice(0, 5),
      cover_image_urls: [fixture().imageUrls[3], "https://unrelated.example.test/photo.png", fixture().imageUrls[3], fixture().imageUrls[1]],
    };
    const unchanged = structuredClone(source);
    const photos = await Promise.all(["#ff0000", "#00ff00", "#0000ff", "#ffcc00", "#cc00ff"].map((color) =>
      sharp({ create: { width: 80, height: 40, channels: 3, background: color } }).png().toBuffer(),
    ));
    vi.mocked(axios.get).mockImplementation(async (url) => {
      const index = source.imageUrls.indexOf(String(url));
      if (index < 0) throw new Error("Unexpected fixture photo URL");
      return { data: photos[index] };
    });
    const expected = (await prepareSalvagePhotos(source.imageUrls))
      .map((photo) => `data:image/jpeg;base64,${photo.buffer.toString("base64")}`);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const appendixStart = html.indexOf('id="salvage-report-photos"');
    expect(appendixStart).toBeGreaterThan(-1);
    const imageSources = (markup: string) => [...markup.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => attributeValue(match[1]!));
    const bodyPhotos = imageSources(html).filter((src) => expected.includes(src!));
    expect(bodyPhotos.slice(0, 3)).toEqual([expected[3], expected[1], expected[0]]);
    expect(imageSources(html.slice(appendixStart))).toEqual(expected);
    expect(source).toEqual(unchanged);
  });

  it.each([0, 1, 2, 3])("renders %i supplied cover photos without placeholders, dropped appendix photos or data mutation", async (photoCount) => {
    const source = { ...fixture(), imageUrls: fixture().imageUrls.slice(0, photoCount) };
    const unchanged = structuredClone(source);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const cover = coverMarkup(html);
    const coverFigures = [...cover.matchAll(/<figure\b[^>]*\bclass="[^"]*\bcover-photo\b[^"]*"[^>]*>[\s\S]*?<\/figure>/g)].map((match) => match[0]);
    expect(coverFigures).toHaveLength(photoCount);
    expect(cover).not.toContain("<figcaption");
    expect(coverFigures.every((figure) => /<img\b[^>]*src="data:image\/jpeg;base64,/.test(figure))).toBe(true);
    const appendixStart = html.indexOf('id="salvage-report-photos"');
    expect(appendixStart).toBeGreaterThan(-1);
    const appendix = html.slice(appendixStart);
    expect(appendix.match(/<img\b/g) || []).toHaveLength(photoCount);
    for (let index = 1; index <= photoCount; index++) {
      expect(coverFigures[index - 1]).toContain(`alt="Photo ${index}"`);
      expect(appendix).toContain(`alt="Photo ${index}"`);
    }
    if (!photoCount) {
      expect(cover).toContain("No photographs supplied");
      expect(appendix).toContain("No photographs supplied");
    }
    expect(source).toEqual(unchanged);
  });

  it("marks only taller-than-wide cover photos as portrait while retaining the complete ordered appendix", async () => {
    const source = { ...fixture(), imageUrls: fixture().imageUrls.slice(0, 3) };
    const unchanged = structuredClone(source);
    const photos = await Promise.all([
      { width: 40, height: 80, background: "#df111b" },
      { width: 80, height: 40, background: "#1557ed" },
      { width: 60, height: 60, background: "#00aa66" },
    ].map((shape) => sharp({ create: { ...shape, channels: 3 } }).png().toBuffer()));
    vi.mocked(axios.get).mockImplementation(async (url) => {
      const index = source.imageUrls.indexOf(String(url));
      if (index < 0) throw new Error("Unexpected fixture photo URL");
      return { data: photos[index] };
    });
    const expected = (await prepareSalvagePhotos(source.imageUrls))
      .map((photo) => `data:image/jpeg;base64,${photo.buffer.toString("base64")}`);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const figures = [...coverMarkup(html).matchAll(/<figure\b[^>]*\bclass="([^"]*\bcover-photo\b[^"]*)"[^>]*>[\s\S]*?<\/figure>/g)];
    expect(figures.map((match) => match[1]!.split(/\s+/).includes("cover-photo-portrait"))).toEqual([true, false, false]);
    expect(figures.map((match) => attributeValue(match[0].match(/\bsrc="([^"]+)"/)![1]!))).toEqual(expected);
    const appendixStart = html.indexOf('id="salvage-report-photos"');
    expect(appendixStart).toBeGreaterThan(-1);
    const appendixSources = [...html.slice(appendixStart).matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)]
      .map((match) => attributeValue(match[1]!));
    expect(appendixSources).toEqual(expected);
    expect(source).toEqual(unchanged);
  });

  it("keeps the cover concise while preserving escaped long metadata in the report body", async () => {
    const source = {
      ...fixture(), imageUrls: [],
      file_number: 'FILE-001 & <team> "review"',
      insured_name: "Example Equipment & Recovery Partnership - Western Operations and Fleet Division",
      appraiser_name: 'Fixture Reviewer <script>alert("review")</script>',
      claim_number: "CLAIM-2026-NORTHWEST-OPERATIONS-2026-000001",
      company_name: "Fixture Company & Regional Asset Services - Appraisal and Recovery Division",
      company_address: "Suite 400, 101 Industrial Recovery Avenue, Long Prairie Municipality, Saskatchewan, Canada",
      item_model: "Extended Cab Heavy-Duty Utility Vehicle with Specialized Recovery Equipment",
    };
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const cover = coverMarkup(html);
    expect(html).not.toContain("<script>");
    expect(cover).not.toContain("<team>");
    expect(html).toContain("&lt;script&gt;");
    const coverText = attributeValue(cover.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
    const bodyText = attributeValue(html.slice(html.indexOf("<main>")).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
    for (const field of ["file_number", "item_model", "year", "make"] as const) {
      expect(coverText.split(source[field])).toHaveLength(2);
    }
    for (const field of ["insured_name", "appraiser_name", "claim_number", "company_name", "company_address"] as const) {
      expect(coverText).not.toContain(source[field]);
      expect(bodyText).toContain(source[field]);
    }
    expect(coverText.split("September 7, 2026")).toHaveLength(2);
    expect(cover).toContain('aria-label="Salvage Report"');
    expect(html).toContain("<title>Salvage Report - ");
    const logos = [...cover.matchAll(/<img\b[^>]*>/g)];
    expect(logos).toHaveLength(1);
    expect(logos[0]![0]).toContain('src="data:image/jpeg;base64,');
    expect(coverText).toMatch(/\bby\b/i);
  });

  it("prints report metadata and valuation once while retaining a complete repair estimate", async () => {
    const source = fixture();
    await generateSalvagePdfFromReport({ ...source, imageUrls: [] });
    const html = browser.content.mock.calls[0][0] as string;
    const mainStart = html.indexOf("<main>");
    expect(mainStart).toBeGreaterThan(-1);
    const body = html.slice(mainStart);
    for (const value of [source.appraiser_name, source.file_number, "September 7, 2026", "€2,500.00"]) {
      expect(body.split(value)).toHaveLength(2);
    }
    expect(body).not.toContain('id="salvage-estimate-composition"');
    expect(body).toContain("Total Labour Hours");
    expect(body).toContain("€155.50");
    expect(body).toContain("Replacement panel");
    expect(body).toContain("Fit panel");
  });

  it("preserves every distinct saved detail when metadata is presented as cards", async () => {
    const sentinels = {
      file_number: "SENTINEL-FILE-2481",
      company_name: 'SENTINEL-COMPANY & <North> "Division"',
      company_address: "SENTINEL-ADDRESS 84 Recovery Avenue, Calgary, Alberta",
      insured_name: "SENTINEL-INSURED Fleet Partnership",
      adjuster_name: "SENTINEL-ADJUSTER Morgan Lee",
      appraiser_name: "SENTINEL-APPRAISER Avery Chen",
      appraiser_phone: "+1 555 010 2481",
      appraiser_email: "sentinel-reviewer@example.test",
      claim_number: "SENTINEL-CLAIM-6172",
      policy_number: "SENTINEL-POLICY-3924",
      reported_loss_type: "SENTINEL-LOSS Storm impact",
      item_type: "SENTINEL-TYPE Utility truck",
      year: "2098",
      make: "SENTINEL-MAKE",
      item_model: "SENTINEL-MODEL Heavy-duty recovery vehicle",
      vin: "SENTINEL-VIN-734819",
      item_condition: "SENTINEL-CONDITION Reviewed condition",
      damage_description: "SENTINEL-DAMAGE Reviewed panel damage",
      inspection_comments: "SENTINEL-INSPECTION Visual inspection only",
      is_repairable: "To Be Determined",
      repair_facility: "SENTINEL-FACILITY & <Specialist> Workshop",
      repair_facility_comments: "SENTINEL-FACILITY-COMMENTS Confirm availability",
      replacement_cost_references: "SENTINEL-REFERENCE Reviewed supplier estimate",
      cause_of_loss_summary: "SENTINEL-CAUSE Reported storm damage",
      appraiser_comments: "SENTINEL-APPRAISER-COMMENTS Verify hidden damage",
      procurement_notes: "SENTINEL-PROCUREMENT Confirm parts lead time",
      safety_concerns: "SENTINEL-SAFETY Isolate damaged wiring",
      assumptions: "SENTINEL-ASSUMPTIONS No dismantling performed",
      priority_level: "SENTINEL-PRIORITY Review before repair",
    };
    const source = {
      ...fixture(), ...sentinels, imageUrls: [],
      report_date: new Date("2026-01-04T00:00:00Z"),
      date_received: "2026-01-03", next_report_due: "2026-01-12", date_of_loss: "2026-01-02",
      actual_cash_value: 7212.25, replacement_cost: 9624.5, recommended_reserve: 1357.75,
      valuation: { fairMarketValue: 8642.5, confidence_level: "Low", summary: "SENTINEL-VALUATION Subject to inspection" },
    };
    const unchanged = structuredClone(source);
    await generateSalvagePdfFromReport(source);
    const html = browser.content.mock.calls[0][0] as string;
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    expect(main).toBeDefined();
    const bodyText = attributeValue(main!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
    for (const [field, value] of Object.entries(sentinels)) {
      expect(bodyText.split(value), `${field} must survive in the report body`).toHaveLength(['reported_loss_type', 'item_condition', 'damage_description'].includes(field) ? 3 : 2);
    }
    for (const date of ["January 4, 2026", "January 3, 2026", "January 12, 2026", "January 2, 2026"]) {
      expect(bodyText.split(date), `${date} must retain its distinct date meaning`).toHaveLength(2);
    }
    for (const value of ["€7,212.25", "€9,624.50", "€1,357.75", "€8,642.50", source.valuation.summary]) {
      expect(bodyText.split(value), `${value} must not be omitted or duplicated`).toHaveLength(2);
    }
    expect(main).not.toContain("<North>");
    expect(main).not.toContain("<Specialist>");
    expect(html).not.toContain("STALE AI");
    expect(source).toEqual(unchanged);
  });

  it("keeps the complete real-template contents anchors unique and in report order", async () => {
    await generateSalvagePdfFromReport({ ...fixture(), imageUrls: [], procurement_notes: "Saved manager review" });
    const html = browser.content.mock.calls[0][0] as string;
    const anchors = [...html.matchAll(/<h2\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((heading) => /\bdata-toc(?:\s|=|>)/.test(heading))
      .map((heading) => heading.match(/\bid="([^"]+)"/)?.[1]);
    expect(anchors).toEqual([
      "salvage-report-summary", "salvage-contact-information", "salvage-report-details",
      "salvage-damage-repair-analysis", "salvage-repair-estimate", "salvage-valuation-summary",
      "salvage-loss-summary", "salvage-comparable-listings", "salvage-comparable-details",
      "salvage-specialty-valuation", "salvage-itemized-parts", "salvage-labour-breakdown",
      "salvage-manager-notes", "salvage-enrichment-assignment-scope", "salvage-enrichment-condition-analysis",
      "salvage-enrichment-repair-provenance", "salvage-enrichment-photo-findings", "salvage-enrichment-review-checklist",
      "salvage-report-photos", "salvage-enrichment-references",
    ]);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(html.indexOf('id="cover-page"')).toBeLessThan(html.indexOf('id="report-contents"'));
    expect(html.indexOf('id="report-contents"')).toBeLessThan(html.indexOf('id="salvage-report-summary"'));
  });

  it.each([
    { language: "fr", locale: "fr-CA", title: "Rapport de récupération", contents: "Table des matières", empty: "Aucune photographie fournie", by: "par" },
    { language: "es", locale: "es-ES", title: "Informe de salvamento", contents: "Índice", empty: "No se proporcionaron fotografías", by: "por" },
  ])("localizes the $language PDF without dropping legitimate zero values", async ({ language, locale, title, contents, empty, by }) => {
    await generateSalvagePdfFromReport({
      ...fixture(), language, imageUrls: [],
      repair_items: [{ name: "Reviewed zero quantity", quantity: 0, unit_price: 40.25, line_total: 999 }],
      labour_breakdown: [], repair_estimate: {},
      valuation: { fairMarketValue: 0, confidence_level: "Low", summary: "Reviewed zero estimate" },
      specialty_data: {}, comparableItems: [],
    });
    const html = browser.content.mock.calls[0][0] as string;
    expect(html).toContain(`<html lang="${language}">`);
    expect(html).toContain(title);
    const cover = coverMarkup(html);
    expect(cover).toContain(`aria-label="${title}"`);
    const heading = cover.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] || "";
    expect(attributeValue(heading.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()).toBe(title);
    expect(attributeValue(cover.replace(/<[^>]*>/g, " "))).toMatch(new RegExp(`\\b${by}\\b`, "i"));
    expect(html).toContain(`<title>${title} - `);
    expect(html).toContain(contents);
    expect(html).toContain(empty);
    expect(html).toContain(new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0));
    expect(html).toContain("Reviewed zero estimate");
    expect(html).toContain("Reviewed zero quantity");
    // An empty specialty comparison must not invent a YEAR row/adjustment.
    expect(html).not.toMatch(/>\s*YEAR\s*</);
  });

  it("escapes saved text and renders only genuine HTTP(S) comparable/vendor links", async () => {
    const unsafe = ["javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/private", "//untrusted.example.test/path"];
    await generateSalvagePdfFromReport({
      ...fixture(), imageUrls: [],
      damage_description: '<script>alert("saved")</script><img src="https://untrusted.example.test/pixel">',
      comparableItems: [
        ...unsafe.map((link, index) => ({ title: `Saved unsafe comparable ${index}`, link, price: "Price unavailable" })),
        { title: "Valid comparable", link: "https://market.example.test/lot/1?currency=EUR&source=fixture", price: "EUR 500" },
      ],
      repair_items: [
        ...unsafe.map((vendor_link, index) => ({ name: `Saved unsafe part ${index}`, vendor_link, quantity: 1, unit_price: 0 })),
        { name: "Valid supplier part", vendor_link: "http://supplier.example.test/part/1", quantity: 1, unit_price: 0 },
      ],
    });
    const html = browser.content.mock.calls[0][0] as string;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<img src="https://untrusted.example.test/pixel">');
    for (const link of unsafe) expect(html).not.toContain(`href="${link}"`);
    expect(html).not.toContain('href=""');
    const links = [...html.matchAll(/\bhref="([^"]*)"/g)].map((match) => attributeValue(match[1]!));
    expect(links).toContain("https://market.example.test/lot/1?currency=EUR&source=fixture");
    expect(links).toContain("http://supplier.example.test/part/1");
    expect(html).toContain("Saved unsafe comparable 0");
    expect(html).toContain("Saved unsafe part 0");
  });

  it("closes the PDF browser after a render error", async () => {
    browser.content.mockRejectedValue(new Error("Deliberate render failure"));
    await expect(generateSalvagePdfFromReport({ ...fixture(), imageUrls: [] })).rejects.toThrow("Failed to generate PDF");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("DOCX retains all30photo placements and current financial/detail values", async () => {
    const buffer = await generateSalvageDocx(fixture());
    const archive = new PizZip(buffer);
    const xml = archive.file("word/document.xml")!.asText();
    expect(xml).toContain("Reviewed condition");
    expect(xml).toContain("REVIEWED-VIN");
    expect(xml).not.toContain("STALE AI");
    expect(xml).toContain("155.50");
    expect(xml).toContain("September 7, 2026");
    expect(xml).toContain("CLAIM-01");
    expect(xml).toContain("POLICY-01");
    expect(xml).toContain("September 5, 2026");
    expect(xml).toContain("Reported storm impact");
    expect(xml).toContain("Reviewed appraiser notes");
    expect(xml).toContain("<w:br/>");
    // Gallery remains all 30 native photos; the shared cover adds its designed
    // plate without inheriting the unrelated asset-report template.
    expect(xml.match(/descr="Salvage report photo \d+"/g)).toHaveLength(30);
    expect(xml).toContain("Salvage cover photo");
    expect(xml).toContain("Salvage Report");
    expect(xml).toContain("Table of Contents");
    expect(xml).toContain('w:anchor="salvage_section_1"');
    expect(xml).not.toContain("TERMS OF REFERENCE");
    expect(xml).toMatch(/<w:pgMar[^>]*w:top="1587"[^>]*w:header="567"/);
    expect(xml).toContain("30 / 30");
  });

  it("XLSX retains existing metadata rows, adds typed auditable repair formulas and all30 original links", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateSalvageXlsx(fixture()));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Details", "Assessment", "Comparables", "Repair estimate", "Parts", "Labour", "Photos", "References"]);
    const details = workbook.getWorksheet("Details")!;
    expect(details.getCell("B2").value).toBeInstanceOf(Date);
    expect(details.getCell("B3").value).toBe("SALVAGE-LOCAL-054");
    expect(details.getCell("B15").value).toBe("Reviewed model");
    expect(workbook.getWorksheet("Parts")!.getCell("F2").value).toMatchObject({ formula: "ROUND(D2*E2,2)", result: 80.5 });
    expect(workbook.getWorksheet("Labour")!.getCell("D2").value).toMatchObject({ formula: "ROUND(B2*C2,2)", result: 60 });
    expect(workbook.getWorksheet("Repair estimate")!.getCell("B8").value).toMatchObject({ formula: "ROUND(SUM(B2:B6)-B7,2)", result: 155.5 });
    const photos = workbook.getWorksheet("Photos")!;
    expect(photos.rowCount).toBe(31);
    expect(photos.getCell("B31").value).toBe("https://assetinsight.test/photo-30.png");
  });

  it("all renderers preserve an explicitly cleared field rather than restoring AI text", async () => {
    const source = { ...fixture(), imageUrls: [], item_condition: "", damage_description: "" };
    await generateSalvagePdfFromReport(source);
    expect(browser.content.mock.calls[0][0]).not.toContain("STALE AI");
    const archive = new PizZip(await generateSalvageDocx(source));
    expect(archive.file("word/document.xml")!.asText()).not.toContain("STALE AI");
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await generateSalvageXlsx(source));
    expect(workbook.getWorksheet("Details")!.getCell("B17").value || "").toBe("");
  });
});
