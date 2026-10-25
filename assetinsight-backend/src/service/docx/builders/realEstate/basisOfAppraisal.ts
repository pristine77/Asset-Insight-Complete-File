import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 5.0 BASIS OF THE APPRAISAL
 * Builds the basis section with market value definition and assumptions
 */
export function buildBasisOfAppraisal(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];

  // Section Title
  children.push(
    new Paragraph({
      text: "5.0 BASIS OF THE APPRAISAL",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 200 },
    })
  );
  children.push(goldDivider());

  // 5.1 Definition of Market Value
  children.push(
    new Paragraph({
      text: "5.1 Definition of Market Value",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "For the purpose of this report, ", bold: false }),
        new TextRun({ text: "Market Value", bold: true }),
        new TextRun({ text: " is defined as:" }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: '"The most probable price, as of the effective date of valuation, that a property should bring after reasonable exposure in a competitive and open market under all conditions requisite to a fair sale, with the buyer and seller each acting prudently, knowledgeably, and without compulsion."',
          italics: true,
          color: "DC2626",
        }),
      ],
      spacing: { after: 160 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This definition is consistent with the meaning adopted by the CPPA. The value estimate represents the appraiser's opinion of what a typical, informed purchaser would pay to acquire the subject property in a transaction conducted at arm's length.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 5.2 Interest and Rights Appraised
  children.push(
    new Paragraph({
      text: "5.2 Interest and Rights Appraised",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Unless otherwise stated, this appraisal reflects the market value of the property in ",
        }),
        new TextRun({ text: "fee simple interest", bold: true }),
        new TextRun({
          text: ", meaning absolute ownership of real property, unencumbered except by the limitations of governmental powers (taxation, expropriation, police power, and escheat).",
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
          text: "If another form of ownership is applicable—such as leasehold, life estate, or partial interest—it is specifically identified and analyzed within this report.",
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
          text: "The appraisal assumes that the title is valid, marketable, and free of undisclosed liens, restrictions, or encumbrances that could materially affect value.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 5.3 Exposure and Marketing Periods
  children.push(
    new Paragraph({
      text: "5.3 Exposure and Marketing Periods",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "Exposure time ", bold: true }),
        new TextRun({
          text: "refers to the estimated period a property would have been offered on the market prior to the hypothetical sale on the effective date at the appraised value.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "Marketing period ", bold: true }),
        new TextRun({
          text: "represents the anticipated length of time the property would remain on the market after the effective date before achieving a sale at or near the concluded market value.",
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
          text: "Both estimates are based on prevailing market activity, supply-and-demand conditions, and discussions with active market participants.",
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
          text: "For typical properties in this category and market area, exposure and marketing periods generally range from 3 to 12 months, depending on property type and economic conditions.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 5.4 Assumptions Related to Market Stability
  children.push(
    new Paragraph({
      text: "5.4 Assumptions Related to Market Stability",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This valuation is based on current market data and economic conditions as of the effective date.",
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
          text: "It assumes that no significant disruption occurs in interest rates, commodity pricing, credit availability, or other factors influencing demand for similar properties.",
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
          text: "The analysis presumes an environment of reasonably stable market conditions, with buyers and sellers acting prudently and informed by prevailing trends.",
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
          text: "Should material changes in market or regulatory conditions occur after the effective date, the conclusions herein may no longer reflect current value.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 5.5 Jurisdictional Exceptions
  children.push(
    new Paragraph({
      text: "5.5 Jurisdictional Exceptions and Professional Standards",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This appraisal has been developed in accordance with CPPA. Where applicable, the report also conforms to the principles of the International Valuation Standards (IVS) to ensure consistency with global best practice.",
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
          text: "No jurisdictional exceptions have been applied unless expressly stated within this report.",
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
          text: "If any local or statutory requirements conflict with CUSPAP or IVS, the appraiser has applied the standard that results in the most transparent and credible valuation, with full disclosure provided.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
