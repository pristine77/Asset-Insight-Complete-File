import {
  AlignmentType,
  BorderStyle,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertInchesToTwip,
} from "docx";
import {
  resolveAssetCertificateData,
  resolveSelectedAssetValuationMethods,
} from "./certificate.js";
import { getLang, t } from "./i18n.js";
import { buildSignatureImageParagraph } from "./signature.js";

/**
 * Assembles the transmittal as ordered Word primitives. Recipient, valuation,
 * and signatory resolution happen before layout so optional content cannot
 * disturb the legal/narrative sequence of the letter.
 */
const DEFAULT_FONT = "Times New Roman";

function splitPreparedForLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.toLowerCase();
    if (!line || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildValuationSentence(reportData: any, tr: ReturnType<typeof t>): string {
  // Cap prose at four methods and preserve the central resolver's method order;
  // the certificate, overview, and transmittal must describe the same selection.
  const parts = resolveSelectedAssetValuationMethods(reportData)
    .slice(0, 4)
    .map(
      (method) =>
        `${method.label} ${tr.valuationAt} ${method.formattedValue}`
    );

  if (parts.length === 0) return "No valuation methods selected.";
  if (parts.length === 1) return `${tr.valuationSinglePrefix} ${parts[0]}.`;
  if (parts.length === 2) {
    return `${tr.valuationMultiplePrefix} ${parts[0]} ${tr.valuationAnd} ${parts[1]}.`;
  }
  const lastPart = parts.pop();
  return `${tr.valuationMultiplePrefix} ${parts.join(", ")}, ${
    tr.valuationAnd
  } ${lastPart}.`;
}

export interface TransmittalOptions {
  monochrome?: boolean;
  compact?: boolean;
  font?: string;
}

function run(
  text: string,
  options: {
    font: string;
    bold?: boolean;
    size?: number;
  }
): TextRun {
  return new TextRun({
    text,
    font: options.font,
    size: options.size || 20,
    bold: options.bold,
    color: "111111",
  });
}

function bodyParagraph(
  text: string,
  font: string,
  spacingAfter = 125
): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: spacingAfter, line: 240 },
    children: [run(text, { font })],
  });
}

function noBorders() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    insideHorizontal: {
      style: BorderStyle.NONE,
      size: 0,
      color: "FFFFFF",
    },
    insideVertical: {
      style: BorderStyle.NONE,
      size: 0,
      color: "FFFFFF",
    },
  };
}

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(b\.?a\.?|cppa|cpa|asa|aac?i)\b/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

function namesMatch(left: unknown, right: unknown): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

