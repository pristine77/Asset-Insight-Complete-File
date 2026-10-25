import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
} from "docx";
import { goldDivider } from "../utils.js";

/**
 * 8.0 HIGHEST AND BEST USE ANALYSIS
 * Applies the four appraisal tests in logical order: legal, physical, financial,
 * then maximal productivity. Property-type branches enrich a test but do not
 * change that sequence or the final conclusion boundary.
 */
export function buildHighestBestUse(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const propertyType = reportData?.property_type || "residential";
  const zoning = reportData?.zoning || "";

  // Section Title
  children.push(
    new Paragraph({
      text: "8.0 HIGHEST AND BEST USE ANALYSIS",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { after: 200 },
    })
  );
  children.push(goldDivider());

  // 8.1 Definition
  children.push(
    new Paragraph({
      text: "8.1 Definition and Analytical Framework",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: '"Highest and Best Use" refers to the reasonably probable and legal use of vacant land or an improved property that is physically possible, legally permissible, financially feasible, and maximally productive, resulting in the highest value.',
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
          text: "This framework is consistent with the definitions recognized by the CPPA.",
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
          text: "The analysis examines the property as if vacant and, if applicable, as improved, applying the four-step test of:",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  const fourTests = [
    "Legal permissibility",
    "Physical possibility",
    "Financial feasibility",
    "Maximum productivity",
  ];

  fourTests.forEach((test, idx) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `${idx + 1}. ${test}`, bold: true })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(new Paragraph({ spacing: { after: 120 } }));

  // 8.2 Legally Permissible Use
  children.push(
    new Paragraph({
      text: "8.2 Legally Permissible Use",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Legal permissibility considers zoning bylaws, official community plans, subdivision controls, and other regulatory constraints that govern property use.",
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
          text: `The subject property is currently zoned ${zoning || "Not provided"}, which allows uses consistent with the property's current utilization and may permit additional discretionary uses subject to municipal approval.`,
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
          text: "No legal impediments were identified that would prevent continued or alternative use consistent with the property's physical characteristics and market demand. Any change in zoning or variance approval would require review by the appropriate municipal authority.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 8.3 Physically Possible Use
  children.push(
    new Paragraph({
      text: "8.3 Physically Possible Use",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Physical possibility assesses the site's size, configuration, topography, access, soil conditions, and availability of utilities to determine suitable uses.",
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
          text: "The site's characteristics—including level terrain, adequate access, and available services—support development consistent with the zoning framework.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Property type specific
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟩 Agricultural: ", bold: true }),
        new TextRun({
          text: "Productivity, drainage, and soil capability suggest continued agricultural use or consolidation potential.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟧 Commercial: ", bold: true }),
        new TextRun({
          text: "Parcel shape, access, and exposure support potential retail, industrial, or mixed-use development.",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "🟪 Residential: ", bold: true }),
        new TextRun({
          text: "Lot size, orientation, and servicing align with current or future residential improvement.",
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
          text: "No physical constraints were observed that would preclude typical use for similar properties in the market area.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 8.4 Financially Feasible Use
  children.push(
    new Paragraph({
      text: "8.4 Financially Feasible Use",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Financial feasibility measures whether a proposed or existing use generates a return sufficient to attract market participants.",
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
          text: "Market analysis indicates that demand exists for property of this type within the region, supported by recent comparable sales, rental rates, and absorption data.",
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
          text: "Uses that fail to produce an adequate financial return or exceed market-supported investment thresholds are considered infeasible.",
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
          text: "The property's most probable users—farm operators, investors, or owner-occupiers—would seek utilization consistent with market demand and achievable net returns.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 8.5 Maximally Productive Use
  children.push(
    new Paragraph({
      text: "8.5 Maximally Productive Use",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Of the legally permissible, physically possible, and financially feasible alternatives, the maximally productive use is the one that results in the highest residual land value or overall property value.",
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
          text: "This test identifies the use that optimizes land utility and reflects the greatest economic potential given prevailing market conditions and risk factors.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  // Determine maximally productive use based on property type
  let maxUse = "continued residential occupancy";
  if (propertyType === "farmland" || propertyType === "agricultural") {
    maxUse = "continued agricultural production";
  } else if (propertyType === "commercial" || propertyType === "industrial") {
    maxUse = "commercial or light-industrial development";
  }

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `The analysis concluded that ${maxUse} represents the maximally productive use at this time.`,
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 8.6 Conclusion
  children.push(
    new Paragraph({
      text: "8.6 Conclusion of Highest and Best Use",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: `Based on the foregoing analysis and market evidence, the highest and best use of the subject property as if vacant is considered to be ${maxUse}.`,
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
          text: "If improvements exist, the highest and best use as improved is to continue existing use consistent with current market demand and regulatory permissions.",
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
          text: "This conclusion forms the foundation for the valuation approaches applied in subsequent sections of this report.",
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
          text: "It is predicated on the assumption that there are no material environmental, legal, or economic changes affecting the property subsequent to the effective date of valuation.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
