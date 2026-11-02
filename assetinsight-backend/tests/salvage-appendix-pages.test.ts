import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  getCurrentR2StorageTarget: () => ({ bucketName: "bucket", publicBaseUrl: "https://cdn.example" }),
  uploadBufferToR2: vi.fn(async (_b: Buffer, _t: string, _bucket: string, key: string) => `https://cdn.example/${key}`),
}));
const { drawSalvageAppendixPages } = await import("../src/service/salvageAppendixPages.js");
const { inspectSalvageAppendixFile } = await import("../src/service/salvageAppendixService.js");

// Uploaded appendices (owner, 2026-11-01): PDFs and photos, every page A4.
async function pdf(pages: [number, number][], blank = false) {
  const document = await PDFDocument.create();
  for (const size of pages) {
    const page = document.addPage(size);
    if (!blank) page.drawRectangle({ x: 20, y: 20, width: 100, height: 50 });
  }
  return Buffer.from(await document.save());
}

describe("Salvage appendix files", () => {
  it("accepts a readable PDF and counts its pages", async () => {
    await expect(inspectSalvageAppendixFile({ buffer: await pdf([[612, 792], [792, 612]]), mimetype: "application/pdf" }))
      .resolves.toMatchObject({ kind: "pdf", pageCount: 2 });
  });

  it("refuses a damaged PDF, a very long PDF and other files", async () => {
    await expect(inspectSalvageAppendixFile({ buffer: Buffer.from("%PDF-1.7 broken"), mimetype: "application/pdf" })).rejects.toThrow(/could not be read/);
    await expect(inspectSalvageAppendixFile({ buffer: await pdf(Array.from({ length: 61 }, () => [612, 792] as [number, number])) })).rejects.toThrow(/at most 60/);
    await expect(inspectSalvageAppendixFile({ buffer: Buffer.from("hello"), mimetype: "text/plain" })).rejects.toThrow(/Attach a PDF/);
    await expect(inspectSalvageAppendixFile({ buffer: Buffer.from("not an image"), mimetype: "image/png" })).rejects.toThrow(/could not be read/);
  });

  it("accepts a real photo", async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(inspectSalvageAppendixFile({ buffer: png, mimetype: "image/png" })).resolves.toMatchObject({ kind: "image", pageCount: 1 });
  });
});

describe("Salvage appendix pages", () => {
  it("draws each uploaded page onto its reserved A4 page and keeps the page count", async () => {
    const report = await PDFDocument.create();
    for (let i = 0; i < 4; i++) report.addPage([595.28, 841.89]);
    await drawSalvageAppendixPages(report, await pdf([[612, 792], [792, 612]]), 3);
    const saved = await PDFDocument.load(await report.save());
    expect(saved.getPageCount()).toBe(4);
    expect(saved.getPages().every((page) => Math.round(page.getWidth()) === 595 && Math.round(page.getHeight()) === 842)).toBe(true);
    // The two reserved pages now carry drawn content; the others are untouched.
    const drawn = saved.getPages().map((page) => Boolean(page.node.Contents()));
    expect(drawn.slice(2)).toEqual([true, true]);
  });

  it("leaves a truly blank uploaded page blank instead of failing", async () => {
    const report = await PDFDocument.create();
    for (let i = 0; i < 2; i++) report.addPage([595.28, 841.89]);
    await expect(drawSalvageAppendixPages(report, await pdf([[612, 792], [612, 792]], true), 1)).resolves.toBeUndefined();
  });

  it("refuses when the reserved pages run past the report", async () => {
    const report = await PDFDocument.create();
    report.addPage([595.28, 841.89]);
    await expect(drawSalvageAppendixPages(report, await pdf([[612, 792], [612, 792]]), 1)).rejects.toThrow(/do not match/);
  });
});
