/**
 * Comprehensive real-estate DOCX builder retained for the generated-content
 * workflow. It resolves report facts first, obtains optional AI narratives with
 * deterministic empty fallbacks, then renders all chapters in fixed reading order.
 */
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TextRun,
  convertInchesToTwip,
  BorderStyle,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  TableLayoutType,
  ImageRun,
} from "docx";
import fs from "fs/promises";
import path from "path";
import { buildHeaderTable } from "./builders/header.js";
import {
  buildKeyValueTable,
  goldDivider,
  formatDateUS,
  fetchImageBuffer,
} from "./builders/utils.js";
import {
  generateRealEstateReportContent,
  type GeneratedSections,
} from "../realEstateAIContent.js";

const contentWidthTw = convertInchesToTwip(6.5);

function safe(val?: any): string {
  if (val === undefined || val === null) return "";
  return String(val);
}

function heading1(text: string, pageBreak = false): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: pageBreak,
    spacing: { before: 200, after: 120 },
  });
}

function heading2(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 160, after: 100 },
  });
}

function heading3(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 120, after: 80 },
  });
}

function bodyText(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, size: 22 })],
    spacing: { after: 100 },
  });
}

function bodyParagraphs(content: string): Paragraph[] {
  return content
    .split("\n\n")
    .filter((p) => p.trim())
    .map((p) => bodyText(p.trim()));
}

function bulletPoint(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: `• ${text}`, size: 22 })],
    spacing: { after: 60 },
    indent: { left: 360 },
  });
}

