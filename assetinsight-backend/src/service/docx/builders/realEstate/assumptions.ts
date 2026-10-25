import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 3.0 ASSUMPTIONS, LIMITING CONDITIONS, AND LIABILITY CONSIDERATIONS
 * Emits the complete assumptions in their numbered legal reading order. These
 * clauses are explicit document children rather than data-driven sorting because
 * order and wording must remain stable for professional review.
 */
export function buildAssumptionsSection(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];

  // Section Title
  children.push(
    new Paragraph({
      text: "3.0 ASSUMPTIONS, LIMITING CONDITIONS, AND LIABILITY CONSIDERATIONS",
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
        new TextRun({
          text: "The certification provided in this report is subject to compliance with the Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP), the Personal Information Protection and Electronic Documents Act (PIPEDA), and the following assumptions and limiting conditions. These conditions are fundamental to the analyses, opinions, and conclusions expressed within this document.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 3.1 General Assumptions
  children.push(
    new Paragraph({
      text: "3.1 GENERAL ASSUMPTIONS AND CONDITIONS",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  // Intended Use and Reliance
  children.push(
    new Paragraph({
      text: "Intended Use and Reliance",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This report has been prepared exclusively for the client and for the specific purpose identified herein. No other party may rely upon this appraisal without the prior written consent of both the client and the author. Any unauthorized use or reliance upon this report is strictly prohibited. The appraiser accepts no liability to any third party or for any use other than that expressly stated.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Market Conditions
  children.push(
    new Paragraph({
      text: "Market Conditions and Effective Date",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Market, economic, and political conditions may change over time. Therefore, the analyses and conclusions contained herein apply only as of the effective date of valuation. The appraiser assumes no responsibility for subsequent changes that could influence the market value of the subject property after that date.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Legal and Title
  children.push(
    new Paragraph({
      text: "Legal and Title Matters",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "No responsibility is assumed for legal matters affecting title to the property, including ownership disputes, easements, encroachments, or other encumbrances. The title is assumed to be valid and marketable unless otherwise noted. Verification of legal ownership, rights-of-way, or registered encumbrances lies outside the scope of this assignment.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Compliance
  children.push(
    new Paragraph({
      text: "Compliance with Laws and Regulations",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Unless otherwise stated, it is assumed that the subject property complies with all applicable zoning bylaws, building codes, environmental regulations, and other governmental requirements. Any information provided by third parties regarding such compliance has been accepted as accurate, and the appraiser has not independently verified it.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Survey
  children.push(
    new Paragraph({
      text: "Survey, Measurements, and Boundaries",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "No formal survey of the property was provided. Any diagrams or sketches included in this report are intended solely for illustrative purposes and should not be relied upon as legal surveys. It is assumed that property boundaries and dimensions are as described in the official title documentation.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Environmental
  children.push(
    new Paragraph({
      text: "Environmental and Soil Conditions",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The appraiser is not qualified to detect or evaluate environmental contamination, hazardous substances, or soil deficiencies. The value estimate assumes that no adverse environmental or geotechnical conditions exist on or near the property that would affect its marketability or usability.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Condition of Property
  children.push(
    new Paragraph({
      text: "Condition of the Property",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The property inspection was visual in nature and did not include structural, mechanical, or engineering assessments. It is assumed that the site is stable and suitable for its current and anticipated uses.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Confidentiality
  children.push(
    new Paragraph({
      text: "Confidentiality",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "All information contained within this report is confidential and intended solely for the client. Disclosure to any other party is permitted only as required by law or with the written consent of the appraiser and client.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Electronic Transmission
  children.push(
    new Paragraph({
      text: "Electronic Transmission and Authenticity",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "If transmitted electronically, this report may contain a secure digital signature. Only reports transmitted directly from the appraiser or bearing an original or verified digital signature may be relied upon as authentic.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Currency
  children.push(
    new Paragraph({
      text: "Currency and Taxation",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "All monetary amounts are stated in Canadian dollars and are exclusive of Goods and Services Tax (GST), unless otherwise noted.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Liability
  children.push(
    new Paragraph({
      text: "Liability Limitation",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The total liability of the appraiser and appraisal firm for any claim arising out of or relating to this assignment shall not exceed the total professional fee charged for the preparation of this report.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 3.2 Extraordinary Assumptions
  children.push(
    new Paragraph({
      text: "3.2 EXTRAORDINARY ASSUMPTIONS AND SPECIAL LIMITING CONDITIONS",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      text: "Extraordinary Limiting Condition – Availability of Data",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The valuation relies on information from public records, municipal data, and market sources deemed reliable. Where specific data could not be independently verified, such information has been accepted as accurate. Any future verification or discovery of errors in this data could influence the final market value conclusion.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      text: "Future Land Use Potential",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The report assumes that the property will continue to be used for its current purposes unless rezoning or subdivision approval is formally obtained. Any change in land use regulations or development policy could alter the highest and best use conclusion and, consequently, the market value.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      text: "Reliance and Use",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This report is intended solely for internal decision-making related to the potential acquisition or sale of the subject property. It should not be used for financing, legal proceedings, or taxation purposes without the written consent of the appraiser.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 3.3 Environmental, Legal, and Physical
  children.push(
    new Paragraph({
      text: "3.3 ENVIRONMENTAL, LEGAL, AND PHYSICAL LIMITATIONS",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This appraisal is based on the assumption that the subject property is free from any adverse environmental conditions or substances that could negatively influence its marketability, utility, or value.",
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
          text: "The appraiser is not qualified to detect, assess, or test for the presence of environmental contaminants, hazardous materials, or other physical deficiencies, including but not limited to asbestos, underground storage tanks, mould, radon gas, petroleum leakage, or chemical contamination. Unless otherwise stated, no environmental audit or geotechnical assessment was provided to the appraiser.",
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
          text: "The valuation assumes that the property complies with all applicable laws, regulations, and municipal bylaws, including zoning, environmental protection statutes, and building codes. Any non-compliance or violations that are subsequently discovered could materially affect the value conclusion presented in this report.",
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
          text: "The appraiser relied upon information obtained from municipal records, title searches, and other public sources that were deemed reliable but not independently verified in full detail. The appraiser disclaims responsibility for any undisclosed legal encumbrances, easements, liens, or restrictions that may affect title, access, or use of the property.",
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
          text: "Physical observations during inspection were limited to visual examination of accessible areas only. No intrusive testing, measurement validation, or engineering analysis was performed. The appraisal assumes the property is structurally sound and suitable for its intended or current use, unless otherwise noted within this report.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 3.4 Confidentiality and Liability
  children.push(
    new Paragraph({
      text: "3.4 CONFIDENTIALITY AND LIABILITY DISCLAIMER",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This appraisal report and all associated data are confidential and intended solely for the use of the client and identified intended users as specified in Section 1.3 of this report.",
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
          text: "No other party may rely upon, reproduce, or distribute this document, in whole or in part, without the prior written consent of both the client and the appraiser.",
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
          text: "The appraiser assumes no responsibility or liability to any person or entity other than the client for the content, interpretations, or conclusions contained in this report. Any use by unauthorized parties is at their own risk.",
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
          text: "Electronic versions of this report are provided solely for the convenience of the client. In the event of any discrepancy between the printed and electronic versions, the signed original copy maintained by the appraiser shall prevail as the authoritative record.",
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
          text: "The total aggregate liability of the appraiser and the appraisal firm arising out of or related to this assignment shall be strictly limited to the total professional fee charged for this engagement, regardless of cause, form of action, or theory of recovery.",
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
          text: "This limitation of liability is a fundamental condition of the engagement and has been considered in the determination of the professional fee.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
