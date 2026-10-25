import type { Page, PDFOptions } from "puppeteer";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFString } from "pdf-lib";
import { PUPPETEER_NAVIGATION_TIMEOUT_MS } from "../utils/puppeteerTimeout.js";

type PrintLabels = {
  logoUrl: string;
  title: string;
  fileLabel: string;
  fileNumber: string;
  confidential: string;
  pageLabel: string;
  ofLabel: string;
  coverLabel: string;
  contentsLabel: string;
  language: string;
};

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/** Content reserves print furniture space; the cover owns its branding. */
export function salvagePdfPrintOptions(): PDFOptions {
  return {
    timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: false,
    margin: { top: "28mm", bottom: "22mm", left: "18mm", right: "18mm" },
  };
}

/** Add print furniture without copying report pages or changing link targets.
 * Chromium shapes localized/Unicode text into one small transparent stationery
 * PDF. Embedding those pages preserves the original report's fonts, annotations
 * and named destinations; it also avoids flattening report text into images.
 */
export async function stampSalvagePdfPages(
  page: Page, bytes: Uint8Array, labels: PrintLabels, reportStartPage: number,
): Promise<Buffer> {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages();
  if (!Number.isInteger(reportStartPage) || reportStartPage < 3 || reportStartPage > pages.length) {
    throw new Error("Salvage PDF report start page is invalid.");
  }
  const safe = Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, escapeHtml(value)]));
  const total = pages.length - reportStartPage + 1;
  const sheets = pages.slice(1).map((_, index) => {
    const reportNumber = index + 3 - reportStartPage;
    return `<section class="sheet">
      <header><img src="${safe.logoUrl}" alt="McDougall Auctioneers" />
        <div class="reference"><strong>${safe.title}</strong><div>${safe.fileLabel}: ${safe.fileNumber}</div></div>
      </header>
      <footer><div><strong>McDougall Auctioneers</strong><span class="confidential">${safe.confidential}</span></div>
        ${reportNumber > 0 ? `<div class="page-number">${safe.pageLabel} ${reportNumber} ${safe.ofLabel} ${total}</div>` : ""}
      </footer></section>`;
  }).join("");
  await page.setContent(`<!doctype html><html lang="${safe.language}"><head><meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: transparent; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #62626b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .sheet { position: relative; width: 210mm; height: 297mm; break-after: page; }
      .sheet:last-child { break-after: auto; }
      header, footer { position: absolute; left: 18mm; right: 18mm; display: flex; align-items: center; justify-content: space-between; }
      header { top: 9mm; height: 14mm; padding-bottom: 2mm; border-bottom: 1px solid #df111b; }
      header img { width: 47mm; height: 12mm; object-fit: contain; }
      .reference { max-width: 100mm; text-align: right; line-height: 1.5; }
      .reference strong { color: #b50d15; letter-spacing: 1px; text-transform: uppercase; }
      .reference div { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      footer { bottom: 10mm; height: 8mm; padding-top: 3mm; border-top: 1px solid #df111b; line-height: 1.4; }
      footer strong { color: #303037; }
      .confidential { margin-left: 10px; }
      .page-number { white-space: nowrap; }
    </style></head><body>${sheets}</body></html>`, {
    waitUntil: "load", timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((image) => image.decode()));
  });
  const stationeryBytes = await page.pdf({
    ...salvagePdfPrintOptions(), margin: { top: 0, bottom: 0, left: 0, right: 0 },
    omitBackground: true,
  });
  const stationery = await PDFDocument.load(stationeryBytes);
  if (stationery.getPageCount() !== pages.length - 1) {
    throw new Error("Salvage PDF stationery page count does not match the report.");
  }
  const overlays = await pdf.embedPages(stationery.getPages());
  overlays.forEach((overlay, index) => {
    const target = pages[index + 1]!;
    const { width, height } = target.getSize();
    target.drawPage(overlay, { x: 0, y: 0, width, height });
  });
  // PDF viewers show the same page labels as the report footer, not physical
  // front-matter offsets. No pages are reordered or deleted.
  const pageLabels: PDFObject[] = [];
  for (let index = 0; index < reportStartPage - 1; index++) {
    const label = index === 0 ? labels.coverLabel
      : `${labels.contentsLabel}${reportStartPage > 3 ? ` ${index}` : ""}`;
    pageLabels.push(pdf.context.obj(index), pdf.context.obj({ P: PDFHexString.fromText(label) }));
  }
  pageLabels.push(pdf.context.obj(reportStartPage - 1), pdf.context.obj({ S: "D", St: 1 }));
  pdf.catalog.set(PDFName.of("PageLabels"), pdf.context.obj({ Nums: pageLabels }));
  return Buffer.from(await pdf.save());
}

