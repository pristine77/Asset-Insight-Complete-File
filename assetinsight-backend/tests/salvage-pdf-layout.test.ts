import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "pdf-lib";
import type { Page } from "puppeteer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSalvagePdfDestinationPages,
  renderSalvagePdfWithContents,
  salvagePdfPrintOptions,
  stampSalvagePdfPages,
} from "../src/service/salvagePdfLayout.js";

const labels = {
  logoUrl: "data:image/jpeg;base64,bG9nbw==",
  title: "Salvage Report",
  fileLabel: "File Number",
  fileNumber: "LOCAL-001",
  confidential: "Confidential",
  pageLabel: "Page",
  ofLabel: "of",
  coverLabel: "Cover",
  contentsLabel: "Table of Contents",
  language: "en",
};

async function destinationPdf(destinations: Record<string, number>) {
  const pdf = await PDFDocument.create();
  const pages = Array.from({ length: Math.max(1, ...Object.values(destinations)) }, () => pdf.addPage());
  pages.forEach((page) => page.drawRectangle({ x: 20, y: 20, width: 10, height: 10 }));
  const entries = pdf.context.obj({});
  for (const [id, printedPage] of Object.entries(destinations)) {
    entries.set(PDFName.of(id), pdf.context.obj([pages[printedPage - 1]!.ref, "XYZ", 0, 700, null]));
  }
  pdf.catalog.set(PDFName.of("Dests"), entries);
  if (pages.length > 1) pages[1]!.node.set(PDFName.of("Annots"), pdf.context.obj([
    pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], Dest: PDFString.of("salvage-report-summary") })),
    pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [20, 20, 30, 30], A: { S: "URI", URI: PDFString.of("https://market.example.test/lot/1") } })),
  ]));
  return pdf.save();
}

async function stationeryPdf(pageCount: number) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index++) {
    pdf.addPage().drawRectangle({ x: 30, y: 30, width: 5, height: 5 });
  }
  return pdf.save();
}

function pageLabels(pdf: PDFDocument) {
  const entries = pdf.catalog.lookup(PDFName.of("PageLabels"), PDFDict).lookup(PDFName.of("Nums"), PDFArray);
  const result: Array<Record<string, string | number>> = [];
  for (let index = 0; index < entries.size(); index += 2) {
    const entry = entries.lookup(index + 1, PDFDict);
    const value: Record<string, string | number> = { index: entries.lookup(index, PDFNumber).asNumber() };
    const prefix = entry.get(PDFName.of("P"));
    if (prefix instanceof PDFHexString || prefix instanceof PDFString) value.prefix = prefix.decodeText();
    const style = entry.lookupMaybe(PDFName.of("S"), PDFName);
    const start = entry.lookupMaybe(PDFName.of("St"), PDFNumber);
    if (style) value.style = style.decodeText();
    if (start) value.start = start.asNumber();
    result.push(value);
  }
  return result;
}

// Run the real browser callbacks against the small DOM surface they use. These
// are in-memory unit fixtures, not screenshots or a substitute for Chromium QA.
class Element {
  id = "";
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
}

