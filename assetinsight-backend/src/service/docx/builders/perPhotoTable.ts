import {
  AlignmentType,
  BorderStyle,
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
} from "docx";
import { fetchImageBuffer, toTitleCaseWords } from "./utils.js";
import { getLang, t } from "./i18n.js";

/**
 * Renders photo-derived lot rows using the same visual schema as per-item
 * output. The explicit locale inference supports this builder's legacy API,
 * which receives rows and a heading rather than the full report object.
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

export async function buildPerPhotoTable(
  lots: any[],
  rootImageUrls: string[],
  contentWidthTw: number,
  headingLabel: string = "Per Photo Results",
  currency?: string
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  const rows: TableRow[] = [];
  // Prefer the localized heading supplied by the orchestrator; fall back to a
  // row locale, then English. This keeps all labels in one coherent language.
  const inferredLang = (() => {
    const map: Record<string, 'en' | 'fr' | 'es'> = {
      'Per Lot Results': 'en',
      'Per Photo Results': 'en',
      'Résultats par photo': 'fr',
      'Résultats par lot': 'fr',
      'Resultados por foto': 'es',
      'Resultados por lote': 'es',
    };
    const byLabel = map[String(headingLabel || '')];
    if (byLabel) return byLabel;
    const firstLang = (Array.isArray(lots) && lots[0] && (lots[0] as any).language) || undefined;
    return getLang({ language: firstLang });
  })();
  const tr = t(inferredLang as any);
  const heading = headingLabel || tr.perPhotoResults;
  const ccy = String(currency || (lots && lots[0] && (lots[0] as any).currency) || 'CAD');

  if (lots.length) {
    children.push(
      new Paragraph({
        text: heading,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { after: 160 },
      })
    );
  }

  // Width shares mirror `buildPerItemTable`. Rounding residue belongs to the
  // image column so Word receives an exact fixed-layout width sum.
  const widthShares = {
    lot: 9,
    title: 18,
    sn: 12,
    desc: 18,
    details: 14,
    value: 11,
    image: 18,
  } as const;
  const shareTotal = Object.values(widthShares).reduce((sum, value) => sum + value, 0);
  const w = {
    lot: Math.round((contentWidthTw * widthShares.lot) / shareTotal),
    title: Math.round((contentWidthTw * widthShares.title) / shareTotal),
    sn: Math.round((contentWidthTw * widthShares.sn) / shareTotal),
    desc: Math.round((contentWidthTw * widthShares.desc) / shareTotal),
    details: Math.round((contentWidthTw * widthShares.details) / shareTotal),
    value: Math.round((contentWidthTw * widthShares.value) / shareTotal),
    image: 0,
  };
  w.image =
    contentWidthTw -
    (w.lot + w.title + w.sn + w.desc + w.details + w.value);
  const imgPx = Math.max(112, Math.floor((w.image / 1440) * 96));
  const imgPxH = Math.floor((imgPx * 3) / 4);
  const cellMargins = { top: 80, bottom: 80, left: 60, right: 60 };

  const header = new TableRow({
    cantSplit: true,
    tableHeader: true,
    children: [
      new TableCell({
        width: { size: w.lot, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
        children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, children: [new TextRun({ text: tr.lotId, bold: true })] })],
      }),
      new TableCell({
        width: { size: w.title, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
        children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, children: [new TextRun({ text: tr.title, bold: true })] })],
      }),
      new TableCell({
        width: { size: w.sn, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
        children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, children: [new TextRun({ text: tr.serialNoLabel, bold: true })] })],
      }),
      new TableCell({
        width: { size: w.desc, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
        children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, children: [new TextRun({ text: tr.description, bold: true })] })],
      }),
      new TableCell({
        width: { size: w.details, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
        children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, children: [new TextRun({ text: tr.detailsCol, bold: true })] })],
      }),
      new TableCell({
        width: { size: w.value, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
        children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, keepLines: true, children: [new TextRun({ text: (((tr as any).estValue ? (tr as any).estValue(ccy) : tr.estValueCad) as string).replace(/ /g, "\u00A0"), bold: true })] })],
      }),
      new TableCell({
        width: { size: w.image, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
        children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, children: [new TextRun({ text: tr.image, bold: true })] })],
      }),
    ],
  });

  rows.push(header);

  for (const rec of lots) {
    // resolve primary image
    let imgUrl: string | undefined;
    if (typeof rec?.image_index === "number" && rootImageUrls?.[rec.image_index]) {
      imgUrl = rootImageUrls[rec.image_index];
    } else if (Array.isArray(rec?.image_indexes) && rec.image_indexes.length && rootImageUrls?.[rec.image_indexes[0]]) {
      imgUrl = rootImageUrls[rec.image_indexes[0]];
    } else if (typeof rec?.image_url === "string") {
      imgUrl = rec.image_url;
    } else if (Array.isArray(rec?.image_urls) && rec.image_urls.length) {
      imgUrl = rec.image_urls[0];
    }
    const buf = await fetchImageBuffer(imgUrl);

    const desc = toTitleCaseWords(rec?.description);
    const details = toTitleCaseWords(rec?.details);

    // rows[0] is header; compute zebra against body row index so first body row is not shaded
    const zebra = ((rows.length - 1) % 2) === 1;
    rows.push(
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: w.lot, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
            children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(rec?.lot_number || rec?.lot_id || "—") })] })],
          }),
          new TableCell({
            width: { size: w.title, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
            children: [new Paragraph({ style: "TableSmall", children: [new TextRun({ text: toTitleCaseWords(rec?.title) || "—", bold: true })] })],
          }),
          new TableCell({
            width: { size: w.sn, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
            children: (() => {
              const out: Paragraph[] = [];
              out.push(new Paragraph({ style: "TableSmall", text: String(rec?.serial_no_or_label || "—") }));
              const vd: any = (rec as any)?.vinDecoded;
              if (vd) {
                const parts: string[] = [];
                if (vd?.vin) parts.push(`${tr.vinLabel}: ${vd.vin}`);
                if (vd?.year) parts.push(`${tr.yearLabel}: ${vd.year}`);
                if (vd?.make) parts.push(`${tr.makeLabel}: ${vd.make}`);
                if (vd?.model) parts.push(`${tr.modelLabel}: ${vd.model}`);
                if (vd?.trim) parts.push(`${tr.trimLabel}: ${vd.trim}`);
                const eng = [vd?.engineCylinders ? `${vd.engineCylinders} ${tr.cylAbbrev}` : undefined, vd?.displacementL ? `${vd.displacementL}${tr.litersAbbrev}` : undefined]
                  .filter(Boolean)
                  .join(" ");
                if (eng) parts.push(`${tr.engineLabel}: ${eng}`);
                if (vd?.fuelType) parts.push(`${tr.fuelLabel}: ${vd.fuelType}`);
                if (vd?.driveType) parts.push(`${tr.driveLabel}: ${vd.driveType}`);
                if (vd?.transmission) parts.push(`${tr.transLabel}: ${vd.transmission}`);
                if (parts.length) out.push(new Paragraph({ style: "TableSmall", children: [new TextRun({ text: parts.join(" • "), color: "374151" })] }));
              }
              return out;
            })(),
          }),
          new TableCell({
            width: { size: w.desc, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
            children: [new Paragraph({ style: "TableSmall", text: desc || "—" })],
          }),
          new TableCell({
            width: { size: w.details, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
            children: [new Paragraph({ style: "TableSmall", text: details || toTitleCaseWords(rec?.condition) || "—" })]
          }),
          new TableCell({
            width: { size: w.value, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
            children: [new Paragraph({ style: "TableSmall", alignment: AlignmentType.RIGHT, keepLines: true, text: formatMoneyStrict((rec as any)?.estimated_value, ccy).replace(/ /g, "\u00A0") })], // Prevent value wrapping
          }),
          new TableCell({
            width: { size: w.image, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
            children: [
              new Paragraph({
                style: "TableSmall",
                alignment: AlignmentType.CENTER,
                children: buf
                  ? [new ImageRun({ data: buf as any, transformation: { width: imgPx, height: imgPxH } } as any)]
                  : [new TextRun({ text: tr.noImage, italics: true, color: "6B7280" })],
              }),
            ],
          }),
        ],
      })
    );
  }

  if (rows.length > 1) {
    children.push(
      new Table({
        width: { size: contentWidthTw, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        alignment: AlignmentType.LEFT,
        columnWidths: [w.lot, w.title, w.sn, w.desc, w.details, w.value, w.image],
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

  return children;
}
