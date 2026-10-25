import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 4.0 SCOPE OF THE APPRAISAL ASSIGNMENT
 * Combines assignment facts with fixed scope narrative. Field fallback precedence
 * supports legacy reports; chapter order remains aligned with report navigation.
 */
export function buildScopeOfAppraisal(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const propertyType = reportData?.property_type || "residential";
  const clientName = reportData?.client_name || reportData?.owner_name || "Client";

  // Section Title
  children.push(
    new Paragraph({
      text: "4.0 SCOPE OF THE APPRAISAL ASSIGNMENT",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 200 },
    })
  );
  children.push(goldDivider());

  // 4.1 Purpose and Function
  children.push(
    new Paragraph({
      text: "4.1 Purpose and Function of the Appraisal",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The purpose of this appraisal is to develop an independent and supported opinion of the current market value of the subject property as of the effective date of valuation.",
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
          text: "The function of this report is to provide the client and intended users with credible and relevant information to assist in decision-making, such as acquisition, sale, financing, asset management, or internal review.",
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
          text: "This report has been prepared in accordance with the Canadian Uniform Standards of Professional Appraisal Practice (CUSPAP) and, where applicable, the International Valuation Standards (IVS).",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 4.2 Intended Use and Users
  children.push(
    new Paragraph({
      text: "4.2 Intended Use and Users",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The intended use of this appraisal is to assist the client in evaluating the market value of the property for the specific purpose stated above.",
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
          text: "The intended users are limited to the client and authorized parties identified in this report.",
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
          text: "No other party may rely upon or use this document for any purpose without the written consent of the appraiser. Unauthorized use or distribution is strictly prohibited.",
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
          text: "This appraisal is not intended for legal proceedings, public disclosure, or any other use beyond the purpose for which it was commissioned.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 4.3 Property Rights Appraised
  children.push(
    new Paragraph({
      text: "4.3 Property Rights Appraised (Fee Simple / Leasehold)",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This report considers the market value of the Fee Simple interest in the subject property, as defined by CPPA and customary valuation practice.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "Fee Simple Interest: ", bold: true }),
        new TextRun({
          text: "Absolute ownership unencumbered by any other interest, subject only to the limitations of government powers such as taxation, expropriation, police power, and escheat.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "Leasehold Interest: ", bold: true }),
        new TextRun({
          text: "The right held by a tenant or lessee to use and occupy property for a defined term under the conditions specified in a lease agreement.",
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
          text: "Unless otherwise stated, this appraisal assumes ownership in fee simple and reflects the value of the property free of any encumbrances except those typically encountered for similar assets.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 4.4 Scope of Work and Methodology
  children.push(
    new Paragraph({
      text: "4.4 Scope of Work and Methodology",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The scope of this assignment was established following the Scope of Work Rule of CPPA.",
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
          text: "The appraiser determined the appropriate level of research, verification, and analysis necessary to produce a credible result based on the following elements:",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  const scopeElements = [
    "Inspection of the subject property and surrounding area",
    "Collection and analysis of relevant market, economic, and legal data",
    "Verification of comparable sales, listings, and market indicators",
    "Application of valuation approaches appropriate to the property type (Direct Comparison, Cost, and/or Income Capitalization)",
    "Development of a reasoned and supported opinion of value",
  ];

  scopeElements.forEach((elem) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${elem}` })],
        spacing: { after: 80 },
      })
    );
  });

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The depth of research and analysis corresponds to the property's complexity and the intended use of this appraisal.",
        }),
      ],
      spacing: { before: 120, after: 200 },
    })
  );

  // 4.5 Research, Verification, and Data Sources
  children.push(
    new Paragraph({
      text: "4.5 Research, Verification, and Data Sources",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Data utilized in this appraisal were obtained from a variety of primary and secondary sources, including:",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  const dataSources = [
    "Provincial land registry and assessment records",
    "Municipal planning and zoning departments",
    "Real estate transaction databases and market listings",
    "Interviews with buyers, sellers, agents, and market participants",
    "Published industry reports and agricultural, commercial, or residential market studies",
  ];

  dataSources.forEach((source) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${source}` })],
        spacing: { after: 80 },
      })
    );
  });

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Wherever possible, information was verified through independent sources. When direct verification was not feasible, data were considered reliable if consistent with market trends and other corroborated evidence.",
        }),
      ],
      spacing: { before: 120, after: 200 },
    })
  );

  // 4.6 Environmental Review
  children.push(
    new Paragraph({
      text: "4.6 Environmental Review and Legal Context",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "No formal environmental audit, geotechnical investigation, or legal title opinion was undertaken as part of this assignment.",
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
          text: "The appraisal assumes that the property is free from adverse environmental conditions or contamination and that it complies with all applicable municipal, provincial, and federal laws, including zoning and environmental regulations.",
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
          text: "The legal context considered includes ownership rights, encumbrances, easements, and zoning controls, based on documentation reviewed from public records or information provided by the client.",
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
          text: "The appraiser is not responsible for discovering or reporting hidden or latent conditions that could affect the property's value.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 4.7 Limitations
  children.push(
    new Paragraph({
      text: "4.7 Limitations of the Assignment",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This appraisal is limited by the scope of work, data availability, and time constraints applicable to this engagement.",
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
          text: "The analysis is based on information deemed reliable; however, the appraiser cannot guarantee its accuracy or completeness.",
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
          text: "The valuation represents the appraiser's professional opinion as of the effective date only and does not predict future market behaviour.",
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
          text: "No warranty is expressed or implied regarding the continued validity of this opinion beyond that date.",
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
          text: "The appraiser's liability in connection with this report is limited to the fee received for this assignment.",
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
          text: "Use of this report for any purpose other than that expressly intended is at the user's own risk.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