function fakePage(ids = ["salvage-report-summary", "section-photos"]) {
  const headings = ids.map((id, index) => Object.assign(new Element(), {
    id, textContent: index ? "Photographs" : "Summary <saved text>",
  }));
  const list = new Element();
  const image = { decode: vi.fn().mockResolvedValue(undefined), naturalWidth: 640 };
  const document = {
    fonts: { ready: Promise.resolve() },
    images: [image],
    getElementById: vi.fn(() => list as Element | null),
    createElement: () => new Element(),
    querySelectorAll: (selector: string) => selector === "h2[data-toc]"
      ? headings
      : list.children.flatMap((item) => item.children.flatMap((link) => link.children))
        .filter((child) => child.dataset.tocPage),
  };
  vi.stubGlobal("document", document);
  const evaluate = vi.fn(async (callback: (...args: any[]) => unknown, ...args: any[]) => callback(...args));
  const pdf = vi.fn<(...args: any[]) => Promise<Uint8Array>>();
  const content = vi.fn().mockResolvedValue(undefined);
  return { page: { evaluate, pdf, setContent: content } as unknown as Page, evaluate, pdf, content, list, image, document };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Salvage PDF print layout", () => {
  it("reserves A4 print furniture space without automatically stamping the cover", () => {
    const options = salvagePdfPrintOptions();
    expect(options).toMatchObject({
      format: "A4", printBackground: true, displayHeaderFooter: false,
      margin: { top: "28mm", bottom: "22mm", left: "18mm", right: "18mm" },
    });
    expect(options.headerTemplate).toBeUndefined();
    expect(options.footerTemplate).toBeUndefined();
  });

  it("stamps only non-cover pages, escapes localized labels and preserves physical link targets", async () => {
    const { page, pdf, content } = fakePage();
    const input = await destinationPdf({ "salvage-report-summary": 3, "section-photos": 5 });
    const original = await PDFDocument.load(input);
    pdf.mockResolvedValue(await stationeryPdf(4));
    const bytes = await stampSalvagePdfPages(page, input, {
      ...labels, fileNumber: 'FILE-<script>"&', title: "Rapport de récupération", ofLabel: "sur",
      coverLabel: "Couverture", contentsLabel: "Table des matières", language: "fr",
    }, 3);
    const result = await PDFDocument.load(bytes);
    expect(result.getPages().map((p) => p.ref.toString())).toEqual(original.getPages().map((p) => p.ref.toString()));
    expect(result.getPage(0).node.Contents()?.toString()).toBe(original.getPage(0).node.Contents()?.toString());
    for (let index = 1; index < result.getPageCount(); index++) {
      expect(result.getPage(index).node.Contents()?.toString()).not.toBe(original.getPage(index).node.Contents()?.toString());
    }
    expect(await readSalvagePdfDestinationPages(bytes)).toEqual({ "salvage-report-summary": 3, "section-photos": 5 });
    const annotations = result.getPage(1).node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annotations.lookup(0, PDFDict).lookup(PDFName.of("Dest"), PDFString).decodeText()).toBe("salvage-report-summary");
    expect(annotations.lookup(1, PDFDict).lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI"), PDFString).decodeText())
      .toBe("https://market.example.test/lot/1");
    expect(pageLabels(result)).toEqual([
      { index: 0, prefix: "Couverture" }, { index: 1, prefix: "Table des matières" }, { index: 2, style: "D", start: 1 },
    ]);
    const stationery = content.mock.calls[0][0] as string;
    expect(stationery.match(/<section class="sheet">/g)).toHaveLength(4);
    expect(stationery).toContain("FILE-&lt;script&gt;&quot;&amp;");
    expect(stationery).not.toContain("<script>");
    expect(stationery).toContain("Rapport de récupération");
    expect(stationery).toContain(labels.logoUrl);
    expect([...stationery.matchAll(/class="page-number">([^<]+)</g)].map((match) => match[1]))
      .toEqual(["Page 1 sur 3", "Page 2 sur 3", "Page 3 sur 3"]);
    expect(pdf).toHaveBeenCalledWith(expect.objectContaining({ displayHeaderFooter: false, omitBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } }));
  });

  it("labels a multi-page contents separately and starts body numbering at one", async () => {
    const { page, pdf, content } = fakePage();
    pdf.mockResolvedValue(await stationeryPdf(5));
    const result = await PDFDocument.load(await stampSalvagePdfPages(page,
      await destinationPdf({ "salvage-report-summary": 4, "section-photos": 6 }), labels, 4));
    expect(pageLabels(result)).toEqual([
      { index: 0, prefix: "Cover" }, { index: 1, prefix: "Table of Contents 1" },
      { index: 2, prefix: "Table of Contents 2" }, { index: 3, style: "D", start: 1 },
    ]);
    const stationery = content.mock.calls[0][0] as string;
    expect([...stationery.matchAll(/class="page-number">([^<]+)</g)].map((match) => match[1]))
      .toEqual(["Page 1 of 3", "Page 2 of 3", "Page 3 of 3"]);
  });

  it.each([0, 2, 2.5, 6])("rejects an invalid body starting page %s before rendering stationery", async (start) => {
    const { page, content, pdf } = fakePage();
    await expect(stampSalvagePdfPages(page, await destinationPdf({ "salvage-report-summary": 3, "section-photos": 5 }), labels, start))
      .rejects.toThrow("start page is invalid");
    expect(content).not.toHaveBeenCalled();
    expect(pdf).not.toHaveBeenCalled();
  });

  it("rejects incomplete stationery rather than leaving body pages unstamped", async () => {
    const { page, pdf } = fakePage();
    pdf.mockResolvedValue(await stationeryPdf(1));
    await expect(stampSalvagePdfPages(page, await destinationPdf({ "salvage-report-summary": 3 }), labels, 3))
      .rejects.toThrow("stationery page count does not match");
  });

  it("reads actual physical pages from direct and dictionary destinations", async () => {
    const pdf = await PDFDocument.create();
    const first = pdf.addPage();
    pdf.addPage();
    const last = pdf.addPage();
    pdf.catalog.set(PDFName.of("Dests"), pdf.context.obj({
      later: [last.ref, "XYZ", 0, 700, null],
      first: { D: [first.ref, "Fit"] },
      invalid: "not-a-destination",
    }));
    expect(await readSalvagePdfDestinationPages(await pdf.save())).toEqual({ later: 3, first: 1 });
  });

  it("supports nested destination name trees with string and Unicode hex names", async () => {
    const pdf = await PDFDocument.create();
    const first = pdf.addPage();
    const second = pdf.addPage();
    const leaf = pdf.context.obj({ Names: [
      PDFString.of("section-summary"), pdf.context.obj([first.ref, "Fit"]),
      PDFHexString.fromText("section-photographies"), pdf.context.obj({ D: [second.ref, "Fit"] }),
    ] });
    pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({ Dests: { Kids: [pdf.context.register(leaf)] } }));
    expect(await readSalvagePdfDestinationPages(await pdf.save())).toEqual({
      "section-summary": 1, "section-photographies": 2,
    });
  });

  it("rejects excessively deep destination trees instead of traversing indefinitely", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    let child = pdf.context.obj({ Names: [] });
    for (let index = 0; index < 10; index++) child = pdf.context.obj({ Kids: [pdf.context.register(child)] });
    pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({ Dests: child }));
    await expect(readSalvagePdfDestinationPages(await pdf.save())).rejects.toThrow("too deep");
  });

  it("builds relative linked contents from real destinations and stamps only after pagination is verified", async () => {
    const { page, pdf, list, image } = fakePage();
    const destinations = { "salvage-report-summary": 3, "section-photos": 7 };
    const bytes = await destinationPdf(destinations);
    pdf.mockResolvedValueOnce(bytes).mockResolvedValueOnce(bytes).mockResolvedValueOnce(await stationeryPdf(6));
    const options = salvagePdfPrintOptions();
    const result = await renderSalvagePdfWithContents(page, options, labels);
    expect(await readSalvagePdfDestinationPages(result)).toEqual(destinations);
    expect(pdf).toHaveBeenCalledTimes(3);
    expect(pdf).toHaveBeenNthCalledWith(1, options);
    expect(image.decode).toHaveBeenCalledTimes(2);
    expect(list.children.map((item) => item.children[0]!.attributes.href))
      .toEqual(["#salvage-report-summary", "#section-photos"]);
    expect(list.children.map((item) => item.children[0]!.children[0]!.textContent))
      .toEqual(["Summary <saved text>", "Photographs"]);
    expect(list.children.map((item) => item.children[0]!.children[1]!.className)).toEqual(["toc-leader", "toc-leader"]);
    expect(list.children.map((item) => item.children[0]!.children[1]!.attributes["aria-hidden"])).toEqual(["true", "true"]);
    expect(list.children.map((item) => item.children[0]!.children[2]!.textContent)).toEqual(["1", "5"]);
  });

  it("handles a pagination shift caused by contents numbers and verifies the final map", async () => {
    const { page, pdf, list } = fakePage();
    const first = await destinationPdf({ "salvage-report-summary": 3, "section-photos": 7 });
    const destinations = { "salvage-report-summary": 4, "section-photos": 8 };
    const final = await destinationPdf(destinations);
    pdf.mockResolvedValueOnce(first).mockResolvedValueOnce(final).mockResolvedValueOnce(final).mockResolvedValueOnce(await stationeryPdf(7));
    const result = await renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels);
    expect(await readSalvagePdfDestinationPages(result)).toEqual(destinations);
    expect(pdf).toHaveBeenCalledTimes(4);
    expect(list.children.map((item) => item.children[0]!.children[2]!.textContent)).toEqual(["1", "5"]);
  });

  it("does not return a PDF when a required section destination is missing", async () => {
    const { page, pdf } = fakePage();
    pdf.mockResolvedValue(await destinationPdf({ "salvage-report-summary": 3 }));
    await expect(renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels)).rejects.toThrow("could not be resolved");
    expect(pdf).toHaveBeenCalledOnce();
  });

  it("bounds nonconvergent rendering to three passes without publishing inaccurate page numbers", async () => {
    const { page, pdf } = fakePage();
    for (let index = 0; index < 3; index++) {
      pdf.mockResolvedValueOnce(await destinationPdf({ "salvage-report-summary": 3 + index, "section-photos": 7 + index }));
    }
    await expect(renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels)).rejects.toThrow("did not stabilize");
    expect(pdf).toHaveBeenCalledTimes(3);
  });

  it.each([[], ["", "section-photos"], ["section-summary", "section-summary"]])(
    "rejects absent, blank or duplicate section anchors: %j", async (...ids) => {
      const { page, pdf } = fakePage(ids as string[]);
      await expect(renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels)).rejects.toThrow("must be unique");
      expect(pdf).not.toHaveBeenCalled();
    },
  );

  it("rejects missing contents markup before printing", async () => {
    const { page, pdf, document } = fakePage();
    document.getElementById.mockReturnValue(null);
    await expect(renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels)).rejects.toThrow("container is missing");
    expect(pdf).not.toHaveBeenCalled();
  });

  it("waits for decoded photos and rejects an empty rendered photo instead of silently dropping it", async () => {
    const { page, pdf, image } = fakePage();
    image.naturalWidth = 0;
    await expect(renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels)).rejects.toThrow("image failed to render");
    expect(image.decode).toHaveBeenCalledOnce();
    expect(pdf).not.toHaveBeenCalled();
  });

  it("rejects a missing or misplaced Report Summary instead of inventing a numbering origin", async () => {
    const { page, pdf } = fakePage(["section-photos", "salvage-report-summary"]);
    await expect(renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels)).rejects.toThrow("Report Summary must be the first section");
    expect(pdf).not.toHaveBeenCalled();
  });

  it.each([
    { "salvage-report-summary": 2, "section-photos": 3 },
    { "salvage-report-summary": 4, "section-photos": 3 },
  ])("rejects body destinations inside or before front matter: %j", async (destinations) => {
    const { page, pdf } = fakePage();
    pdf.mockResolvedValue(await destinationPdf(destinations));
    await expect(renderSalvagePdfWithContents(page, salvagePdfPrintOptions(), labels)).rejects.toThrow("section order is invalid");
    expect(pdf).toHaveBeenCalledOnce();
  });
});
