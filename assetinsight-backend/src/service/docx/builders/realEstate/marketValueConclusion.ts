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
 * 1.9 MARKET VALUE CONCLUSION
 * Leads with one resolved value, then adds property-type context and highlights.
 * Value-box geometry and phase order keep the opinion prominent when optional
 * supporting detail is unavailable.
 */
export function buildMarketValueConclusion(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const propertyType = reportData?.property_type || "residential";
  const effectiveDate =
    reportData?.effective_date ||
    reportData?.inspection_date ||
    new Date().toLocaleDateString();
  const marketValue =
    reportData?.valuation?.fair_market_value ||
    reportData?.fair_market_value ||
    "TBD";
  const currency = reportData?.currency || "CAD";
  const addr = reportData?.address || reportData?.property_address || "";

  // Section Title
  children.push(
    new Paragraph({
      text: "1.9 MARKET VALUE CONCLUSION",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: false,
      spacing: { after: 200 },
    })
  );
  children.push(goldDivider());

  // Opening statement
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This value represents the most probable price that the property would command in an open and competitive market under conditions typical of informed, prudent buyers and sellers, acting without compulsion and with reasonable exposure time.",
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
          text: "The appraiser is of the opinion that the concluded value reasonably reflects market behaviour and available evidence as of the date of inspection and valuation. This conclusion assumes no material changes in market conditions, economic climate, or property characteristics subsequent to the effective date of this report.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // Property-type specific emphasis
  if (propertyType === "residential" || propertyType === "house") {
    children.push(
      new Paragraph({
        text: "Residential Emphasis 🏡",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 120 },
      })
    );
    children.push(
      new Paragraph({
        style: "BodyLarge",
        children: [
          new TextRun({
            text: "The concluded value represents the market behaviour of comparable residential properties within the surrounding area. It reflects the property's physical condition, quality of improvements, functional utility, and overall market appeal as of the effective date. The value opinion assumes continued maintenance of the property in its current condition and excludes any abnormal economic or physical changes that may occur after this date.",
          }),
        ],
        spacing: { after: 160 },
      })
    );
  } else if (propertyType === "farmland" || propertyType === "agricultural") {
    children.push(
      new Paragraph({
        text: "Agricultural / Farmland Emphasis 🌾",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 120 },
      })
    );
    children.push(
      new Paragraph({
        style: "BodyLarge",
        children: [
          new TextRun({
            text: "The concluded value reflects the property's productive capacity, soil quality, location, and market demand for comparable agricultural lands within the region. The analysis considers the influence of commodity prices, accessibility, and agricultural financing conditions. This conclusion assumes stable agricultural use and no material changes to land use policies or environmental constraints affecting productivity or marketability.",
          }),
        ],
        spacing: { after: 160 },
      })
    );
  } else if (propertyType === "commercial" || propertyType === "industrial") {
    children.push(
      new Paragraph({
        text: "Commercial / Industrial Emphasis 🏢",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 160, after: 120 },
      })
    );
    children.push(
      new Paragraph({
        style: "BodyLarge",
        children: [
          new TextRun({
            text: "The concluded market value is derived from an analysis of comparable sales, income potential, and cost considerations for similar commercial or industrial properties. It represents the market's perception of the property's investment potential, income stability, and physical condition as of the valuation date. This conclusion assumes continued occupancy consistent with market norms and no significant change in economic or leasing conditions after the effective date.",
          }),
        ],
        spacing: { after: 160 },
      })
    );
  }

  // Professional Statement
  children.push(
    new Paragraph({
      text: "Professional Statement",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );
  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The appraiser certifies that this conclusion has been developed independently, without bias or influence, and in full conformity with the Canadian Professional Practice Act (CPPA). Any subsequent change in market conditions, economic outlook, or property use may alter this opinion of value.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // Value Conclusion Box
  children.push(
    new Paragraph({
      text: "Based on the analyses, inspection, and application of the appropriate valuation approaches, the current market value of the subject property is estimated as follows:",
      spacing: { before: 160, after: 120 },
    })
  );

  // Value display table
  const valueTable = new Table({
    width: { size: contentWidthTw, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [
      Math.round(contentWidthTw * 0.4),
      Math.round(contentWidthTw * 0.6),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 12, color: "DC2626" },
      bottom: { style: BorderStyle.SINGLE, size: 12, color: "DC2626" },
      left: { style: BorderStyle.SINGLE, size: 12, color: "DC2626" },
      right: { style: BorderStyle.SINGLE, size: 12, color: "DC2626" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "FEE2E2" },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "FEE2E2" },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 120, bottom: 120, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Effective Date of Valuation:",
                    bold: true,
                    size: 24,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            shading: { fill: "FEF2F2" },
            margins: { top: 120, bottom: 120, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: effectiveDate,
                    size: 24,
                    color: "DC2626",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "FEE2E2" },
            margins: { top: 120, bottom: 120, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Property Address:",
                    bold: true,
                    size: 24,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            shading: { fill: "FEE2E2" },
            margins: { top: 120, bottom: 120, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: addr, size: 24, color: "DC2626" }),
                ],
              }),
            ],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "FECACA" },
            margins: { top: 160, bottom: 160, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Estimated Market Value:",
                    bold: true,
                    size: 28,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            shading: { fill: "FECACA" },
            margins: { top: 160, bottom: 160, left: 140, right: 140 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: formatRealEstateMoney(marketValue, currency),
                    bold: true,
                    size: 32,
                    color: "DC2626",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
  children.push(valueTable);

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `(${currency === "CAD" ? "Canadian Dollars" : currency}, exclusive of GST/HST unless otherwise noted)`,
          italics: true,
          color: "6B7280",
        }),
      ],
      spacing: { before: 80, after: 160 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "This estimate reflects the most probable price that the property would realize in an open and competitive market, assuming a willing buyer and seller, adequate exposure time, and that neither party is under duress. The opinion of value has been developed in accordance with the CPPA and is subject to the assumptions and limiting conditions outlined in this report.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // Property Type Highlights
  children.push(
    new Paragraph({
      text: "1.10 Property Type Highlights",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      text: "The following factors were considered in arriving at the concluded market value:",
      spacing: { after: 140 },
    })
  );

  // Agricultural highlights
  children.push(
    new Paragraph({
      text: "🟩 Agricultural (Farmland / Rural Use)",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );
  const agHighlights = [
    "Soil capability, drainage, and productivity rating",
    "Parcel size, configuration, and access to services",
    "Influence of commodity pricing, location, and market demand",
    "Availability of irrigation, fencing, and site improvements",
  ];
  agHighlights.forEach((h) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${h}` })],
        spacing: { after: 60 },
      })
    );
  });

  // Commercial highlights
  children.push(
    new Paragraph({
      text: "🟧 Commercial / Industrial",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );
  const comHighlights = [
    "Building income potential and market rent comparability",
    "Occupancy levels, lease structure, and term remaining",
    "Functional design, adaptability, and physical condition",
    "Regional economic trends, capitalization rates, and financing conditions",
  ];
  comHighlights.forEach((h) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${h}` })],
        spacing: { after: 60 },
      })
    );
  });

  // Residential highlights
  children.push(
    new Paragraph({
      text: "🟪 Residential",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 120, after: 80 },
    })
  );
  const resHighlights = [
    "Physical condition, effective age, and quality of construction",
    "Layout efficiency and functional utility of living spaces",
    "Market demand, absorption rate, and comparable sales activity",
    "Neighbourhood appeal, accessibility, and supporting amenities",
  ];
  resHighlights.forEach((h) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${h}` })],
        spacing: { after: 60 },
      })
    );
  });

  return children;
}
