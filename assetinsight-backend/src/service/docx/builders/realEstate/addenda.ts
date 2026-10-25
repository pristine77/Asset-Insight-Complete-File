import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 12.0 ADDENDA AND SUPPORTING DOCUMENTATION
 * Builds the addenda listing section
 */
export function buildAddenda(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const inspectorName = reportData?.inspector_name || reportData?.appraiser || "";

  // Section Title
  children.push(
    new Paragraph({
      text: "12.0 ADDENDA AND SUPPORTING DOCUMENTATION",
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
          text: "The following addenda and supporting documentation are included as part of this appraisal report:",
        }),
      ],
      spacing: { after: 160 },
    })
  );

  // Addenda list
  const addendaItems = [
    { num: "12.1", title: "Appraiser Qualifications and Certification" },
    { num: "12.2", title: "Certificate of Title and Legal Plan" },
    { num: "12.3", title: "Comparable Sales Sheets" },
    { num: "12.4", title: "Location and Zoning Maps" },
    { num: "12.5", title: "Building Plans and Floor Layouts (if applicable)" },
    { num: "12.6", title: "Photographs – Site and Improvements" },
    { num: "12.7", title: "Soil Capability and Land Use Maps (Agricultural)" },
    { num: "12.8", title: "Market Data Charts and Trend Graphs" },
    { num: "12.9", title: "Glossary of Terms and Definitions" },
    { num: "12.10", title: "References and Data Sources" },
  ];

  addendaItems.forEach((item) => {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${item.num} `, bold: true, color: "DC2626" }),
          new TextRun({ text: item.title }),
        ],
        spacing: { after: 100 },
      })
    );
  });

  children.push(new Paragraph({ spacing: { after: 160 } }));

  // 12.1 Appraiser Qualifications
  children.push(
    new Paragraph({
      text: "12.1 Appraiser Qualifications and Certification",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `The appraiser, ${inspectorName || "[Appraiser Name]"}, is a designated member of the Appraisal Institute of Canada (AIC) and holds the appropriate designation for this type of assignment.`,
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
          text: "The appraiser has completed the educational requirements and continuing professional development necessary to maintain active membership status. A current curriculum vitae or summary of qualifications is available upon request.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 12.9 Glossary
  children.push(
    new Paragraph({
      text: "12.9 Glossary of Terms and Definitions",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  const glossaryTerms = [
    {
      term: "Market Value",
      def: "The most probable price a property should bring in a competitive and open market, assuming a willing buyer and seller, reasonable exposure time, and no compulsion.",
    },
    {
      term: "Fee Simple",
      def: "Absolute ownership of real property, unencumbered by any other interest except governmental powers.",
    },
    {
      term: "Highest and Best Use",
      def: "The reasonably probable use that is legally permissible, physically possible, financially feasible, and maximally productive.",
    },
    {
      term: "Direct Comparison Approach",
      def: "A valuation method that analyzes sales of comparable properties and adjusts for differences.",
    },
    {
      term: "Income Capitalization Approach",
      def: "A valuation method that converts income into value using a capitalization rate.",
    },
    {
      term: "Cost Approach",
      def: "A valuation method that estimates land value plus depreciated cost of improvements.",
    },
    {
      term: "Effective Date",
      def: "The date as of which the opinion of value applies.",
    },
    {
      term: "Exposure Time",
      def: "The estimated period a property would have been offered for sale prior to achieving the appraised value.",
    },
    {
      term: "Marketing Period",
      def: "The estimated time required to sell a property after the valuation date.",
    },
    {
      term: "CUSPAP",
      def: "Canadian Uniform Standards of Professional Appraisal Practice – the standards governing appraisal practice in Canada.",
    },
  ];

  glossaryTerms.forEach((item) => {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${item.term}: `, bold: true }),
          new TextRun({ text: item.def }),
        ],
        spacing: { after: 100 },
      })
    );
  });

  children.push(new Paragraph({ spacing: { after: 160 } }));

  // 12.10 References
  children.push(
    new Paragraph({
      text: "12.10 References and Data Sources",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The following sources were referenced in the preparation of this appraisal:",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  const references = [
    "Provincial Land Titles Registry",
    "Municipal Assessment and Taxation Records",
    "Local Real Estate Board / MLS® Transaction Data",
    "Farm Credit Canada (FCC) Farmland Values Report",
    "Statistics Canada – Economic and Demographic Data",
    "Appraisal Institute of Canada – CUSPAP Standards",
    "International Valuation Standards (IVS)",
    "Local Planning and Zoning Bylaws",
    "Interviews with Local Market Participants",
  ];

  references.forEach((ref) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${ref}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(new Paragraph({ spacing: { after: 200 } }));

  // End of Report
  children.push(
    new Paragraph({
      alignment: "center" as any,
      spacing: { before: 300, after: 200 },
      children: [
        new TextRun({
          text: "— END OF APPRAISAL REPORT —",
          bold: true,
          color: "DC2626",
          size: 28,
        }),
      ],
    })
  );

  return children;
}
