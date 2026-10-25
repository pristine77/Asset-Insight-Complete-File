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
} from "docx";
import { formatDateUS, toTitleCaseWords } from "./utils.js";
import { resolveSelectedAssetValuationMethods } from "./certificate.js";

/**
 * Resolves heterogeneous report fields into three stable overview groups, then
 * renders them as fixed-width label/value tables. Keeping resolution separate
 * from rendering makes fallback precedence reviewable and reusable in tests.
 */
const FONT = "Times New Roman";

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function firstText(values: unknown[], fallback = "Not provided"): string {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return fallback;
}

function collectLocations(reportData: any): string {
  // Preserve first-seen order while deduplicating case-insensitively. The order
  // reflects report-level intent before lot-derived fallback locations.
  const values: unknown[] = [
    reportData?.locations_inspected,
    reportData?.inspection_locations,
    reportData?.inspection_location,
    reportData?.location,
    reportData?.preview_data?.locations_inspected,
    reportData?.preview_data?.inspection_locations,
    reportData?.preview_data?.inspection_location,
    reportData?.preview_data?.location,
  ];
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  for (const lot of lots) {
    values.push(
      lot?.location,
      lot?.inspection_location,
      lot?.site_address
    );
  }

  const seen = new Set<string>();
  const locations: string[] = [];
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const text = cleanText(candidate);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      locations.push(text);
    }
  }
  return locations.join(", ") || "Not provided";
}

function resolveMethodOfValuation(reportData: any): string {
  return resolveSelectedAssetValuationMethods(reportData)
    .map((method) => method.label)
    .join(" & ");
}

function resolveAssetType(reportData: any): string {
  const explicit = firstText(
    [
      reportData?.asset_type,
      reportData?.preview_data?.asset_type,
      reportData?.asset_category,
      reportData?.preview_data?.asset_category,
    ],
    ""
  );
  if (explicit) return toTitleCaseWords(explicit);

  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const categories = Array.from(
    new Set(
      lots
        .map((lot: any) =>
          cleanText(
            lot?.category ||
              lot?.category_name ||
              lot?.categories ||
              lot?.asset_type
          )
        )
        .filter(Boolean)
    )
  );
  if (categories.length === 1) return toTitleCaseWords(categories[0]);
  if (categories.length > 1) return "Mixed Equipment and Assets";

  const industry = cleanText(reportData?.industry);
  if (!industry) return "Equipment and Assets";
  return /equipment|asset/i.test(industry)
    ? toTitleCaseWords(industry)
    : `${toTitleCaseWords(industry)} Equipment`;
}

function resolveAssetCondition(reportData: any): string {
  const explicit = firstText(
    [
      reportData?.asset_condition,
      reportData?.overall_condition,
      reportData?.preview_data?.asset_condition,
      reportData?.preview_data?.overall_condition,
    ],
    ""
  );
  if (explicit) return toTitleCaseWords(explicit);

  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const conditions = Array.from(
    new Set(
      lots
        .map((lot: any) =>
          cleanText(lot?.condition || lot?.item_condition)
        )
        .filter(Boolean)
    )
  );
  if (conditions.length === 1) return toTitleCaseWords(conditions[0]);
  if (conditions.length > 1) return "Various Conditions";
  return "Not provided";
}

function sectionHeading(text: string, before = 180): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext: true,
    spacing: { before, after: 110 },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        font: FONT,
        bold: true,
        size: 24,
        color: "111111",
      }),
    ],
  });
}

