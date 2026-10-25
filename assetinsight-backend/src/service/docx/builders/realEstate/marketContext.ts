import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 10.0 MARKET CONTEXT AND RISK ANALYSIS
 * Selects property-type trends within a fixed market/risk/exposure sequence.
 * Conditional detail may vary, but headings and fallbacks keep incomplete market
 * data from producing a structurally incomplete report.
 */
export function buildMarketContext(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];

  // Section Title
  children.push(
    new Paragraph({
      text: "10.0 MARKET CONTEXT AND RISK ANALYSIS",
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
          text: "This section summarizes the broader market environment and key risk factors that may influence the value and marketability of the subject property. The analysis considers macro-economic trends, regional conditions, sector-specific performance, and property-level sensitivities relevant to agricultural, commercial, and residential real estate.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 10.1 Market Trends
  children.push(
    new Paragraph({
      text: "10.1 Market Trends and Economic Conditions",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Market value is influenced by general economic conditions, interest rates, access to credit, and sector-specific dynamics. While each property is unique, the following broad trends are typically monitored:",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Agricultural trends
  children.push(
    new Paragraph({
      text: "🟩 Agricultural – Crop, Commodity, and Financing Trends",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const agTrends = [
    "Movements in crop prices, input costs, and net farm income",
    "Availability and cost of agricultural credit and farm financing",
    "Land rent levels, land-to-income ratios, and farmer demand for expansion",
    "Government support programs, crop insurance, and trade policy impacts",
  ];

  agTrends.forEach((t) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${t}` })],
        spacing: { after: 60 },
      })
    );
  });

  // Commercial trends
  children.push(
    new Paragraph({
      text: "🟧 Commercial – Leasing, Vacancy, and Capitalization Rates",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const comTrends = [
    "Local and regional vacancy rates by asset type (industrial, retail, office)",
    "Trends in market rents, tenant incentives, and lease terms",
    "Investor sentiment, capitalization rates, and transaction volumes",
    "Structural shifts in demand (e.g., e-commerce logistics, office hybrid use)",
  ];

  comTrends.forEach((t) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${t}` })],
        spacing: { after: 60 },
      })
    );
  });

  // Residential trends
  children.push(
    new Paragraph({
      text: "🟪 Residential – Absorption, Affordability, and Mortgage Rates",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  const resTrends = [
    "Sales volumes, days on market, and price trends for comparable dwellings",
    "Mortgage interest rates, lending standards, and housing affordability",
    "New construction activity and resale inventory levels",
    "Demographic factors such as household formation and migration patterns",
  ];

  resTrends.forEach((t) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${t}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The subject's market value conclusion reflects conditions as at the effective date of the appraisal and does not anticipate future structural changes beyond what is reasonably supported by available data.",
        }),
      ],
      spacing: { before: 120, after: 200 },
    })
  );

  // 10.2 Regional Outlook
  children.push(
    new Paragraph({
      text: "10.2 Regional and Provincial Outlook",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The subject is situated within a broader regional and provincial context that influences demand for agricultural land, commercial premises, and residential housing. Relevant considerations typically include:",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  const regionalFactors = [
    "Overall economic performance, employment trends, and major industry drivers",
    "Infrastructure investment (roads, highways, rail, utilities, broadband)",
    "Population growth or decline and urbanization patterns",
    "Municipal and provincial land-use policies, zoning frameworks, and development plans",
  ];

  regionalFactors.forEach((f) => {
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
          text: "For agricultural properties, the regional outlook for farm consolidation, agri-business expansion, and long-term food/commodity demand is particularly important.",
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
          text: "For commercial and residential assets, local economic diversity, employer stability, and in-migration or out-migration patterns shape the depth and resilience of the market.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 10.3 Risk Assessment
  children.push(
    new Paragraph({
      text: "10.3 Risk Assessment and Sensitivity Analysis",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The valuation is subject to various risks and uncertainties. While the analysis is based on information available as of the effective date, future conditions may differ from those assumed. Key risk categories include:",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      text: "Market Risk",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Potential changes in interest rates, capitalization rates, commodity prices, or demand levels that could affect achievable values or rents.",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  children.push(
    new Paragraph({
      text: "Income and Occupancy Risk (primarily commercial / income-producing assets)",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Tenant rollover risk, lease renewal risk, vacancy risk, and credit quality of occupants.",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  children.push(
    new Paragraph({
      text: "Operational and Physical Risk",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Deferred maintenance, functional obsolescence, and potential future capital expenditures for buildings and site improvements.",
        }),
      ],
      spacing: { after: 120 },
    })
  );

  children.push(
    new Paragraph({
      text: "Regulatory and Policy Risk",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Changes in zoning, land-use regulation, environmental standards, taxation, or lending policies that may impact usage or value.",
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
          text: "Where appropriate, the appraiser may test the sensitivity of indications of value to changes in key assumptions (e.g., ±0.50% in capitalization rates, ±5–10% in market rent, or ±5–10% in land value per acre). These sensitivities are used to understand the range of reasonable outcomes, not to provide multiple separate value conclusions.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 10.4 Exposure Time
  children.push(
    new Paragraph({
      text: "10.4 Exposure Time and Marketing Period",
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
          text: "refers to the estimated length of time the property would have been offered for sale on the open market, prior to the effective date of value, assuming a reasonable marketing effort and no compulsion to buy or sell.",
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
          text: "refers to the estimated time required to sell the property after the valuation date under similar conditions.",
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
          text: "The value conclusion in this report is consistent with an assumed reasonable exposure time and marketing period for the subject's property type in current market conditions, under normal motivation and without undue pressure on either party.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
