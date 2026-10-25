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
import { convertInchesToTwip } from "docx";
import { goldDivider, fetchImageBuffer, toTitleCaseWords } from "./utils.js";
import { getLang, t } from "./i18n.js";

/**
 * Builds catalogue lot blocks in report order. Each lot owns its heading,
 * summary badges, and item table, which keeps grouping semantics visible and
 * prevents item rows from different lots being merged during pagination.
 */
export async function buildCatalogueLots(
  reportData: any,
  rootImageUrls: string[],
  contentWidthTw: number
): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const lang = getLang(reportData);
  const tr = t(lang);
  const ccy = String((reportData as any)?.currency || 'CAD');

  if (lots.length) {
    children.push(
      new Paragraph({
        text: tr.assetCatalogue,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { after: 160 },
      })
    );
    children.push(goldDivider());
  }

  for (const lot of lots) {
    children.push(
      new Paragraph({
        text: `${tr.lotWord} ${lot?.lot_number || lot?.lot_id || ""} — ${toTitleCaseWords(lot?.title) || tr.lotWord}`,
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 120 },
      })
    );
    // if (lot?.description)
    //   children.push(
    //     new Paragraph({ text: String(lot.description), spacing: { after: 160 } })
    //   );

    const badges: string[] = [];
    if (lot?.condition) badges.push(`${tr.condition}: ${toTitleCaseWords(lot.condition)}`);
    if (lot?.estimated_value) badges.push(`${(tr as any).estValue ? (tr as any).estValue(ccy) : tr.estValueCad}: ${lot.estimated_value}`);
    if (lot?.items?.length) badges.push(`${tr.itemsWord}: ${lot.items.length}`);
    if (badges.length)
      children.push(new Paragraph({ text: badges.join("  •  "), spacing: { after: 200 } }));

    const items: any[] = Array.isArray(lot?.items) ? lot.items : [];
    if (!items.length) continue;

    // These shares intentionally total the caller's printable width. Fixed DXA
    // columns keep item tables comparable across lots and Word renderers.
    const w = {
      title: Math.round(contentWidthTw * 0.18),
      sn: Math.round(contentWidthTw * 0.1),
      desc: Math.round(contentWidthTw * 0.24),
      details: Math.round(contentWidthTw * 0.18),
      value: Math.round(contentWidthTw * 0.1),
      image: Math.round(contentWidthTw * 0.2),
    };
    const cellMargins = { top: 80, bottom: 80, left: 100, right: 100 };

    const header = new TableRow({
      cantSplit: true,
      children: [
        new TableCell({
          width: { size: w.title, type: WidthType.DXA },
          margins: cellMargins,
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: tr.title, bold: true })],
            }),
          ],
        }),
        new TableCell({
          width: { size: w.sn, type: WidthType.DXA },
          margins: cellMargins,
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: tr.snVin, bold: true })],
            }),
          ],
        }),
        new TableCell({
          width: { size: w.desc, type: WidthType.DXA },
          margins: cellMargins,
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: tr.description, bold: true })],
            }),
          ],
        }),
        new TableCell({
          width: { size: w.details, type: WidthType.DXA },
          margins: cellMargins,
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: tr.condition, bold: true })],
            }),
          ],
        }),
        new TableCell({
          width: { size: w.value, type: WidthType.DXA },
          margins: cellMargins,
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: (tr as any).estValue ? (tr as any).estValue(ccy) : tr.estValueCad, bold: true })],
            }),
          ],
        }),
        new TableCell({
          width: { size: w.image, type: WidthType.DXA },
          margins: cellMargins,
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: "clear" as any, fill: "E5E7EB", color: "auto" },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: tr.image, bold: true })],
            }),
          ],
        }),
      ],
    });

    const bodyRows: TableRow[] = [];
    for (const item of items) {
      // Index-backed images are legacy references into the report-level array;
      // direct URLs are a final fallback. Fetch failure produces a labelled cell.
      let itemImgUrl: string | undefined;
      if (typeof item?.image_local_index === "number" && rootImageUrls?.[item.image_local_index]) {
        itemImgUrl = rootImageUrls[item.image_local_index];
      } else if (typeof item?.image_index === "number" && rootImageUrls?.[item.image_index]) {
        itemImgUrl = rootImageUrls[item.image_index];
      } else if (typeof item?.image_url === "string") {
        itemImgUrl = item.image_url;
      }
      const imgBuf = await fetchImageBuffer(itemImgUrl);
      const zebra = bodyRows.length % 2 === 1;
      bodyRows.push(
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: w.title, type: WidthType.DXA },
              margins: cellMargins,
              verticalAlign: VerticalAlign.CENTER,
              shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
              children: [new Paragraph(toTitleCaseWords(item?.title) || "")],
            }),
            new TableCell({
              width: { size: w.sn, type: WidthType.DXA },
              margins: cellMargins,
              verticalAlign: VerticalAlign.CENTER,
              shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
              children: (() => {
                const out: Paragraph[] = [];
                const top = new Paragraph({ alignment: AlignmentType.CENTER, text: item?.sn_vin ? String(item.sn_vin) : tr.notFound });
                out.push(top);
                const vd: any = (item as any)?.vinDecoded;
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
                  if (parts.length) out.push(new Paragraph({ children: [new TextRun({ text: parts.join(" • "), color: "374151" })] }));
                }
                return out;
              })(),
            }),
            new TableCell({
              width: { size: w.desc, type: WidthType.DXA },
              margins: cellMargins,
              verticalAlign: VerticalAlign.CENTER,
              shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
              children: [new Paragraph(toTitleCaseWords(item?.description) || "—")],
            }),
            new TableCell({
              width: { size: w.details, type: WidthType.DXA },
              margins: cellMargins,
              verticalAlign: VerticalAlign.CENTER,
              shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
              children: [new Paragraph(toTitleCaseWords(item?.condition ?? item?.details) || "—")],
            }),
            new TableCell({
              width: { size: w.value, type: WidthType.DXA },
              margins: cellMargins,
              verticalAlign: VerticalAlign.CENTER,
              shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
              children: [new Paragraph({ alignment: AlignmentType.RIGHT, text: String(item?.estimated_value || "—") })],
            }),
            new TableCell({
              width: { size: w.image, type: WidthType.DXA },
              margins: cellMargins,
              verticalAlign: VerticalAlign.CENTER,
              shading: zebra ? ({ type: "clear", fill: "FAFAFA", color: "auto" } as any) : undefined,
              children: imgBuf
                ? [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new ImageRun({ data: imgBuf as any, transformation: { width: 96, height: 72 } } as any),
                      ],
                    }),
                  ]
                : [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({ text: tr.noImage, italics: true, color: "6B7280" }),
                      ],
                    }),
                  ],
            }),
          ],
        })
      );
    }

    children.push(new Paragraph({ text: "", spacing: { before: 80, after: 60 } }));
    children.push(
      new Table({
        // Header followed by source item order is the catalogue output contract;
        // `cantSplit` above keeps each individual record reviewable as a unit.
        width: { size: contentWidthTw, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        alignment: AlignmentType.LEFT,
        columnWidths: [w.title, w.sn, w.desc, w.details, w.value, w.image],
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
          left: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
          right: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
          insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "F3F4F6" },
        },
        rows: [header, ...bodyRows],
      })
    );
  }

  return children;
}