export function buildTransmittalLetter(
  reportData: any,
  reportDate: string,
  options: TransmittalOptions = {}
): Array<Paragraph | Table> {
  // Resolve every fallback once. This prevents later optional branches from
  // choosing a different recipient or signatory identity within the same page.
  const children: Array<Paragraph | Table> = [];
  const font = options.font || DEFAULT_FONT;
  const lang = getLang(reportData);
  const tr = t(lang);
  const clientName = String(reportData?.client_name || "").trim() || "Client";
  const ownerName =
    String(reportData?.owner_name || "").trim() || clientName;
  const exclusiveUseBy =
    String(reportData?.exclusive_use_by || clientName).trim() || clientName;
  const preparedForLines = splitPreparedForLines(
    String(reportData?.prepared_for || "").trim()
  );
  const recipientLines = preparedForLines.length
    ? preparedForLines
    : uniqueLines([clientName]).filter(Boolean);
  const attentionName =
    String(reportData?.attention || reportData?.contact_name || "").trim() ||
    recipientLines[0] ||
    clientName;
  const recipientPrimaryLine =
    recipientLines[0] || attentionName || clientName;
  const valuationMethods = resolveSelectedAssetValuationMethods(reportData);
  const valuationMethodNames = valuationMethods
    .map((method) => method.label)
    .join(" and ");
  const subjectName =
    String(reportData?.owner_name || recipientPrimaryLine).trim() ||
    recipientPrimaryLine;
  const premiseSentence = valuationMethods.length
    ? `The subject assets were appraised under the premise of ${valuationMethodNames}, for internal consideration.`
    : "No valuation methods were selected for this report.";
  const opinionSentence = `After a thorough analysis of the assets and information made available to us, it is our opinion that, as of the Effective Date, the selected values are as shown on the certificate that we have prepared.`;
  const greeting =
    lang === "en" && attentionName ? `Dear ${attentionName},` : tr.dear;
  const valuationSentence =
    reportData?.include_valuation_summary_in_transmittal === true
      ? buildValuationSentence(reportData, tr)
      : "";
  const signatories = resolveAssetCertificateData(reportData);
  const signature =
    namesMatch(
      reportData?.appraiser || reportData?.inspector_name,
      signatories.primarySignatory.name
    )
      ? buildSignatureImageParagraph(reportData, {
          width: 165,
          height: 44,
          before: 0,
          after: 10,
          alignment: AlignmentType.LEFT,
        })
      : null;

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      keepNext: true,
      spacing: { before: 240, after: 210 },
      children: [
        run("TRANSMITTAL LETTER", {
          font,
          bold: true,
          size: 26,
        }),
      ],
    })
  );
  children.push(
    new Paragraph({
      keepNext: true,
      spacing: { after: 165, line: 240 },
      children: [run(reportDate, { font })],
    })
  );
  for (const [index, line] of recipientLines.entries()) {
    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { after: index === recipientLines.length - 1 ? 165 : 0 },
        children: [
          run(line, {
            font,
            bold: index === 0,
          }),
        ],
      })
    );
  }
  children.push(
    new Paragraph({
      keepNext: true,
      spacing: { before: 180, after: 150, line: 240 },
      children: [
        run(`${tr.rePrefix}: `, { font, bold: true }),
        run(`${tr.assetAppraisal} of ${subjectName}`, {
          font,
          bold: true,
        }),
      ],
    })
  );
  children.push(bodyParagraph(greeting, font, 135));
  children.push(
    bodyParagraph(
      `At your request, we have prepared an appraisal of certain assets owned by ${ownerName}, a copy of which is enclosed. This appraisal report is intended for exclusive use by ${exclusiveUseBy} and is intended only for establishing values of the listed assets.`,
      font
    )
  );
  children.push(bodyParagraph(premiseSentence, font));
  children.push(bodyParagraph(tr.approachesSentence, font));
  children.push(bodyParagraph(opinionSentence, font));
  if (valuationSentence) {
    children.push(bodyParagraph(valuationSentence, font));
  }
  children.push(bodyParagraph(tr.certifySentence, font));
  children.push(bodyParagraph(tr.contactSentence, font, 150));
  children.push(
    new Paragraph({
      keepNext: true,
      spacing: { after: 230 },
      children: [run(tr.sincerely, { font })],
    })
  );

  const contentWidthTw = convertInchesToTwip(6.5);
  // A table is used as the signer merge boundary: Word can keep paired signers
  // aligned and unsplit even when a signature image is absent.
  const hasSecondary = Boolean(signatories.secondarySignatory);
  const leftWidth = hasSecondary
    ? Math.round(contentWidthTw * 0.51)
    : contentWidthTw;
  const rightWidth = contentWidthTw - leftWidth;
  const signerCell = (
    signatory: {
      name: string;
      role: string;
      company: string;
    },
    signatureParagraph: Paragraph | null,
    width: number
  ) =>
    new TableCell({
      width: {
        size: width,
        type: WidthType.DXA,
      },
      verticalAlign: VerticalAlign.BOTTOM,
      margins: { top: 0, bottom: 0, left: 0, right: 160 },
      borders: noBorders(),
      children: [
        ...(signatureParagraph
          ? [signatureParagraph]
          : [
              new Paragraph({
                spacing: { before: 0, after: 0, line: 620 },
              }),
            ]),
        new Paragraph({
          spacing: { before: 0, after: 0, line: 230 },
          children: [run(signatory.name, { font, bold: true })],
        }),
        new Paragraph({
          spacing: { before: 0, after: 0, line: 230 },
          children: [run(signatory.role, { font })],
        }),
        new Paragraph({
          spacing: { before: 0, after: 0, line: 230 },
          children: [run(signatory.company, { font })],
        }),
      ],
    });

  children.push(
    new Table({
      width: { size: contentWidthTw, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      columnWidths: hasSecondary ? [leftWidth, rightWidth] : [leftWidth],
      borders: noBorders(),
      rows: [
        new TableRow({
          cantSplit: true,
          children: [
            signerCell(signatories.primarySignatory, signature, leftWidth),
            ...(signatories.secondarySignatory
              ? [signerCell(signatories.secondarySignatory, null, rightWidth)]
              : []),
          ],
        }),
      ],
    })
  );

  return children;
}
