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
 * Renders one normalized item per row. Column order and width shares are a
 * layout contract shared with the per-photo variant; changing either can alter
 * pagination, thumbnail size, and reviewers' expected reading order.
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

export async function buildPerItemTable(
  reportData: any,
  rootImageUrls: string[],
  contentWidthTw: number,
  headingLabel: string = "Analyzed Items"
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  const items: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const lang = getLang(reportData);
  const tr = t(lang);
  const heading =
    !headingLabel || headingLabel === "Analyzed Items"
      ? tr.perItemResults
      : headingLabel;
  const ccy = String((reportData as any)?.currency || "CAD");

  if (items.length) {
    children.push(
      new Paragraph({
        text: heading,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { before: 200, after: 200 },
      })
    );
  }

  // Allocate every column from the caller's printable width, then give rounding
  // residue to the image column so the fixed-layout table exactly fits the page.
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
  const cellMargins = { top: 100, bottom: 100, left: 80, right: 80 };

  const header = new TableRow({
    cantSplit: true,
    tableHeader: true,
    children: [
      new TableCell({
        width: { size: w.lot, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "FEE2E2", color: "auto" },
        children: [
          new Paragraph({
            style: "TableSmall",
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: tr.lotId, bold: true, color: "991B1B", size: 20 })],
          }),
        ],
      }),
      new TableCell({
        width: { size: w.title, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "FEE2E2", color: "auto" },
        children: [
          new Paragraph({
            style: "TableSmall",
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: tr.title, bold: true, color: "991B1B", size: 20 })],
          }),
        ],
      }),
      new TableCell({
        width: { size: w.sn, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "FEE2E2", color: "auto" },
        children: [
          new Paragraph({
            style: "TableSmall",
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: tr.serialNoLabel, bold: true, color: "991B1B", size: 20 })],
          }),
        ],
      }),
      new TableCell({
        width: { size: w.desc, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "FEE2E2", color: "auto" },
        children: [
          new Paragraph({
            style: "TableSmall",
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: tr.description, bold: true, color: "991B1B", size: 20 })],
          }),
        ],
      }),
      new TableCell({
        width: { size: w.details, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "FEE2E2", color: "auto" },
        children: [
          new Paragraph({
            style: "TableSmall",
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: tr.detailsCol, bold: true, color: "991B1B", size: 20 })],
          }),
        ],
      }),
      new TableCell({
        width: { size: w.value, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "FEE2E2", color: "auto" },
        children: [
          new Paragraph({
            style: "TableSmall",
            alignment: AlignmentType.CENTER,
            keepLines: true,
            children: [
              new TextRun({
                text: (
                  ((tr as any).estValue
                    ? (tr as any).estValue(ccy)
                    : tr.estValueCad) as string
                ).replace(/ /g, "\u00A0"),
                bold: true,
                color: "991B1B",
                size: 20,
              }),
            ],
          }),
        ],
      }),
      new TableCell({
        width: { size: w.image, type: WidthType.DXA },
        margins: cellMargins,
        verticalAlign: VerticalAlign.CENTER,
        shading: { type: "clear" as any, fill: "FEE2E2", color: "auto" },
        children: [
          new Paragraph({
            style: "TableSmall",
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: tr.image, bold: true, color: "991B1B", size: 20 })],
          }),
        ],
      }),
    ],
  });

  const bodyRows: TableRow[] = [];
  for (const it of items) {
    // Image precedence preserves current preview selections while supporting
    // older index-backed reports. A failed fetch degrades to a readable cell;
    // it must not prevent the remaining report from being generated.
    let imgUrl: string | undefined;
    if (Array.isArray(it?.image_urls) && typeof it.image_urls[0] === "string") {
      imgUrl = it.image_urls[0];
    } else if (typeof it?.image_url === "string" && it.image_url) {
      imgUrl = it.image_url;
    } else if (
      typeof it?.image_local_index === "number" &&
      rootImageUrls?.[it.image_local_index]
    ) {
      imgUrl = rootImageUrls[it.image_local_index];
    } else if (
      typeof it?.image_index === "number" &&
      rootImageUrls?.[it.image_index]
    ) {
      imgUrl = rootImageUrls[it.image_index];
    }
    if (process.env.DEBUG_PER_ITEM === "1") {
      try {
        console.log("[PerItemDebug][docx:perItemTable:row]", {
          lot_id: it?.lot_number || it?.lot_id,
          title: typeof it?.title === "string" ? it.title : undefined,
          chosenUrl: imgUrl,
          image_url: typeof it?.image_url === "string" ? it.image_url : undefined,
          image_urls: Array.isArray(it?.image_urls) ? it.image_urls : undefined,
          image_index: typeof it?.image_index === "number" ? it.image_index : undefined,
          image_indexes: Array.isArray(it?.image_indexes) ? it.image_indexes : undefined,
        });
      } catch {}
    }
    const imgBuf = await fetchImageBuffer(imgUrl);
    const zebra = bodyRows.length % 2 === 1;

    bodyRows.push(
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: w.lot, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra
              ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any)
              : undefined,
            children: [
              new Paragraph({
                style: "TableSmall",
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: String(it?.lot_number || it?.lot_id || "—") })],
              }),
            ],
          }),
          new TableCell({
            width: { size: w.title, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra
              ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any)
              : undefined,
            children: [
              new Paragraph({
                style: "TableSmall",
                children: [
                  new TextRun({ text: toTitleCaseWords(it?.title) || "—", bold: true }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: w.sn, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra
              ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any)
              : undefined,
            children: (() => {
              const out: Paragraph[] = [];
              const serialText = String(it?.serial_no_or_label || "—");
              out.push(
                new Paragraph({ style: "TableSmall", text: serialText })
              );
              const vd: any = (it as any)?.vinDecoded;
              if (vd) {
                const parts: string[] = [];
                if (vd?.vin) parts.push(`${tr.vinLabel}: ${vd.vin}`);
                if (vd?.year) parts.push(`${tr.yearLabel}: ${vd.year}`);
                if (vd?.make) parts.push(`${tr.makeLabel}: ${vd.make}`);
                if (vd?.model) parts.push(`${tr.modelLabel}: ${vd.model}`);
                if (vd?.trim) parts.push(`${tr.trimLabel}: ${vd.trim}`);
                const eng = [
                  vd?.engineCylinders
                    ? `${vd.engineCylinders} ${tr.cylAbbrev}`
                    : undefined,
                  vd?.displacementL
                    ? `${vd.displacementL}${tr.litersAbbrev}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" ");
                if (eng) parts.push(`${tr.engineLabel}: ${eng}`);
                if (vd?.fuelType) parts.push(`${tr.fuelLabel}: ${vd.fuelType}`);
                if (vd?.driveType)
                  parts.push(`${tr.driveLabel}: ${vd.driveType}`);
                if (vd?.transmission)
                  parts.push(`${tr.transLabel}: ${vd.transmission}`);
                if (parts.length) {
                  out.push(
                    new Paragraph({
                      style: "TableSmall",
                      children: [
                        new TextRun({
                          text: parts.join(" • "),
                          color: "374151",
                        }),
                      ],
                    })
                  );
                }
              }
              return out;
            })(),
          }),
          new TableCell({
            width: { size: w.desc, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra
              ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any)
              : undefined,
            children: [
              new Paragraph({
                style: "TableSmall",
                text: toTitleCaseWords(it?.description) || "—",
              }),
            ],
          }),
          new TableCell({
            width: { size: w.details, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra
              ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any)
              : undefined,
            children: [
              new Paragraph({
                style: "TableSmall",
                text: toTitleCaseWords(it?.details ?? it?.condition) || "—",
              }),
            ],
          }),
          new TableCell({
            width: { size: w.value, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra
              ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any)
              : undefined,
            children: [
              new Paragraph({
                style: "TableSmall",
                alignment: AlignmentType.RIGHT,
                keepLines: true,
                text: formatMoneyStrict(
                  (it as any)?.estimated_value,
                  ccy
                ).replace(/ /g, "\u00A0"),
              }),
            ],
          }),
          new TableCell({
            width: { size: w.image, type: WidthType.DXA },
            margins: cellMargins,
            verticalAlign: VerticalAlign.CENTER,
            shading: zebra
              ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any)
              : undefined,
            children: imgBuf
              ? [
                  new Paragraph({
                    style: "TableSmall",
                    alignment: AlignmentType.CENTER,
                    children: [
                      new ImageRun({
                        data: imgBuf as any,
                        transformation: { width: imgPx, height: imgPxH },
                      } as any),
                    ],
                  }),
                ]
              : [
                  new Paragraph({
                    style: "TableSmall",
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        text: tr.noImage,
                        italics: true,
                        color: "6B7280",
                      }),
                    ],
                  }),
                ],
          }),
        ],
      })
    );
  }

  const table = new Table({
    // Header-first row order enables Word to repeat the header across page
    // breaks; body order remains identical to the normalized report order.
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [w.lot, w.title, w.sn, w.desc, w.details, w.value, w.image],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 8, color: "DC2626" },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB" },
      left: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB" },
      right: { style: BorderStyle.SINGLE, size: 6, color: "D1D5DB" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 3, color: "E5E7EB" },
      insideVertical: { style: BorderStyle.SINGLE, size: 3, color: "F3F4F6" },
    },
    rows: [header, ...bodyRows],
  });

  children.push(table);

  return children;
}