/** Read real printed destinations, never infer page numbers from DOM heights. */
export async function readSalvagePdfDestinationPages(bytes: Uint8Array): Promise<Record<string, number>> {
  const pdf = await PDFDocument.load(bytes);
  const pages = new Map(pdf.getPages().map((page, index) => [page.ref.toString(), index + 1]));
  const result: Record<string, number> = Object.create(null);
  const addDestination = (name: string, value: PDFObject) => {
    const resolved = pdf.context.lookup(value);
    const destination = resolved instanceof PDFDict ? resolved.lookup(PDFName.of("D")) : resolved;
    if (!(destination instanceof PDFArray)) return;
    const page = pages.get(destination.get(0)?.toString());
    if (page) result[name] = page;
  };
  const destinations = pdf.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  destinations?.entries().forEach(([name, destination]) => addDestination(name.decodeText(), destination));

  // Accommodate the PDF name-tree representation as well as Chromium's /Dests.
  const names = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const walkNames = (node: PDFDict, depth = 0): void => {
    if (depth > 8) throw new Error("Salvage PDF contents destination tree is too deep.");
    const entries = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    if (entries) {
      for (let i = 0; i + 1 < entries.size(); i += 2) {
        const key = entries.lookup(i);
        if (key instanceof PDFString || key instanceof PDFHexString) addDestination(key.decodeText(), entries.get(i + 1));
      }
    }
    const children = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (children) for (let i = 0; i < children.size(); i++) walkNames(children.lookup(i, PDFDict), depth + 1);
  };
  const tree = names?.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (tree) walkNames(tree);
  return result;
}

/** Populate linked contents, then resolve and verify their actual printed pages. */
export async function renderSalvagePdfWithContents(page: Page, options: PDFOptions, labels: PrintLabels): Promise<Buffer> {
  const sectionIds = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(async (image) => {
      await image.decode();
      if (!image.naturalWidth) throw new Error("Salvage report image failed to render.");
    }));
    const list = document.getElementById("contents-list");
    if (!list) throw new Error("Salvage report contents container is missing.");
    const headings = Array.from(document.querySelectorAll<HTMLHeadingElement>("h2[data-toc]"));
    const ids = headings.map((heading) => heading.id);
    if (!ids.length || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new Error("Salvage report section anchors must be unique.");
    }
    list.replaceChildren(...headings.map((heading) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.setAttribute("href", `#${heading.id}`);
      const title = document.createElement("span");
      title.className = "toc-title";
      title.textContent = heading.textContent?.trim() || "";
      const leader = document.createElement("span");
      leader.className = "toc-leader";
      leader.setAttribute("aria-hidden", "true");
      const number = document.createElement("span");
      number.className = "toc-page";
      number.dataset.tocPage = heading.id;
      number.textContent = " ";
      link.append(title, leader, number);
      item.append(link);
      return item;
    }));
    return ids;
  });
  if (sectionIds[0] !== "salvage-report-summary") throw new Error("Salvage PDF Report Summary must be the first section.");

  let renderedPages: Record<string, number> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = await page.pdf(options);
    const actualPages = await readSalvagePdfDestinationPages(bytes);
    if (sectionIds.some((id) => !actualPages[id])) throw new Error("Salvage PDF contents could not be resolved.");
    const reportStartPage = actualPages["salvage-report-summary"]!;
    if (reportStartPage < 3 || sectionIds.some((id) => actualPages[id]! < reportStartPage)) {
      throw new Error("Salvage PDF report section order is invalid.");
    }
    if (renderedPages && sectionIds.every((id) => renderedPages![id] === actualPages[id])) {
      return stampSalvagePdfPages(page, bytes, labels, reportStartPage);
    }
    renderedPages = actualPages;
    await page.evaluate((destinations) => {
      document.querySelectorAll<HTMLElement>("[data-toc-page]").forEach((element) => {
        element.textContent = String(destinations[element.dataset.tocPage!]);
      });
    }, Object.fromEntries(sectionIds.map((id) => [id, actualPages[id]! - reportStartPage + 1])));
  }
  throw new Error("Salvage PDF contents pagination did not stabilize.");
}
