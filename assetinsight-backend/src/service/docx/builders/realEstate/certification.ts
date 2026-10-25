import {
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  TableLayoutType,
} from "docx";
import { goldDivider } from "../utils.js";
import { formatRealEstateMoney } from "./formatMoney.js";

/**
 * 2.0 CERTIFICATION
 * Assembles certification points, assignment facts, value conclusion, and
 * signatures in attestational order. Optional credentials enrich the page but
 * must not shift value or signature merge boundaries.
 */
export function buildCertificationSection(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const inspectorName = reportData?.inspector_name || reportData?.appraiser || "Appraiser Name";
  const inspectorCompany = reportData?.inspector_company || reportData?.company || "";
  const legalDesc = reportData?.legal_description || reportData?.property_address || "";
  const inspectionDate = reportData?.inspection_date || new Date().toLocaleDateString();
  const reportDate = reportData?.report_date || new Date().toLocaleDateString();
  const marketValue = reportData?.valuation?.fair_market_value || reportData?.fair_market_value || "TBD";
  const currency = reportData?.currency || "CAD";

  // Section Title
  children.push(
    new Paragraph({
      text: "2.0 CERTIFICATION",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 200 },
    })
  );
  children.push(goldDivider());

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "I hereby certify that, to the best of my knowledge and professional judgment:", bold: true }),
      ],
      spacing: { after: 160 },
    })
  );

  // Certification points
  const certPoints = [
    "The statements of fact contained within this report are accurate and complete to the best of my understanding.",
    "I have no bias with respect to the property appraised or the individuals or entities associated with this assignment.",
    "The analyses, opinions, and conclusions expressed in this report are limited solely by the stated assumptions and limiting conditions and reflect my impartial and unbiased professional judgment.",
    "I hold no past, present, or anticipated future interest in the property that is the subject of this appraisal, nor any personal or professional relationship or conflict of interest with the parties involved in this assignment.",
    "My engagement and the compensation for this assignment were not contingent upon the reporting of a predetermined result, a specific value conclusion, or the occurrence of any subsequent event that could influence such a result.",
    "This report has been prepared in accordance with the Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP), as established by the Appraisal Institute of Canada (AIC).",
    "I possess the education, training, and experience necessary to competently complete this appraisal assignment.",
    "Except as specifically disclosed within this report, no other individual has provided significant professional assistance to the undersigned appraiser in the completion of this assignment.",
    "The undersigned is a member in good standing of the Appraisal Institute of Canada.",
    "I have personally inspected the property that is the subject of this report.",
  ];

  certPoints.forEach((point, idx) => {
    children.push(
      new Paragraph({
        style: "BodyLarge",
        children: [
          new TextRun({ text: `${idx + 1}. `, bold: true }),
          new TextRun({ text: point }),
        ],
        spacing: { after: 120 },
      })
    );
  });

  // Property details table
  children.push(
    new Paragraph({
      spacing: { before: 200, after: 120 },
    })
  );

  const detailsTable = new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [Math.round(contentWidthTw * 0.35), Math.round(contentWidthTw * 0.65)],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 8, color: "DC2626" },
      bottom: { style: BorderStyle.SINGLE, size: 8, color: "DC2626" },
      left: { style: BorderStyle.SINGLE, size: 8, color: "DC2626" },
      right: { style: BorderStyle.SINGLE, size: 8, color: "DC2626" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "FEE2E2" },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "FEE2E2" },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: "Legal Description:", bold: true })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: legalDesc })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: "Date of Inspection:", bold: true })] })],
          }),
          new TableCell({
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: inspectionDate })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: "Date of Report / Certification:", bold: true })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: reportDate })] })],
          }),
        ],
      }),
    ],
  });
  children.push(detailsTable);

  // Value conclusion
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `Based on the data, analyses, and conclusions contained within this report, the estimated current market value of the subject property, appraised as a fee simple interest as of ${inspectionDate}, is concluded to be:`,
        }),
      ],
      spacing: { before: 200, after: 160 },
    })
  );

  // Value box
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: formatRealEstateMoney(marketValue, currency),
          bold: true,
          size: 48,
          color: "DC2626",
        }),
      ],
      spacing: { before: 120, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This value conclusion is subject to the assumptions, limiting conditions, and extraordinary assumptions described herein. Verification of certain information relied upon in this report was beyond the scope of this assignment. The valuation is further subject to an extraordinary assumption related to current economic conditions. Any material change to that assumption may affect the value conclusion stated above.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 2.2 Professional Membership
  children.push(
    new Paragraph({
      text: "2.2 PROFESSIONAL MEMBERSHIP AND COMPETENCY",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The undersigned appraiser is a member in good standing of the Appraisal Institute of Canada (AIC) and is bound by its Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP) and Code of Conduct.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The appraiser possesses the academic background, professional training, and valuation experience necessary to perform this appraisal competently. The assignment has been completed in accordance with the Competency Rule of CUSPAP, which requires the appraiser to have the knowledge, experience, and geographic familiarity relevant to the property type and market area.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Where specialized expertise was required (e.g., environmental, engineering, or agronomic matters), such information was obtained from qualified external sources deemed reliable, and their input is cited within this report where applicable.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 2.3 Compliance with CUSPAP and IVS
  children.push(
    new Paragraph({
      text: "2.3 COMPLIANCE WITH CUSPAP AND IVS",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This appraisal has been prepared in full compliance with the Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP), including the Ethical, Scope of Work, and Reporting Standards, as promulgated by the Appraisal Institute of Canada.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "In addition, the structure and reporting format have been aligned, where applicable, with the principles set out under the International Valuation Standards (IVS). These standards collectively ensure that the analyses, opinions, and conclusions expressed in this report reflect professional independence, due diligence, and transparency.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "All assumptions, methodologies, and data sources are disclosed to allow the client and intended users to understand the basis of the valuation and the reasoning supporting the final conclusion of market value.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 2.4 Conflict of Interest
  children.push(
    new Paragraph({
      text: "2.4 CONFLICT OF INTEREST AND INDEPENDENCE STATEMENT",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The appraiser affirms that this assignment has been undertaken independently and without bias. The appraiser has no direct or indirect interest, present or prospective, in the property that is the subject of this report, nor any personal or financial relationship with any of the parties involved in this assignment that could influence the results.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Compensation for this assignment is not contingent upon the reporting of a predetermined value, the attainment of a specific outcome, or any subsequent event that could affect the client's decision.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The analyses, opinions, and conclusions contained herein are the result of the appraiser's objective professional judgment, formed in accordance with recognized valuation standards and ethical obligations.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // Signature area
  children.push(
    new Paragraph({
      spacing: { before: 300 },
    })
  );

  const sigTable = new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [Math.round(contentWidthTw * 0.5), Math.round(contentWidthTw * 0.5)],
    borders: {
      top: { style: BorderStyle.NONE },
      bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.NONE },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            margins: { top: 60, bottom: 60, left: 0, right: 40 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: "________________________", color: "9CA3AF" })],
                spacing: { after: 60 },
              }),
              new Paragraph({
                children: [new TextRun({ text: inspectorName, bold: true })],
                spacing: { after: 40 },
              }),
              new Paragraph({
                children: [new TextRun({ text: inspectorCompany, color: "6B7280" })],
              }),
            ],
          }),
          new TableCell({
            margins: { top: 60, bottom: 60, left: 40, right: 0 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: "________________________", color: "9CA3AF" })],
                spacing: { after: 60 },
              }),
              new Paragraph({
                children: [new TextRun({ text: "Date", bold: true })],
                spacing: { after: 40 },
              }),
              new Paragraph({
                children: [new TextRun({ text: reportDate, color: "6B7280" })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
  children.push(sigTable);

  return children;
}
