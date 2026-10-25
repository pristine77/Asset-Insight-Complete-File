import {
  AlignmentType,
  HeadingLevel,
  ImageRun,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  BorderStyle,
} from "docx";
import { fetchImageBuffer, goldDivider, toTitleCaseWords } from "./utils.js";
import { getLang, t } from "./i18n.js";

/**
 * Builds the narrative lot view in source order. Each lot's elements remain
 * adjacent in the returned child sequence, but Word may still split the block
 * across pages because pagination is applied after document serialization.
 */
function formatMoneyStrict(input: any, ccy: string): string {
  try {
    let n: number | null = null;
    if (typeof input === "number" && Number.isFinite(input)) n = input;
    else if (typeof input === "string") {
      const cleaned = input.replace(/[^0-9.\-]/g, "");
      if (cleaned) {
        const parsed = Number(cleaned);
        if (Number.isFinite(parsed)) n = parsed;
      }
    }
    if (n === null) return String(input || "—");
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: ccy || "CAD",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return String(input || "—");
  }
}

export async function buildAssetLots(
  reportData: any,
  rootImageUrls: string[],
  contentWidthTw: number,
  headingLabel: string = "Lots"
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const lang = getLang(reportData);
  const tr = t(lang);
  const heading = !headingLabel || headingLabel === "Lots" ? tr.lotsWord : headingLabel;
  const ccy = String((reportData as any)?.currency || 'CAD');

  if (!lots.length) return children;

  // Section header
  children.push(
    new Paragraph({
      text: heading,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { before: 200, after: 200 },
    })
  );
  children.push(goldDivider());

  // Four fixed columns are the image budget for each grid row. The cell width is
  // derived from printable width so grids do not cross the section margins.
  const imgCellMargins = { top: 60, bottom: 60, left: 60, right: 60 };
  const gridCols = 4;
  const cellW = Math.round(contentWidthTw / gridCols);

  for (const lot of lots) {
    // Lot title
    const titlePieces: TextRun[] = [];
    const lotNumber = String(lot?.lot_number || lot?.lot_id || "").trim();
    titlePieces.push(new TextRun({ text: `${tr.lotWord} ${lotNumber}`, bold: true, size: 28, color: "991B1B" }));
    if (lot?.title) {
      titlePieces.push(new TextRun({ text: " — ", color: "9CA3AF" }));
      titlePieces.push(
        new TextRun({ text: toTitleCaseWords(lot.title), bold: true, size: 28, color: "B91C1C" })
      );
    }
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: titlePieces, spacing: { before: 240, after: 120 } }));

    // Badges line
    const badgeRuns: TextRun[] = [];
    if (lot?.condition) {
      badgeRuns.push(new TextRun({ text: `${tr.condition}: `, bold: true, color: "6B7280", size: 20 }));
      badgeRuns.push(new TextRun({ text: toTitleCaseWords(lot.condition), color: "374151", size: 20 }));
      badgeRuns.push(new TextRun({ text: "  •  ", color: "D1D5DB" }));
    }
    if (lot?.estimated_value) {
      badgeRuns.push(new TextRun({ text: `${(tr as any).estValue ? (tr as any).estValue(ccy) : tr.estValueCad}: `, bold: true, color: "6B7280", size: 20 }));
      badgeRuns.push(new TextRun({ text: formatMoneyStrict(lot.estimated_value, ccy), color: "059669", bold: true, size: 22 }));
      if (Array.isArray(lot?.items)) badgeRuns.push(new TextRun({ text: "  •  ", color: "D1D5DB" }));
    }
    if (Array.isArray(lot?.items)) {
      badgeRuns.push(new TextRun({ text: `${tr.itemsWord}: `, bold: true, color: "6B7280", size: 20 }));
      badgeRuns.push(new TextRun({ text: String(lot.items.length), color: "374151", size: 20 }));
    }
    if (badgeRuns.length) children.push(new Paragraph({ children: badgeRuns, spacing: { after: 100 } }));

    // Description
    if (lot?.description)
      children.push(
        new Paragraph({
          children: [new TextRun({ text: toTitleCaseWords(lot.description), color: "374151", size: 22 })],
          spacing: { after: 100 },
        })
      );

    // Details (attributes/specs)
    if (lot?.details)
      children.push(
        new Paragraph({
          children: [new TextRun({ text: toTitleCaseWords(lot.details), color: "4B5563", size: 20 })],
          spacing: { after: 120 },
        })
      );

    // Vehicle Details (structured) if VIN decoded data exists
    const vd: any = (lot as any)?.vinDecoded;
    if (vd) {
      const parts: string[] = [];
      if (vd?.vin) parts.push(`${tr.vinLabel}: ${vd.vin}`);
      const ymmt: string[] = [];
      if (vd?.year) ymmt.push(`${tr.yearLabel}: ${String(vd.year)}`);
      if (vd?.make) ymmt.push(`${tr.makeLabel}: ${String(vd.make)}`);
      if (vd?.model) ymmt.push(`${tr.modelLabel}: ${String(vd.model)}`);
      if (vd?.trim) ymmt.push(`${tr.trimLabel}: ${String(vd.trim)}`);
      if (ymmt.length) parts.push(ymmt.join(" "));
      const eng = [vd?.engineCylinders ? `${vd.engineCylinders} ${tr.cylAbbrev}` : undefined, vd?.displacementL ? `${vd.displacementL}${tr.litersAbbrev}` : undefined]
        .filter(Boolean)
        .join(" ");
      if (eng) parts.push(`${tr.engineLabel}: ${eng}`);
      if (vd?.fuelType) parts.push(`${tr.fuelLabel}: ${vd.fuelType}`);
      if (vd?.driveType) parts.push(`${tr.driveLabel}: ${vd.driveType}`);
      if (vd?.transmission) parts.push(`${tr.transLabel}: ${vd.transmission}`);
      if (parts.length) {
        children.push(new Paragraph({ text: parts.join(" • "), spacing: { after: 80 } }));
      }
    }

    // Prefer preview-resolved URLs, then legacy root indexes, then a single URL.
    // Only one source is selected to avoid duplicating the same evidence.
    let urls: string[] = [];
    if (Array.isArray(lot?.image_urls) && lot.image_urls.length) {
      urls = lot.image_urls.filter(Boolean);
    } else if (Array.isArray(lot?.image_indexes) && lot.image_indexes.length) {
      urls = lot.image_indexes
        .map((i: number) => (Number.isFinite(i) && i >= 0 ? rootImageUrls[i] : undefined))
        .filter(Boolean) as string[];
    } else if (typeof lot?.image_url === "string" && lot.image_url) {
      urls = [lot.image_url];
    }

    if (urls.length) {
      const bufs = await Promise.all(urls.map((u) => fetchImageBuffer(u)));
      const valid: (Buffer | null)[] = bufs;
      const rows: TableRow[] = [];
      for (let i = 0; i < valid.length; i += gridCols) {
        const slice = valid.slice(i, i + gridCols);
        rows.push(
          new TableRow({
            cantSplit: true,
            children: Array.from({ length: gridCols }, (_, col) => {
              const b = slice[col];
              return new TableCell({
                width: { size: cellW, type: WidthType.DXA },
                margins: imgCellMargins,
                children: b
                  ? [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new ImageRun({ data: b as any, transformation: { width: 160, height: 120 } } as any)],
                      }),
                    ]
                  : [new Paragraph({ text: "" })],
              });
            }),
          })
        );
      }

      children.push(
        new Table({
          width: { size: contentWidthTw, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: Array.from({ length: gridCols }).map(() => cellW),
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            left: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            right: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
          },
          rows,
        })
      );
    }

    // Extra images are a separate evidence boundary and render after primary
    // images; merging both sets would lose the distinction made in preview.
    let extraUrls: string[] = [];
    if (Array.isArray(lot?.extra_image_urls) && lot.extra_image_urls.length) {
      extraUrls = lot.extra_image_urls.filter(Boolean);
    } else if (Array.isArray(lot?.extra_image_indexes) && lot.extra_image_indexes.length) {
      extraUrls = lot.extra_image_indexes
        .map((i: number) => (Number.isFinite(i) && i >= 0 ? rootImageUrls[i] : undefined))
        .filter(Boolean) as string[];
    }

    if (extraUrls.length) {
      children.push(new Paragraph({ text: "Additional Images", heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 80 } }));
      
      const extraBufs = await Promise.all(extraUrls.map((u) => fetchImageBuffer(u)));
      const validExtra: (Buffer | null)[] = extraBufs;
      const extraRows: TableRow[] = [];
      for (let i = 0; i < validExtra.length; i += gridCols) {
        const slice = validExtra.slice(i, i + gridCols);
        extraRows.push(
          new TableRow({
            cantSplit: true,
            children: Array.from({ length: gridCols }, (_, col) => {
              const b = slice[col];
              return new TableCell({
                width: { size: cellW, type: WidthType.DXA },
                margins: imgCellMargins,
                children: b
                  ? [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new ImageRun({ data: b as any, transformation: { width: 160, height: 120 } } as any)],
                      }),
                    ]
                  : [new Paragraph({ text: "" })],
              });
            }),
          })
        );
      }

      children.push(
        new Table({
          width: { size: contentWidthTw, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: Array.from({ length: gridCols }).map(() => cellW),
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            left: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            right: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
          },
          rows: extraRows,
        })
      );
    }

    // Spacing between lots
    children.push(new Paragraph({ text: "", spacing: { before: 40, after: 120 } }));
  }

  return children;
}
