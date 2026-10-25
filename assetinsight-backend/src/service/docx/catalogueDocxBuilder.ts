import fs from "fs/promises";
import path from "path";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  AlignmentType,
  TextRun,
  Table,
  TableOfContents,
  convertInchesToTwip,
  Header,
  Footer,
  PageNumber,
} from "docx";
import { buildHeaderTable } from "./builders/header.js";
import { buildCatalogueLots } from "./builders/catalogueLots.js";
import { buildAppendixPhotoGallery } from "./builders/appendix.js";
import { buildCover } from "./builders/cover.js";
import { buildTOC } from "./builders/toc.js";
import { buildTransmittalLetter } from "./builders/transmittal.js";
import { buildCertificateOfAppraisal } from "./builders/certificate.js";
import { buildMarketOverview } from "./builders/marketOverview.js";
import {
  formatDateUS,
  formatMonthYear,
  goldDivider,
  buildKeyValueTable,
} from "./builders/utils.js";
import { getLang, t } from "./builders/i18n.js";

/**
 * Orchestrates the catalogue report as front matter, fixed appraisal narrative,
 * lot catalogue, market context, and appendix. The long explicit sequence is
 * intentional: heading order drives the visible TOC and the legal reading order.
 */
// utils moved to ./builders/utils

export async function generateCatalogueDocx(reportData: any): Promise<Buffer> {
  // Normalize collections once at the service boundary so builders can rely on
  // stable source order and empty-array fallbacks.
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const rootImageUrls: string[] = Array.isArray(reportData?.imageUrls)
    ? reportData.imageUrls
    : [];
  const contentWidthTw = convertInchesToTwip(6.5);

  // Load logo from public
  let logoBuffer: Buffer | null = null;
  try {
    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    logoBuffer = await fs.readFile(logoPath);
  } catch {
    logoBuffer = null;
  }

  // Header table via builder
  const headerTable = buildHeaderTable(
    logoBuffer,
    contentWidthTw,
    (reportData as any)?.user_email
  );

  const children: Array<Paragraph | Table | TableOfContents> = [];
  const reportDate = formatDateUS(
    reportData?.createdAt || new Date().toISOString()
  );
  const lang = getLang(reportData);
  const tr = t(lang);
  // Build front matter separately. It must not inherit main-body headers or page
  // numbering, and its merge boundaries are expressed as Document sections.
  const coverChildren: Array<Paragraph | Table | TableOfContents> = [
    await buildCover(reportData, logoBuffer, contentWidthTw, tr.assetCatalogue),
  ];
  const tocChildren = buildTOC(reportData);
  const transmittalChildren = buildTransmittalLetter(reportData, reportDate);
  const certificateChildren = await buildCertificateOfAppraisal(
    reportData,
    contentWidthTw,
    reportDate
  );

  // Report Summary
  children.push(
    new Paragraph({
      text: tr.reportSummary,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  children.push(
    buildKeyValueTable([
      {
        label: tr.groupingMode,
        value: "Schedule A",
      },
      { label: tr.totalLots, value: String(lots.length) },
      {
        label: tr.totalImages,
        value: String(
          Array.isArray(reportData?.imageUrls) ? reportData.imageUrls.length : 0
        ),
      },
    ])
  );
  if (reportData?.analysis?.summary)
    children.push(
      new Paragraph({
        style: "BodyLarge",
        text: String(reportData.analysis.summary),
      })
    );

  // Report Details
  children.push(
    new Paragraph({
      text: tr.reportDetails,
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  children.push(
    buildKeyValueTable([
      { label: tr.clientName, value: reportData?.client_name },
      {
        label: tr.effectiveDate,
        value: formatDateUS(reportData?.effective_date),
      },
      { label: tr.appraisalPurpose, value: reportData?.appraisal_purpose },
      { label: tr.ownerName, value: reportData?.owner_name },
      { label: tr.appraiser, value: reportData?.appraiser },
      { label: tr.appraisalCompany, value: reportData?.appraisal_company },
      { label: tr.industry, value: reportData?.industry },
      {
        label: tr.inspectionDate,
        value: formatDateUS(reportData?.inspection_date),
      },
      ...(reportData?.contract_no ? [{ label: tr.contractNo, value: String(reportData.contract_no) }] : []),
    ])
  );

  // Conditions of Appraisal
  children.push(
    new Paragraph({
      text: "Conditions of Appraisal",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 120 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The value stated in this appraisal report is based on the best judgment of the appraiser, given the facts and conditions available at the date of valuation. The use of this report is limited to the purpose of determining the value of the assets. This report is to be used in its entirety only.",
    })
  );

  // Purpose of This Report
  const purposeClient = String(reportData?.client_name || "XYZ Ltd");
  children.push(
    new Paragraph({
      text: "Purpose of This Report",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `The purpose of this appraisal report is to provide an opinion of value of the subject for internal consideration and to assist ${purposeClient} and the specified personnel within their corporation in establishing a current Orderly Liquidation Value (OLV) for financial considerations. This report is not intended to be used for any other purpose. Based on the purpose of the appraisal, we have valued the subject assets under the premise of OLV.`,
    })
  );

  // Summary of Value Conclusions
  const totalAppraised =
    (reportData?.total_appraised_value as string) ||
    (reportData?.total_value as string) ||
    (reportData?.analysis?.total_value as string) ||
    undefined;
  children.push(
    new Paragraph({
      text: tr.summaryOfValue,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: totalAppraised
        ? `Based upon our analysis and methodology, we estimate the Orderly Liquidation Value at ${String(totalAppraised)} as of ${
            formatDateUS(reportData?.effective_date) || "the effective date"
          }.`
        : `Based upon our analysis and methodology, we estimate the Orderly Liquidation Value as of ${
            formatDateUS(reportData?.effective_date) || "the effective date"
          }.`,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `The scope of work included examination of information supplied by the client. In our analysis, we considered the cost, sales comparison (market), and income approaches. The appropriate approaches were utilized and the resulting value conclusions reconciled. The value opinions expressed in this appraisal are contingent upon the analysis, facts, and conditions presented in the accompanying appraisal report. The appraiser understands that this valuation is prepared for internal consideration within ${purposeClient}.`,
    })
  );

  // Identification of Assets Appraised
  children.push(
    new Paragraph({
      text: "Identification of Assets Appraised",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "As set out in the attached Schedule A, the assets appraised within this engagement include: Construction & Transportation Equipment.",
    })
  );

  // Scope of Work
  children.push(
    new Paragraph({
      text: "Scope of Work",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 100 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "Valuation process and methodology — the appraiser employed the following procedures to determine the value conclusions rendered herein:",
      spacing: { after: 60 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "Review and analysis of asset records and other informational materials.",
      bullet: { level: 0 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `Inspection and analysis of assets and equipment at the client location(s).`,
      bullet: { level: 0 },
    })
  );

  // Observations and Comments
  children.push(
    new Paragraph({
      text: "Observations and Comments",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 60 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "Available data and market comparables utilized were up to 120 days old. Increased weighting was given to recent regionally specific comparables when available.",
    })
  );

  // Intended Users
  children.push(
    new Paragraph({
      text: "Intended Users",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 60 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "This appraisal is not intended to be reproduced or used for any purpose other than that outlined in this appraisal and is for the internal use of the client.",
    })
  );

  // Value Terminology — OLV
  children.push(
    new Paragraph({
      text: "Value Terminology",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 60 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      text: "Orderly Liquidation Value (OLV)",
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 40 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The estimated amount, expressed in terms of cash in Canadian dollars, that could typically be realized from a liquidation sale, with the seller being compelled to sell on an 'as-is condition, where-is location' basis, as of a specific date and over a 120 day period.",
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "For the purpose of this appraisal, we have considered a properly advertised and professionally managed privately negotiated sale scenario, over a period of 120 days, during normal business operations or while winding down operations, with the buyer responsible for dismantling and removal at their own risk and expense.",
    })
  );

  // Definitions and Obsolescence
  children.push(
    new Paragraph({
      text: "Definitions and Obsolescence",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      text: "Physical Deterioration",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "A form of depreciation where the loss in value or usefulness of a property is due to the using up or expiration of its useful life caused by wear and tear, deterioration, exposure to various elements, physical stresses, and similar factors.",
    })
  );
  children.push(
    new Paragraph({
      text: "Functional Obsolescence",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "A form of depreciation in which the loss in value or usefulness is caused by inefficiencies or inadequacies of the asset itself when compared to a more efficient or less costly replacement that newer technology has developed.",
    })
  );
  children.push(
    new Paragraph({
      text: "Economic Obsolescence",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "A form of depreciation or loss in value caused by external factors such as industry economics, availability of financing, legislation, increased cost of inputs without offsetting price increases, reduced demand, increased competition, inflation, or high interest rates.",
    })
  );
  children.push(
    new Paragraph({ text: "Depreciation", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The actual loss in value or worth of a property from all causes including physical deterioration, functional obsolescence, and economic obsolescence.",
    })
  );

  // Limiting Conditions and Critical Assumptions
  children.push(
    new Paragraph({
      text: "Limiting Conditions and Critical Assumptions",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({ text: "Asset Conditions", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `Certain information was provided to the appraiser regarding repairs, engines, undercarriages, and upgrades. These were considered when appraising and comparing the subject assets with market comparables. Some assets may have extended warranties.`,
    })
  );
  children.push(
    new Paragraph({
      text: "Title to the Assets",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "No investigation has been made of, and no responsibility is assumed for, legal matters including title or encumbrances. Title is assumed to be good and marketable unless otherwise stated.",
    })
  );
  children.push(
    new Paragraph({
      text: "Responsible Ownership",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "It is assumed that the subject assets are under responsible ownership and competent management.",
    })
  );
  children.push(
    new Paragraph({ text: "Stated Purpose", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "This appraisal and report have been made only for the stated purpose and cannot be used for any other purpose.",
    })
  );
  children.push(
    new Paragraph({ text: "Valuation Date", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `The valuation date is ${formatDateUS(reportData?.effective_date) || "the effective date"}; values are in Canadian dollars as of that date.`,
    })
  );
  children.push(
    new Paragraph({ text: "Inspection", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `The subject assets were inspected ${formatMonthYear(reportData?.inspection_date) ? `in ${formatMonthYear(reportData?.inspection_date)}` : "as noted in the report"}. When the inspection date differs from the valuation date, no material change is assumed unless otherwise stated.`,
    })
  );
  children.push(
    new Paragraph({
      text: "Hazardous Substances",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "No allowance has been made for potential environmental problems. The value estimate assumes full compliance with applicable regulations and the absence of hazardous materials unless stated.",
    })
  );
  children.push(
    new Paragraph({
      text: "Change in Market Conditions",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "We are not responsible for changes in market conditions after the valuation date and have no obligation to revise the report for subsequent events.",
    })
  );
  children.push(
    new Paragraph({
      text: "Unexpected Conditions",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "It is assumed there are no hidden or non-apparent conditions that would affect value. No responsibility is assumed for such conditions.",
    })
  );

  // Company, Subject Asset Description
  children.push(
    new Paragraph({
      text: "Company, Subject Asset Description",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      text: "Company Discussion",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `${purposeClient} operates across multiple divisions and locations. The subject engagement focuses on relevant operating divisions connected to the subject assets.`,
    })
  );
  children.push(
    new Paragraph({
      text: "Subject Assets Discussion",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The major subject assets include Construction and Transportation equipment. Overall, these were found to be in good to excellent condition, subject to the assumptions and limiting conditions.",
    })
  );

  // Approaches to Value
  children.push(
    new Paragraph({
      text: "Approaches to Value",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({ text: "Cost Approach", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "A set of procedures in which an appraiser derives a value indication by estimating the current cost to reproduce or replace the assets, deducting for all depreciation, including physical deterioration, functional obsolescence, and external or economic obsolescence.",
    })
  );
  children.push(
    new Paragraph({
      text: "Sales Comparison (Market) Approach",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "A set of procedures in which an appraiser derives a value indication by comparing the assets being appraised with similar assets that have been sold recently and making appropriate adjustments.",
    })
  );
  children.push(
    new Paragraph({
      text: "Income Capitalization Approach",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "A set of procedures in which an appraiser derives a value indication for income-producing assets by converting anticipated benefits into value via capitalization or discounting of cash flows.",
    })
  );
  children.push(
    new Paragraph({
      text: "Alternate Use & Appropriate Market Approach",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "We considered the appropriate market and level of trade, availability of reliable market data, market conditions as of the valuation date, and a marketing period consistent with the intended use identified.",
    })
  );
  children.push(
    new Paragraph({
      text: "Reconciliation of Valuation Approaches",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "The Cost and Market approaches were utilized and reconciled. The Income approach was considered but not applied for reasons discussed within this report.",
    })
  );
  children.push(
    new Paragraph({
      text: "Highest and Best Use",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "We considered the highest and best use of the subject assets, including what is legally permissible, physically possible, financially feasible, and maximally productive.",
    })
  );

  // Valuation Process and Methodology
  children.push(
    new Paragraph({
      text: "Valuation Process and Methodology",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({ text: "Data Collection", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: `Site visits were performed ${formatMonthYear(reportData?.inspection_date) ? `in ${formatMonthYear(reportData?.inspection_date)}` : "as required"}. Discussions with client personnel informed our understanding of operations and maintenance policies.`,
    })
  );
  children.push(
    new Paragraph({
      text: "Valuation Process",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "We considered the income, sales comparison, and cost approaches and concluded on the appropriate methods given the asset types and available data.",
    })
  );
  children.push(
    new Paragraph({
      text: "Research Methodology",
      heading: HeadingLevel.HEADING_2,
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      text: "Research included auction and dealer results, OEM data, used equipment marketplaces, and current market/geographic conditions for similar assets.",
    })
  );

  // Code of Ethics
  children.push(
    new Paragraph({
      text: "Code of Ethics",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 80 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({ text: "Competency", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      text: "The appraiser has the appropriate knowledge and experience to develop credible results for the purpose and use outlined in this report.",
      style: "BodyLarge",
    })
  );
  children.push(
    new Paragraph({ text: "Confidentiality", heading: HeadingLevel.HEADING_2 })
  );
  children.push(
    new Paragraph({
      text: "This report and supporting file documentation are confidential. Distribution to parties other than the client requires prior written consent.",
      style: "BodyLarge",
    })
  );

  // Valuation Comparison Table (if enabled)
  if (reportData?.include_valuation_table && reportData?.valuation_data) {
    const { buildValuationTable } = await import("./builders/valuationTable.js");
    children.push(...(await buildValuationTable(reportData, lang)));
  }

  // Market Overview via builder
  children.push(...(await buildMarketOverview(reportData)));

  // Scope & Methodology
  children.push(
    new Paragraph({
      text: "Scope & Methodology",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      text: "We considered the Cost and Market approaches, relying primarily on recent market observations for comparable equipment and informed adjustments for condition and utility. Data sources include client-provided documentation, site observations (where applicable), and industry publications.",
      style: "BodyLarge",
    })
  );
  children.push(
    new Paragraph({
      text: "Where direct market comparables were limited, we applied reasoned judgment using category-level trends and depreciation profiles consistent with typical service lives.",
      style: "BodyLarge",
    })
  );

  // Assumptions & Limiting Conditions
  children.push(
    new Paragraph({
      text: "Assumptions & Limiting Conditions",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  const assumptions = [
    "Information provided by the client is assumed to be accurate and complete.",
    "No responsibility is assumed for legal title, liens, or encumbrances.",
    "Values reflect the stated premise of value as of the effective date only.",
    "This report is intended solely for the stated purpose and client use.",
  ];
  for (const a of assumptions) {
    children.push(
      new Paragraph({
        text: a,
        style: "BodyLarge",
        bullet: { level: 0 },
        spacing: { after: 40 },
      })
    );
  }

  // Definitions
  children.push(
    new Paragraph({
      text: "Definitions",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  const definitions = [
    "Fair Market Value: The price at which the property would change hands between a willing buyer and seller, neither being under compulsion and both having reasonable knowledge of relevant facts.",
    "Orderly Liquidation Value: The estimated gross amount realizable from the sale of assets with a reasonable period of marketing and negotiation.",
  ];
  for (const d of definitions) {
    children.push(
      new Paragraph({
        text: d,
        style: "BodyLarge",
        bullet: { level: 0 },
        spacing: { after: 40 },
      })
    );
  }

  // EXPERIENCE
  const expSize = 26; // ~13pt
  children.push(
    new Paragraph({
      text: "EXPERIENCE",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 160 },
    })
  );
  children.push(goldDivider());
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "McDougall Auctioneers Ltd. is one of Western Canada’s leading full-service auction and valuation firms, with over 40 years of experience in marketing, selling, and appraising assets across a diverse range of industries. Headquartered in Saskatchewan and operating throughout Canada and the United States, McDougall Auctioneers has built a reputation for impartial, defensible valuations that meet or exceed industry and regulatory standards.",
        }),
      ],
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Our appraisal team combines Certified Personal Property Appraisers, experienced auctioneers, and subject-matter specialists who have inspected and valued tens of thousands of assets annually. We deliver comprehensive appraisals for equipment, vehicles, industrial machinery, agricultural assets, and business inventories, using recognised methodologies such as the Market Approach, Cost Approach, and, where applicable, the Income Approach. All assignments are performed in compliance with the Uniform Standards of Professional Appraisal Practice (USPAP) and relevant Canadian appraisal guidelines.",
        }),
      ],
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "McDougall’s extensive auction platform provides us with current, real-world market data on comparable sales. This proprietary database allows us to support our valuations with up-to-date evidence of pricing trends, demand fluctuations, and liquidation values. Whether for insurance, financing, litigation, or internal asset management, our appraisals provide accurate, timely, and defensible fair market values.",
        }),
      ],
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Our industry experience spans construction, transportation, agriculture, heavy equipment, manufacturing, and retail inventories. We are frequently engaged by banks, insolvency professionals, legal counsel, government agencies, and private owners to appraise assets ranging from single high-value machines to large, multi-site fleets.",
        }),
      ],
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This depth of experience ensures that every McDougall appraisal assignment is approached with professionalism, objectivity, and an understanding of how market conditions translate into asset value. Clients can rely on McDougall Auctioneers for clear, well-documented reports that withstand scrutiny from lenders, courts, insurers, and auditors alike.",
        }),
      ],
    })
  );

  // Await evidence-bearing builders in final reading order. Catalogue grouping
  // is preserved first; the cross-lot appendix remains a distinct final block.
  const lotsChildren = await buildCatalogueLots(
    reportData,
    rootImageUrls,
    contentWidthTw
  );
  children.push(...lotsChildren);
  const appendixChildren = await buildAppendixPhotoGallery(
    reportData,
    rootImageUrls,
    contentWidthTw
  );
  children.push(...appendixChildren);

  // Construct the Document only after every async child is resolved so heading
  // discovery and pagination see one deterministic content sequence.
  const doc = new Document({
    creator:
      (reportData?.appraiser as string) ||
      (reportData?.inspector_name as string) ||
      "Asset Insight",
    title:
      (reportData?.title as string) || `Asset Catalogue - ${lots.length} Lots`,
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: {
            font: "Calibri",
            size: 26, // ~13pt base body size
            color: "111827", // gray-900
          },
          paragraph: {
            spacing: { line: 276, before: 0, after: 80 }, // slightly tighter
          },
        },
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          basedOn: "",
          next: "Normal",
          run: { font: "Calibri", size: 26, color: "111827" },
          paragraph: { spacing: { line: 276, after: 120 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 44, bold: true, color: "111827" }, // ~22pt
          paragraph: { spacing: { before: 180, after: 100 } },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 32, bold: true, color: "111827" }, // ~16pt
          paragraph: { spacing: { before: 140, after: 80 } },
        },
        {
          id: "BodyLarge",
          name: "Body Large",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 28, color: "111827" }, // ~14pt
          paragraph: { spacing: { line: 276, after: 80 } },
        },
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { size: 52, bold: true, color: "111827" }, // ~26pt
          paragraph: {
            spacing: { before: 160, after: 120 },
            alignment: AlignmentType.CENTER,
          },
        },
      ],
    },
    // Section order is an output contract: cover, TOC, transmittal, certificate,
    // then the numbered main body. Do not merge sections just to reduce code.
    sections: [
      // Cover (no header/footer)
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [] }) },
        footers: { default: new Footer({ children: [] }) },
        children: coverChildren,
      },
      // Table of Contents (no header/footer)
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [] }) },
        footers: { default: new Footer({ children: [] }) },
        children: tocChildren,
      },
      // Transmittal Letter (no header/footer)
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [] }) },
        footers: { default: new Footer({ children: [] }) },
        children: transmittalChildren,
      },
      // Certificate of Appraisal (no header/footer)
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: new Header({ children: [] }) },
        footers: { default: new Footer({ children: [] }) },
        children: certificateChildren as any,
      },
      // Main content (with header/footer). Restart page numbers at 1.
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
        headers: {
          default: new Header({ children: [headerTable] }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: tr.page }),
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

  // Packing completes the service contract; callers receive a ready-to-send DOCX.
  const buf = await Packer.toBuffer(doc);
  return buf;
}
