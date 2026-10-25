import { AlignmentType, HeadingLevel, ImageRun, Paragraph, Table, TableCell, TableRow, WidthType } from "docx";
import { goldDivider, fetchImageBuffer } from "./utils.js";
import { getLang, t } from "./i18n.js";

/**
 * Selects appendix evidence without repeating grouping-only images, fetches it
 * concurrently, and returns a two-column gallery. The function returns no
 * section when every image is unavailable, keeping the document valid.
 */
export async function buildAppendixPhotoGallery(
  reportData: any,
  rootImageUrls: string[],
  contentWidthTw: number
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  const lang = getLang(reportData);
  const tr = t(lang);
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const grouping: string = String(reportData?.grouping_mode || "");
  const usedSet = new Set<string>();
  const gallery: string[] = [];
  const add = (u?: string) => {
    if (!u) return;
    if (!usedSet.has(u)) {
      usedSet.add(u);
      gallery.push(u);
    }
  };
  if (lots.length) {
    // Lot order is the evidence order. Deduplication is global so a shared image
    // is represented once even when referenced by multiple compatibility fields.
    for (const lot of lots) {
      const sub: string = String((lot as any)?.sub_mode || grouping || "");
      // Always include the primary image used in the table row when present
      if (typeof (lot as any)?.image_url === "string" && (lot as any).image_url) {
        add((lot as any).image_url as string);
      } else if (Array.isArray((lot as any)?.image_indexes) && (lot as any).image_indexes.length) {
        const firstIdx = (lot as any).image_indexes[0];
        const mapped = Number.isFinite(firstIdx) && firstIdx >= 0 ? rootImageUrls[firstIdx] : undefined;
        add(mapped);
      }
      // In single_lot tables, multiple images may be shown; include all declared for that lot
      if (sub === "single_lot") {
        if (Array.isArray((lot as any)?.image_urls) && (lot as any).image_urls.length) {
          for (const u of (lot as any).image_urls as string[]) add(u);
        } else if (Array.isArray((lot as any)?.image_indexes) && (lot as any).image_indexes.length) {
          for (const idx of (lot as any).image_indexes as number[]) {
            const mapped = Number.isFinite(idx) && idx >= 0 ? rootImageUrls[idx] : undefined;
            add(mapped);
          }
        }
      }
      // Intentionally exclude extra_image_* from appendix to avoid duplicates and grouping noise
    }
  } else {
    // Fallback to all unique root images when no lots are present
    for (const u of rootImageUrls) add(u);
  }
  const buffers = await Promise.all(gallery.map((u) => fetchImageBuffer(u)));
  // Promise.all preserves selected order; filtering failures therefore does not
  // reorder surviving evidence or turn one broken URL into a report failure.
  const valid = buffers.filter((b): b is Buffer => !!b);
  if (!valid.length) return children;

  children.push(
    new Paragraph({
      text: tr.appendixPhotos,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());

  const cellMargins = { top: 80, bottom: 80, left: 80, right: 80 } as const;
  const half = Math.round(contentWidthTw / 2);
  const rows: TableRow[] = [];
  // Pairing is the appendix image budget per row. An explicit empty right cell
  // keeps the final odd image aligned to the same fixed two-column grid.
  for (let i = 0; i < valid.length; i += 2) {
    const left = valid[i];
    const right = valid[i + 1];
    rows.push(
      new TableRow({
        children: [
          new TableCell({
            width: { size: half, type: WidthType.DXA },
            margins: cellMargins,
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new ImageRun({ data: left as any, transformation: { width: 288, height: 216 } } as any),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: half, type: WidthType.DXA },
            margins: cellMargins,
            children: right
              ? [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new ImageRun({ data: right as any, transformation: { width: 288, height: 216 } } as any),
                    ],
                  }),
                ]
              : [new Paragraph({ text: "" })],
          }),
        ],
      })
    );
  }

  children.push(
    new Table({ width: { size: contentWidthTw, type: WidthType.DXA }, columnWidths: [half, half], rows })
  );

  return children;
}