export async function generateRealEstateFullDocx(
  reportData: any
): Promise<Buffer> {
  // Load logo
  let logoBuffer: Buffer | null = null;
  try {
    logoBuffer = await fs.readFile(
      path.resolve(process.cwd(), "public/logo.jpg")
    );
  } catch {
    logoBuffer = null;
  }

  // Extract data
  const propertyType = reportData?.property_type || "residential";
  const address = safe(reportData?.property_details?.address);
  const legalDesc = safe(reportData?.property_details?.legal_description);
  const owner = safe(
    reportData?.owner_name || reportData?.property_details?.owner_name
  );
  const inspector = safe(reportData?.inspector_info?.inspector_name);
  const company = safe(reportData?.inspector_info?.company_name);
  const credentials = safe(reportData?.inspector_info?.credentials) || "CPPA";
  const effectiveDate = formatDateUS(reportData?.report_dates?.effective_date);
  const inspectionDate = formatDateUS(
    reportData?.report_dates?.inspection_date
  );
  const reportDate = formatDateUS(
    reportData?.report_dates?.report_date || new Date().toISOString()
  );

  const fmv = safe(
    reportData?.farmland_valuation?.fair_market_value_formatted ||
      reportData?.valuation?.fair_market_value
  );
  const fmvWords = numberToWords(parseFloat(fmv.replace(/[^0-9.]/g, "")) || 0);

  // AI copy is enrichment around report facts. Failure yields the complete empty
  // shape so every later section can choose its deterministic authored fallback.
  let aiContent: GeneratedSections;
  try {
    aiContent = await generateRealEstateReportContent(reportData);
  } catch {
    aiContent = {
      transmittal: "",
      exec_summary: "",
      certification: "",
      assumptions: "",
      scope: "",
      basis: "",
      factual: "",
      site_desc: "",
      hbu: "",
      valuation: "",
      market: "",
      conclusions: "",
    };
  }

  // Header table
  const headerTable = buildHeaderTable(
    logoBuffer,
    contentWidthTw,
    safe(reportData?.inspector_info?.contact_email)
  );

  // Append chapters linearly; heading order is also the report's navigation and
  // evidentiary sequence, so it must not be reordered independently of the TOC.
  const children: (Paragraph | Table)[] = [];

  // === TRANSMITTAL LETTER ===
  children.push(heading1("Letter of Transmittal", true));
  children.push(goldDivider());
  children.push(bodyText(reportDate));
  children.push(new Paragraph({ spacing: { after: 80 } }));
  children.push(bodyText(owner || "Attention: Property Owner"));
  children.push(new Paragraph({ spacing: { after: 80 } }));
  children.push(
    bodyText(
      `RE: A ${propertyType.charAt(0).toUpperCase() + propertyType.slice(1)} Property Located at ${address || "Subject Property"}`
    )
  );
  children.push(new Paragraph({ spacing: { after: 120 } }));

  if (aiContent.transmittal) {
    children.push(...bodyParagraphs(aiContent.transmittal));
  } else {
    children.push(
      bodyText(
        `In accordance with your request, this report presents an independent appraisal of the subject property. The objective is to determine the current market value as of ${effectiveDate}, the effective date corresponding to the property inspection.`
      )
    );
    children.push(
      bodyText(
        `Based on the inspection findings and valuation analysis, the estimated market value, held in fee simple ownership and exclusive of GST, as of ${effectiveDate}, is concluded to be:`
      )
    );
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 },
      children: [
        new TextRun({
          text: `${fmvWords} (${fmv})`,
          bold: true,
          size: 28,
          color: "065F46",
        }),
      ],
    })
  );

  children.push(bodyText("Respectfully submitted,"));
  children.push(bodyText(inspector));
  children.push(new Paragraph({ spacing: { after: 60 } }));
  children.push(bodyText(`Per:\n${inspector}, ${credentials}`));

  // === 1.0 EXECUTIVE SUMMARY ===
  children.push(heading1("1.0 EXECUTIVE SUMMARY", true));
  children.push(goldDivider());

  children.push(heading2("1.1 Property Overview and Location Context"));
  children.push(
    ...bodyParagraphs(
      aiContent.exec_summary ||
        `The subject property is located at ${address}. This ${propertyType} property has been inspected and analyzed in accordance with professional appraisal standards.`
    )
  );

  children.push(heading2("1.2 Purpose and Intended Use of the Appraisal"));
  children.push(
    bodyText(
      "The purpose of this appraisal is to estimate the current market value of the subject property as of the effective valuation date. The report has been prepared to support acquisition, sale, or financing decision-making."
    )
  );

  children.push(heading2("1.3 Client and Intended Users"));
  children.push(
    bodyText(
      `The client for this appraisal is ${owner}. The intended user is the client named above. This appraisal complies with CUSPAP standards.`
    )
  );

  children.push(heading2("1.4 Effective Date of Valuation and Inspection"));
  children.push(
    buildKeyValueTable([
      { label: "Effective Date", value: effectiveDate },
      { label: "Inspection Date", value: inspectionDate },
      { label: "Report Date", value: reportDate },
    ])
  );

  children.push(heading2("1.5 Summary of Key Facts and Conclusions"));
  children.push(
    buildKeyValueTable([
      { label: "Property Address", value: address },
      {
        label: "Legal Description",
        value: legalDesc || "See title documentation",
      },
      {
        label: "Property Type",
        value: propertyType.charAt(0).toUpperCase() + propertyType.slice(1),
      },
      { label: "Owner", value: owner },
      { label: "Market Value", value: fmv },
    ])
  );

  children.push(heading2("1.6 Highest and Best Use Summary"));
  children.push(
    bodyText(
      `The highest and best use of the subject property is concluded to be its current ${propertyType} use, which is legally permissible, physically possible, financially feasible, and maximally productive.`
    )
  );

  children.push(heading2("1.7 Market Value Conclusion"));
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      shading: { type: ShadingType.CLEAR, fill: "ECFDF5" },
      children: [
        new TextRun({ text: "Estimated Market Value: ", size: 26 }),
        new TextRun({ text: fmv, bold: true, size: 32, color: "065F46" }),
      ],
    })
  );

  children.push(heading2("1.8 Property Type Highlights"));
  if (propertyType === "agricultural") {
    const fd = reportData?.farmland_details || {};
    children.push(
      bulletPoint(`Total Title Acres: ${fd.total_title_acres || "N/A"}`)
    );
    children.push(
      bulletPoint(`Cultivated Acres: ${fd.cultivated_acres || "N/A"}`)
    );
    children.push(bulletPoint(`Soil Class: ${fd.soil_class || "N/A"}`));
    children.push(bulletPoint(`Crop Type: ${fd.crop_type || "N/A"}`));
    children.push(bulletPoint(`Access Quality: ${fd.access_quality || "N/A"}`));
  } else if (propertyType === "commercial") {
    children.push(bulletPoint("Building income potential and lease profile"));
    children.push(bulletPoint("Functional design and adaptability"));
    children.push(
      bulletPoint("Regional economic trends and capitalization rates")
    );
  } else {
    const hd = reportData?.house_details || {};
    children.push(bulletPoint(`Year Built: ${hd.year_built || "N/A"}`));
    children.push(bulletPoint(`Square Footage: ${hd.square_footage || "N/A"}`));
    children.push(
      bulletPoint(
        `Bedrooms/Bathrooms: ${hd.number_of_rooms || "N/A"} / ${hd.number_of_full_bathrooms || "N/A"}`
      )
    );
  }

  // === 2.0 CERTIFICATION ===
  children.push(heading1("2.0 CERTIFICATION AND COMPLIANCE", true));
  children.push(goldDivider());

  children.push(heading2("2.1 Appraiser's Certification Statement"));
  children.push(
    ...bodyParagraphs(
      aiContent.certification ||
        "I hereby certify that the statements of fact in this report are accurate and complete to the best of my knowledge. The analyses, opinions, and conclusions reflect my impartial professional judgment."
    )
  );

  children.push(heading2("2.2 Professional Membership and Competency"));
  children.push(
    bodyText(
      "The undersigned appraiser is a member in good standing of the Appraisal Institute of Canada (AIC) and possesses the necessary qualifications to competently complete this assignment."
    )
  );

  children.push(heading2("2.3 Compliance with CUSPAP and IVS"));
  children.push(
    bodyText(
      "This appraisal has been prepared in full compliance with the Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP) and aligns with International Valuation Standards (IVS)."
    )
  );

  children.push(
    heading2("2.4 Conflict of Interest and Independence Statement")
  );
  children.push(
    bodyText(
      "The appraiser affirms that this assignment has been undertaken independently and without bias. No conflict of interest exists with respect to this property or any parties involved."
    )
  );

  // Certification signature block
  children.push(
    buildKeyValueTable([
      { label: "Legal Description", value: legalDesc || address },
      { label: "Date of Inspection", value: inspectionDate },
      { label: "Date of Report", value: reportDate },
      { label: "Market Value Conclusion", value: `${fmvWords} (${fmv})` },
    ])
  );

  // === 3.0 ASSUMPTIONS AND CONDITIONS ===
  children.push(
    heading1("3.0 ASSUMPTIONS, LIMITING CONDITIONS, AND LIABILITY", true)
  );
  children.push(goldDivider());

  children.push(heading2("3.1 General Assumptions and Limiting Conditions"));
  children.push(
    ...bodyParagraphs(
      aiContent.assumptions ||
        "This report has been prepared exclusively for the client and for the specific purpose identified. The conclusions apply only as of the effective date. Title is assumed to be valid and marketable."
    )
  );

  children.push(
    heading2("3.2 Extraordinary Assumptions and Hypothetical Conditions")
  );
  children.push(
    bodyText(
      "The valuation relies on information from public records and market sources deemed reliable. Any future discovery of errors could influence the value conclusion."
    )
  );

  children.push(heading2("3.3 Environmental, Legal, and Physical Limitations"));
  children.push(
    bodyText(
      "This appraisal assumes the property is free from adverse environmental conditions. The appraiser is not qualified to detect environmental contaminants."
    )
  );

  children.push(heading2("3.4 Confidentiality and Liability Disclaimer"));
  children.push(
    bodyText(
      "This report is confidential. The total liability of the appraiser shall be limited to the professional fee charged for this engagement."
    )
  );

  // === 4.0 SCOPE OF ASSIGNMENT ===
  children.push(heading1("4.0 SCOPE OF THE ASSIGNMENT", true));
  children.push(goldDivider());

  children.push(heading2("4.1 Purpose and Function of the Appraisal"));
  children.push(
    ...bodyParagraphs(
      aiContent.scope ||
        "The purpose is to develop an independent opinion of current market value as of the effective date."
    )
  );

  children.push(heading2("4.2 Intended Use and Users"));
  children.push(
    bodyText(
      `The intended use is to assist ${owner} in evaluating market value. The intended users are limited to the client and authorized parties.`
    )
  );

  children.push(heading2("4.3 Property Rights Appraised"));
  children.push(
    bodyText(
      "This report considers the market value of the fee simple interest in the subject property."
    )
  );

  children.push(heading2("4.4 Scope of Work and Methodology"));
  children.push(
    bodyText(
      "The scope includes property inspection, market data analysis, verification of comparable sales, and application of appropriate valuation approaches."
    )
  );

  children.push(heading2("4.5 Research, Verification, and Data Sources"));
  children.push(
    bodyText(
      "Data was obtained from provincial land registry, municipal records, real estate transaction databases, and market participants."
    )
  );

  // === 5.0 BASIS OF APPRAISAL ===
  children.push(heading1("5.0 BASIS OF THE APPRAISAL", true));
  children.push(goldDivider());

  children.push(heading2("5.1 Definition of Market Value"));
  children.push(
    ...bodyParagraphs(
      aiContent.basis ||
        "Market Value is defined as the most probable price that a property should bring in a competitive and open market under fair sale conditions, with buyer and seller each acting prudently and knowledgeably."
    )
  );

  children.push(heading2("5.2 Interest and Rights Appraised"));
  children.push(
    bodyText(
      "This appraisal reflects the market value of the property in fee simple interest."
    )
  );

  children.push(heading2("5.3 Exposure and Marketing Periods"));
  children.push(
    bodyText(
      "Exposure time and marketing period are consistent with typical periods for this property type in the current market."
    )
  );

  // === 6.0 FACTUAL INFORMATION ===
  children.push(heading1("6.0 FACTUAL INFORMATION", true));
  children.push(goldDivider());

  children.push(heading2("6.1 Legal Description and Civic Address"));
  children.push(
    buildKeyValueTable([
      { label: "Civic Address", value: address },
      {
        label: "Legal Description",
        value: legalDesc || "Per title documentation",
      },
      {
        label: "Municipality",
        value: safe(reportData?.property_details?.municipality),
      },
    ])
  );

  children.push(heading2("6.2 Ownership and Title History"));
  children.push(
    bodyText(
      `According to land title records, ownership is registered to ${owner}. Title is assumed to be good and marketable.`
    )
  );

  children.push(heading2("6.3 Assessment and Taxation Summary"));
  children.push(
    bodyText(
      "The property is assessed by the local assessment authority. Assessment values are administrative estimates for taxation purposes."
    )
  );

  children.push(heading2("6.4 Municipal and Regional Context"));
  children.push(
    ...bodyParagraphs(
      aiContent.factual ||
        "The property lies within the local municipal jurisdiction with access to regional transportation and services."
    )
  );

  children.push(heading2("6.5 Economic and Market Overview"));
  if (propertyType === "agricultural") {
    children.push(
      bodyText(
        "The agricultural market reflects commodity pricing trends, farm consolidation activity, and land investment demand."
      )
    );
  } else if (propertyType === "commercial") {
    children.push(
      bodyText(
        "The commercial market reflects retail, industrial, and office sector performance in the region."
      )
    );
  } else {
    children.push(
      bodyText(
        "The residential market reflects supply, demand, and pricing analysis for comparable properties."
      )
    );
  }

  // === 7.0 SITE DESCRIPTION ===
  children.push(heading1("7.0 SITE DESCRIPTION", true));
  children.push(goldDivider());

  children.push(heading2("7.1 Location and Access"));
  children.push(
    ...bodyParagraphs(
      aiContent.site_desc ||
        `The subject property is located at ${address} with adequate access and typical characteristics for the area.`
    )
  );

  children.push(heading2("7.2 Size, Shape, and Topography"));
  if (propertyType === "agricultural") {
    const fd = reportData?.farmland_details || {};
    children.push(
      buildKeyValueTable([
        { label: "Total Acres", value: safe(fd.total_title_acres) },
        { label: "Cultivated Acres", value: safe(fd.cultivated_acres) },
        { label: "Soil Class", value: safe(fd.soil_class) },
        {
          label: "Terrain",
          value: safe(reportData?.ai_extracted_features?.terrain_type),
        },
      ])
    );
  } else {
    children.push(
      bodyText(
        "The property has typical configuration for properties of this type in the market area."
      )
    );
  }

  children.push(heading2("7.3 Utilities and Site Services"));
  children.push(
    bodyText(
      "Available services include typical utilities for the area. Service capacity is adequate for current use."
    )
  );

  // === 8.0 HIGHEST AND BEST USE ===
  children.push(heading1("8.0 HIGHEST AND BEST USE ANALYSIS", true));
  children.push(goldDivider());

  children.push(heading2("8.1 Definition and Analytical Framework"));
  children.push(
    ...bodyParagraphs(
      aiContent.hbu ||
        "Highest and Best Use refers to the reasonably probable and legal use that is physically possible, legally permissible, financially feasible, and maximally productive."
    )
  );

  children.push(heading2("8.2 Legally Permissible Use"));
  children.push(
    bodyText(
      "The current use is consistent with zoning and no legal impediments were identified."
    )
  );

  children.push(heading2("8.3 Physically Possible Use"));
  children.push(
    bodyText(
      "The site's physical characteristics support development consistent with the zoning framework."
    )
  );

  children.push(heading2("8.4 Financially Feasible Use"));
  children.push(
    bodyText(
      "Market analysis indicates demand exists for this property type within the region."
    )
  );

  children.push(heading2("8.5 Maximally Productive Use"));
  children.push(
    bodyText(
      "The current use represents the maximally productive use at this time."
    )
  );

  children.push(heading2("8.6 Conclusion of Highest and Best Use"));
  children.push(
    bodyText(
      `Based on the analysis, the highest and best use is continued ${propertyType} use.`
    )
  );

  // === 9.0 VALUATION ANALYSIS ===
  children.push(heading1("9.0 VALUATION ANALYSIS", true));
  children.push(goldDivider());

  children.push(heading2("9.1 Overview of Approaches to Value"));
  children.push(
    ...bodyParagraphs(
      aiContent.valuation ||
        "Three principal approaches were reviewed: Direct Comparison, Income Capitalization, and Cost Approach."
    )
  );

  children.push(heading2("9.2 Direct Comparison Approach"));
  // Add comparables table if available
  const comps =
    reportData?.comparableProperties ||
    reportData?.farmland_valuation?.direct_comparison?.comparables ||
    [];
  if (Array.isArray(comps) && comps.length > 0) {
    children.push(
      bodyText(
        `${comps.length} comparable sales were analyzed and adjusted for differences.`
      )
    );
  } else {
    children.push(
      bodyText(
        "Comparable sales were analyzed and adjusted for physical, locational, and economic differences."
      )
    );
  }

  if (
    propertyType === "agricultural" &&
    reportData?.farmland_valuation?.income_capitalization
  ) {
    children.push(heading2("9.3 Income Capitalization Approach"));
    const ic = reportData.farmland_valuation.income_capitalization;
    children.push(
      buildKeyValueTable([
        {
          label: "Market Rent/Acre",
          value: ic.market_rent_per_acre
            ? `$${ic.market_rent_per_acre}`
            : "N/A",
        },
        { label: "Cap Rate", value: ic.cap_rate ? `${ic.cap_rate}%` : "N/A" },
        {
          label: "Indicated Value",
          value: ic.indicated_value_formatted || "N/A",
        },
      ])
    );
  }

  children.push(heading2("9.5 Reconciliation of Indications"));
  children.push(
    bodyText(
      "Each approach provides an independent indication of value. The final opinion reflects the approach most reflective of market behaviour."
    )
  );

  children.push(heading2("9.6 Final Estimate of Market Value"));
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 160, after: 160 },
      shading: { type: ShadingType.CLEAR, fill: "ECFDF5" },
      children: [
        new TextRun({ text: "Final Market Value: ", size: 28 }),
        new TextRun({ text: fmv, bold: true, size: 36, color: "065F46" }),
      ],
    })
  );

  // === 10.0 MARKET CONTEXT ===
  children.push(heading1("10.0 MARKET CONTEXT AND RISK ANALYSIS", true));
  children.push(goldDivider());

  children.push(heading2("10.1 Market Trends and Economic Conditions"));
  children.push(
    ...bodyParagraphs(
      aiContent.market ||
        "Market conditions reflect trends in the broader economy including employment, interest rates, and property-specific factors."
    )
  );

  children.push(heading2("10.2 Regional and Provincial Outlook"));
  children.push(
    bodyText(
      "The regional outlook reflects stable economic conditions with moderate growth expectations."
    )
  );

  children.push(heading2("10.3 Risk Assessment and Sensitivity Analysis"));
  children.push(
    bodyText(
      "The valuation is subject to typical market, income, operational, and regulatory risks for this property type."
    )
  );

  // === 11.0 CONCLUSIONS ===
  children.push(heading1("11.0 CONCLUSIONS AND RECOMMENDATIONS", true));
  children.push(goldDivider());

  children.push(heading2("11.1 Summary of Findings"));
  children.push(
    ...bodyParagraphs(
      aiContent.conclusions ||
        "The appraisal involved detailed review of the subject property, analysis of comparable market data, and application of appropriate valuation approaches."
    )
  );

  children.push(heading2("11.2 Reconciliation of Approaches"));
  children.push(
    bodyText(
      "The relative weight assigned to each approach depended on data quality, market behaviour, and property characteristics."
    )
  );

  children.push(heading2("11.3 Final Market Value Opinion"));
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 },
      border: {
        top: { style: BorderStyle.SINGLE, size: 12, color: "065F46" },
        bottom: { style: BorderStyle.SINGLE, size: 12, color: "065F46" },
      },
      children: [
        new TextRun({ text: "\n", size: 12 }),
        new TextRun({
          text: "MARKET VALUE CONCLUSION\n",
          bold: true,
          size: 28,
          color: "065F46",
        }),
        new TextRun({ text: `As of ${effectiveDate}\n\n`, size: 22 }),
        new TextRun({
          text: `${fmvWords}\n`,
          bold: true,
          size: 32,
          color: "065F46",
        }),
        new TextRun({ text: `(${fmv} CAD)\n`, bold: true, size: 28 }),
      ],
    })
  );

  children.push(heading2("11.4 Professional Opinion and Commentary"));
  children.push(
    bodyText(
      `The appraiser certifies that this conclusion has been developed independently, without bias, and in full conformity with CUSPAP. Any subsequent change in market conditions may alter this opinion of value.`
    )
  );

  // Build document
  // All async content and images are resolved before this immutable document
  // graph is created, avoiding timing-dependent child order.
  const doc = new Document({
    creator: inspector || "Asset Insight",
    title: `Real Estate Appraisal - ${address}`,
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "1F2937" },
          paragraph: { spacing: { line: 320 } },
        },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          run: { size: 32, bold: true, color: "065F46" },
          paragraph: { spacing: { before: 200, after: 120 } },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          run: { size: 26, bold: true, color: "059669" },
          paragraph: { spacing: { before: 160, after: 100 } },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          run: { size: 24, bold: true, color: "10B981" },
          paragraph: { spacing: { before: 120, after: 80 } },
        },
      ],
    },
    // This workflow emits one main section; header/footer and page geometry are
    // owned here rather than added by controllers after serialization.
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
            pageNumbers: { start: 1 },
          },
        },
        headers: { default: new Header({ children: [headerTable] }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: "Page " }),
                  PageNumber.CURRENT as any,
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  // Packing completes the service contract: callers receive a ready-to-send DOCX.
  return Buffer.from(await Packer.toBuffer(doc));
}

function numberToWords(num: number): string {
  if (num === 0) return "Zero Dollars";
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  const scales = ["", "Thousand", "Million", "Billion"];

  const convert = (n: number): string => {
    if (n < 20) return ones[n];
    if (n < 100)
      return tens[Math.floor(n / 10)] + (n % 10 ? "-" + ones[n % 10] : "");
    if (n < 1000)
      return (
        ones[Math.floor(n / 100)] +
        " Hundred" +
        (n % 100 ? " " + convert(n % 100) : "")
      );
    return "";
  };

  const parts: string[] = [];
  let remaining = Math.floor(num);
  let scaleIdx = 0;

  while (remaining > 0) {
    const chunk = remaining % 1000;
    if (chunk > 0) {
      parts.unshift(
        convert(chunk) + (scales[scaleIdx] ? " " + scales[scaleIdx] : "")
      );
    }
    remaining = Math.floor(remaining / 1000);
    scaleIdx++;
  }

  return parts.join(" ") + " Dollars";
}
