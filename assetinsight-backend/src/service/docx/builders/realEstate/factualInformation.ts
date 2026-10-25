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
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 6.0 FACTUAL INFORMATION
 * Projects heterogeneous property records into a fixed factual sequence. Missing
 * facts use readable fallbacks so later taxation, market, and zoning chapters
 * remain structurally present and reviewable.
 */
export function buildFactualInformation(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const propertyType = reportData?.property_type || "residential";
  const addr = reportData?.address || reportData?.property_address || "";
  const legalDesc = reportData?.legal_description || "";
  const ownerName = reportData?.owner_name || reportData?.client_name || "";
  const assessedValue = reportData?.assessed_value || "";
  const taxAmount = reportData?.annual_taxes || "";
  const municipality = reportData?.municipality || reportData?.city || "";
  const zoning = reportData?.zoning || "";

  // Section Title
  children.push(
    new Paragraph({
      text: "6.0 FACTUAL INFORMATION",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 200 },
    })
  );
  children.push(goldDivider());

  // 6.1 Legal Description
  children.push(
    new Paragraph({
      text: "6.1 Legal Description and Civic Address",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `The subject property is legally described as ${legalDesc || "Not provided"}, located at ${addr || "Not provided"} within the ${municipality || "Not provided"}.`,
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
          text: "The legal description was obtained from public land registry or assessment records and is assumed to accurately reflect the property's title boundaries and parcel identification.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6.2 Ownership and Title History
  children.push(
    new Paragraph({
      text: "6.2 Ownership and Title History",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `According to land title records and information provided by the client, ownership of the subject property is registered to ${ownerName || "Not provided"}.`,
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
          text: "The title review indicated no significant encumbrances affecting the property's marketability. Standard easements for utilities and access may exist as is typical for properties of this type.",
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
          text: "The appraiser assumes good and marketable title unless otherwise noted. Any undisclosed liens, claims, or covenants that may affect marketability are beyond the scope of this appraisal.",
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
          text: "Where possible, prior ownership history and transfer dates were reviewed to establish market trends and confirm that the transaction history aligns with prevailing property values in the region.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6.3 Assessment and Taxation
  children.push(
    new Paragraph({
      text: "6.3 Assessment and Taxation Summary",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `The subject property is assessed by the local assessment authority under the applicable assessment roll.`,
        }),
      ],
      spacing: { after: 140 },
    })
  );

  if (assessedValue || taxAmount) {
    children.push(
      new Paragraph({
        style: "BodyLarge",
        children: [
          new TextRun({
            text: `The most recent assessment indicates a taxable value of $${assessedValue || "N/A"}, with annual property taxes of approximately $${taxAmount || "N/A"} CAD.`,
          }),
        ],
        spacing: { after: 140 },
      })
    );
  }

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Assessment values are administrative estimates used for taxation purposes and may not directly correlate to current market value. Any outstanding taxes or adjustments are assumed to be settled by the owner at closing.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6.4 Municipal and Regional Context
  children.push(
    new Paragraph({
      text: "6.4 Municipal and Regional Context",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `The property lies within the jurisdiction of ${municipality || "the local municipality"}, located within proximity to regional urban centres and service areas.`,
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
          text: "The surrounding region features a mix of agricultural, residential, commercial, and industrial uses, supported by access to regional roadways, utility infrastructure, and service amenities.",
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
          text: "The local economy is influenced by key industries including agriculture, energy, manufacturing, and logistics, with the regional growth outlook reflecting stable demand and moderate expansion consistent with market trends.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6.5 Economic and Market Overview
  children.push(
    new Paragraph({
      text: "6.5 Economic and Market Overview",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The economic profile of the area is characterized by consistent long-term stability supported by primary industries, population growth in urban corridors, and ongoing infrastructure investment.",
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
          text: "Market activity in the region reflects trends in the broader provincial economy, including employment, commodity prices, and access to financing.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Market Context by Property Type
  children.push(
    new Paragraph({
      text: "Market Context Highlights (by Property Type):",
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 140, after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟩 Agricultural Properties ", bold: true }),
        new TextRun({
          text: "– Driven by commodity pricing, soil productivity, and demand for farmland consolidation; market values closely track grain and livestock performance and access to irrigation or logistics routes.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟧 Commercial / Industrial Properties ", bold: true }),
        new TextRun({
          text: "– Influenced by local business confidence, occupancy levels, rental absorption, and capitalization rates across retail, office, and industrial sectors.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟪 Residential Properties ", bold: true }),
        new TextRun({
          text: "– Reflect supply, demand, and pricing dynamics in the local housing market; affected by mortgage rates, construction costs, and demographic trends.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6.6 Neighborhood
  children.push(
    new Paragraph({
      text: "6.6 Neighborhood and Surrounding Land Use",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The neighbourhood surrounding the subject property is stable in character, with land uses consisting primarily of similar property types consistent with the zoning designation.",
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
          text: "Accessibility to transportation routes, schools, services, and employment nodes contributes to the property's utility and market appeal.",
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
          text: "No adverse influences were observed from adjacent properties at the time of inspection.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6.7 Zoning
  children.push(
    new Paragraph({
      text: "6.7 Zoning and Land Use Controls",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `According to the applicable municipal zoning bylaw, the property is zoned ${zoning || "Not provided"}.`,
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
          text: "Permitted and discretionary uses are consistent with the property's current utilization and the highest and best use analysis contained in this report.",
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
          text: "The zoning is consistent with the current or anticipated use identified in this report. Any change in zoning or subdivision approval would be subject to municipal review and may alter the property's potential and market value.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 6.8 Environmental
  children.push(
    new Paragraph({
      text: "6.8 Environmental and Regulatory Considerations",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "No environmental assessment was provided to the appraiser, and no evidence of contamination was observed during the visual inspection.",
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
          text: "It is assumed that the property complies with applicable environmental protection statutes, building codes, and municipal development regulations.",
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
          text: "Should subsequent environmental testing reveal contamination or regulatory non-compliance, the market value opinion presented herein may be materially affected.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
