import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  TableLayoutType,
  AlignmentType,
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 9.0 VALUATION ANALYSIS
 * Presents approaches, property-type factors, reconciliation, and final estimate
 * in professional reading order. Report value and currency are resolved here but
 * are currently reserved for future value-specific rendering in this section.
 */
export function buildValuationAnalysis(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const propertyType = reportData?.property_type || "residential";
  const marketValue = reportData?.valuation?.fair_market_value || reportData?.fair_market_value || "TBD";
  const currency = reportData?.currency || "CAD";

  // Section Title
  children.push(
    new Paragraph({
      text: "9.0 VALUATION ANALYSIS",
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
          text: "This section outlines the valuation methodologies applied to the subject property and the analytical steps used to derive an opinion of market value. The approaches considered are consistent with accepted professional practice and are applied in accordance with relevant appraisal standards. Depending on the nature of the subject property (agricultural land, commercial building, or residential dwelling), certain approaches may carry greater relevance or weight in the final reconciliation.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 9.1 Overview of Approaches
  children.push(
    new Paragraph({
      text: "9.1 Overview of Approaches to Value Considered",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Three principal approaches to value were reviewed for applicability:",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // 1. Direct Comparison Approach
  children.push(
    new Paragraph({
      text: "1. Direct Comparison Approach",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This method analyzes sales of similar properties and adjusts for differences in physical, locational, and economic characteristics.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟩 Agricultural: ", bold: true }),
        new TextRun({ text: "Adjustments based on soil class, productivity, drainage, parcel size, and proximity to market." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟧 Commercial: ", bold: true }),
        new TextRun({ text: "Adjustments for income potential, building utility, quality, location, and exposure." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟪 Residential: ", bold: true }),
        new TextRun({ text: "Adjustments for living area, age, condition, features, and appeal." }),
      ],
      spacing: { after: 140 },
    })
  );

  // 2. Income Capitalization Approach
  children.push(
    new Paragraph({
      text: "2. Income Capitalization Approach",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This approach converts income—actual or market-derived—into a value estimate using an appropriate capitalization rate.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟧 Commercial: ", bold: true }),
        new TextRun({ text: "Rent roll, vacancy, expense ratios, stabilized NOI, cap rate derivation." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟩 Agricultural: ", bold: true }),
        new TextRun({ text: "Cash rent analysis for farmland." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟪 Residential: ", bold: true }),
        new TextRun({ text: "Applied only in income-producing residential properties." }),
      ],
      spacing: { after: 140 },
    })
  );

  // 3. Cost Approach
  children.push(
    new Paragraph({
      text: "3. Cost Approach",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This method estimates the value of the land plus the depreciated replacement cost of improvements.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟪 Residential: ", bold: true }),
        new TextRun({ text: "Replacement cost new less depreciation." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟧 Commercial: ", bold: true }),
        new TextRun({ text: "Applied when improvements are special-use or recently constructed." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟩 Agricultural: ", bold: true }),
        new TextRun({ text: "Used only if meaningful site improvements exist (e.g., drainage works, fencing, irrigation)." }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "All approaches were reviewed; however, the relevance of each varies with property type and market evidence available.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 9.2 Direct Comparison Approach
  children.push(
    new Paragraph({
      text: "9.2 Direct Comparison Approach",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The Direct Comparison Approach evaluates market transactions involving similar properties, adjusting the sale prices to reflect differences relative to the subject. Adjustments typically consider:",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Agricultural Land Factors
  children.push(
    new Paragraph({
      text: "Agricultural Land (Vacant Farmland) – Key Factors",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const agFactors = [
    "Soil capability and productivity rating (Class 2, 3, 4, etc.)",
    "Parcel size and configuration",
    "Drainage, topography, and water management",
    "Proximity to service centres and paved roads",
    "Market demand for agricultural expansion or investment",
  ];

  agFactors.forEach((f) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${f}` })],
        spacing: { after: 60 },
      })
    );
  });

  // Commercial Properties Factors
  children.push(
    new Paragraph({
      text: "Commercial Properties – Key Factors",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const comFactors = [
    "Building condition, functional utility, age",
    "Lease profile (market rent, vacancy, tenant covenant strength)",
    "Exposure, access, zoning, and location desirability",
    "Site improvements, parking, and land-to-building ratio",
  ];

  comFactors.forEach((f) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${f}` })],
        spacing: { after: 60 },
      })
    );
  });

  // Residential Properties Factors
  children.push(
    new Paragraph({
      text: "Residential Properties – Key Factors",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const resFactors = [
    "Living area, room count, layout efficiency",
    "Interior and exterior condition",
    "Garage size, basement development, lot appeal",
    "Upgrades, renovations, and functional obsolescence",
  ];

  resFactors.forEach((f) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${f}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "For each comparable sale, adjustments are quantified in monetary or percentage terms. Sales are then bracketed around the subject property to develop an indicated value range.",
        }),
      ],
      spacing: { before: 120, after: 200 },
    })
  );

  // 9.3 Income Capitalization Approach
  children.push(
    new Paragraph({
      text: "9.3 Income Capitalization Approach (if applicable)",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Where the subject or comparable properties produce income, the Income Capitalization Approach provides an additional and often more objective indicator of value.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      text: "Commercial Properties",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const comIncome = [
    "Market rent analysis (contract vs. market levels)",
    "Stabilized vacancy and collection loss",
    "Operating expenses and expense recoveries",
    "Derivation of Net Operating Income (NOI)",
    "Capitalization rate support using market sales, lender surveys, or investor expectations",
  ];

  comIncome.forEach((i) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${i}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(
    new Paragraph({
      text: "Agricultural Land",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "When the farmland is leased or capable of producing cash rent:",
        }),
      ],
      spacing: { after: 80 },
    })
  );

  const agIncome = [
    "Cash rent per acre",
    "Typical local vacancy (often negligible)",
    "Farmland capitalization rates (usually 3.5–6%)",
  ];

  agIncome.forEach((i) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${i}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(
    new Paragraph({
      text: "Residential",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Only applicable for investment-oriented residential property (rental houses, duplexes, multi-unit dwellings). The resulting income-based value is compared against the direct comparison indication for consistency.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 9.4 Cost Approach
  children.push(
    new Paragraph({
      text: "9.4 Cost Approach (if applicable)",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The Cost Approach estimates the value of the land plus the depreciated cost of any improvements. It is most relevant where improvements are new, specialized, or where market sales are limited.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      text: "Procedure:",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const costSteps = [
    "Estimate replacement cost new (RCN) of improvements",
    "Deduct physical, functional, and external depreciation",
    "Add market value of land (vacant land estimate)",
    "Adjust for site improvements such as fencing, drainage, landscaping, etc.",
  ];

  costSteps.forEach((s) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${s}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(
    new Paragraph({
      text: "Applications by Property Type:",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟪 Residential: ", bold: true }),
        new TextRun({ text: "Useful for newer dwellings or when estimating contributory value of renovations." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟧 Commercial: ", bold: true }),
        new TextRun({ text: "Applied when improvements are unique or engineered (industrial shops, warehouses)." }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟩 Agricultural: ", bold: true }),
        new TextRun({ text: "Limited use; applied only if substantial improvements exist." }),
      ],
      spacing: { after: 200 },
    })
  );

  // Reconciliation follows the three approach discussions. Moving it earlier
  // would present weights before the evidence those weights are intended to sum.
  // 9.5 Reconciliation
  children.push(
    new Paragraph({
      text: "9.5 Reconciliation of Indications",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Each valuation approach provides an independent indication of value. The final opinion of value reflects the following considerations:",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  const reconcileFactors = [
    "Data reliability (quality and relevance of comparable sales or rental data)",
    "Market behaviour (do buyers rely on income, sales comparison, or cost?)",
    "Property characteristics (type, use, condition, income stability)",
    "Strengths and limitations of each valuation method",
  ];

  reconcileFactors.forEach((f) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${f}` })],
        spacing: { after: 60 },
      })
    );
  });

  // Fixed table widths and row order make approach weights directly comparable;
  // contentWidthTw remains the boundary for every declared column.
  // Weighting table
  children.push(
    new Paragraph({
      text: "Likely Weighting by Property Type:",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );

  const weightTable = new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [
      Math.round(contentWidthTw * 0.25),
      Math.round(contentWidthTw * 0.25),
      Math.round(contentWidthTw * 0.25),
      Math.round(contentWidthTw * 0.25),
    ],
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
            shading: { fill: "DC2626" },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Property Type", bold: true, color: "FFFFFF" })] })],
          }),
          new TableCell({
            shading: { fill: "DC2626" },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Primary Approach", bold: true, color: "FFFFFF" })] })],
          }),
          new TableCell({
            shading: { fill: "DC2626" },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Secondary Approach", bold: true, color: "FFFFFF" })] })],
          }),
          new TableCell({
            shading: { fill: "DC2626" },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Notes", bold: true, color: "FFFFFF" })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "🟩 Agricultural" })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Direct Comparison" })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Income (support only)" })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Farmland buyers rely on sales" })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "🟧 Commercial" })] })],
          }),
          new TableCell({
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Income Approach" })] })],
          }),
          new TableCell({
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Direct Comparison" })] })],
          }),
          new TableCell({
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Investors prioritize NOI" })] })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "🟪 Residential" })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Direct Comparison" })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Cost Approach" })] })],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: "Market data-driven" })] })],
          }),
        ],
      }),
    ],
  });
  children.push(weightTable);

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The final reconciled value typically aligns with the approach most reflective of buyer and seller behaviour in the market segment.",
        }),
      ],
      spacing: { before: 140, after: 200 },
    })
  );

  // 9.6 Final Estimate
  children.push(
    new Paragraph({
      text: "9.6 Final Estimate of Market Value",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "Based on:", bold: true }),
      ],
      spacing: { after: 100 },
    })
  );

  const finalBasis = [
    "The methodologies applied",
    "Analysis of comparable sales",
    "Income and cost indicators (where applicable)",
    "Market conditions",
    "The highest and best use of the subject property",
  ];

  finalBasis.forEach((b) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${b}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "A final opinion of market value is developed as of the effective date of appraisal.",
        }),
      ],
      spacing: { before: 120, after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The conclusion reflects the most credible and defensible estimate supported by available market evidence and professional judgment.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