function overviewTable(
  rows: Array<{ label: string; value: string }>,
  contentWidthTw: number
): Table {
  // The label/value split and exact DXA sum keep tables aligned across sections;
  // Word may redistribute percentage widths even under fixed table layout.
  const labelWidth = Math.round(contentWidthTw * 0.26);
  const valueWidth = contentWidthTw - labelWidth;
  const cellBorders = {
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.SINGLE, size: 5, color: "555555" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  };

  return new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [labelWidth, valueWidth],
    borders: {
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
    },
    rows: rows.map(
      (row) =>
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: labelWidth, type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              margins: { top: 45, bottom: 55, left: 20, right: 120 },
              borders: cellBorders,
              children: [
                new Paragraph({
                  spacing: { before: 0, after: 0, line: 230 },
                  children: [
                    new TextRun({
                      text: `${row.label}:`,
                      font: FONT,
                      size: 20,
                      color: "222222",
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              width: { size: valueWidth, type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              margins: { top: 45, bottom: 55, left: 20, right: 20 },
              borders: cellBorders,
              children: [
                new Paragraph({
                  spacing: { before: 0, after: 0, line: 230 },
                  children: [
                    new TextRun({
                      text: row.value || "Not provided",
                      font: FONT,
                      size: 20,
                      color: "222222",
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
    ),
  });
}

export function resolveAppraisalOverviewData(reportData: any) {
  // Each field lists authoritative sources first and legacy/preview locations
  // afterward. Reordering these fallbacks can silently change regenerated files.
  const headOfficeAddress = firstText([
    reportData?.head_office_address,
    reportData?.owner_address,
    reportData?.certificate_address,
    reportData?.company_address,
    reportData?.preview_data?.head_office_address,
    reportData?.preview_data?.owner_address,
    reportData?.preview_data?.certificate_address,
    reportData?.preview_data?.company_address,
    reportData?.location,
    reportData?.preview_data?.location,
  ]);
  const contactName = firstText(
    [
      reportData?.company_contacts,
      reportData?.company_contact,
      reportData?.contact_name,
      reportData?.attention,
      reportData?.preview_data?.company_contacts,
      reportData?.preview_data?.contact_name,
    ],
    ""
  );
  const contactDetails = [
    contactName,
    cleanText(reportData?.contact_phone),
    cleanText(reportData?.contact_email),
  ].filter(Boolean);

  return {
    companyRows: [
      {
        label: "Owner Name",
        value: toTitleCaseWords(
          firstText([
            reportData?.owner_name,
            reportData?.client_name,
            reportData?.prepared_for,
          ])
        ),
      },
      {
        label: "Industry",
        value: toTitleCaseWords(firstText([reportData?.industry])),
      },
      { label: "Locations Inspected", value: collectLocations(reportData) },
      {
        label: "Company Contacts",
        value: contactDetails.join(" | ") || "Not provided",
      },
      {
        label: "Company Website",
        value: firstText([
          reportData?.company_website,
          reportData?.website,
          reportData?.preview_data?.company_website,
          reportData?.preview_data?.website,
        ]),
      },
      { label: "Head Office Address", value: headOfficeAddress },
    ],
    appraisalRows: [
      {
        label: "Method of Valuation",
        value: resolveMethodOfValuation(reportData),
      },
      {
        label: "Date of Valuation",
        value:
          formatDateUS(
            reportData?.valuation_date || reportData?.effective_date
          ) || "Not provided",
      },
      {
        label: "Inspection Date",
        value:
          formatDateUS(
            reportData?.inspection_date ||
              reportData?.inspection_start_date
          ) || "Not provided",
      },
      {
        label: "Effective Date",
        value: formatDateUS(reportData?.effective_date) || "Not provided",
      },
    ],
    assetRows: [
      { label: "Asset Type", value: resolveAssetType(reportData) },
      {
        label: "Asset Condition",
        value: resolveAssetCondition(reportData),
      },
    ],
  };
}

export function buildAppraisalOverview(
  reportData: any,
  contentWidthTw: number
): Array<Paragraph | Table> {
  // Return document primitives rather than a nested section so the orchestrator
  // controls pagination, headers, and merge boundaries for the complete report.
  const data = resolveAppraisalOverviewData(reportData);
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 260, after: 180 },
      children: [
        new TextRun({
          text: "COMPANY OVERVIEW AND CONTACT INFORMATION",
          font: FONT,
          bold: true,
          size: 28,
          color: "111111",
        }),
      ],
    }),
    overviewTable(data.companyRows, contentWidthTw),
    sectionHeading("Appraisal Overview", 220),
    overviewTable(data.appraisalRows, contentWidthTw),
    sectionHeading("Asset Overview", 220),
    overviewTable(data.assetRows, contentWidthTw),
  ];
}
