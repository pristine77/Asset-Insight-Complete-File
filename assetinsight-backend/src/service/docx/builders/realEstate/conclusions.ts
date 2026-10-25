import {
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  AlignmentType,
} from "docx";
import { goldDivider } from "../utils.js";
import { formatRealEstateMoney } from "./formatMoney.js";

/**
 * 11.0 CONCLUSIONS AND RECOMMENDATIONS
 * Reconciles report findings into the final opinion and optional AI calculation
 * detail. The displayed final value is resolved once; supplemental methodology
 * reads the available valuation records independently.
 */
export function buildConclusions(
  reportData: any,
  contentWidthTw: number
): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [];
  const marketValue = reportData?.valuation?.fair_market_value || reportData?.fair_market_value || "TBD";
  const currency = reportData?.currency || "CAD";
  const effectiveDate = reportData?.effective_date || reportData?.inspection_date || new Date().toLocaleDateString();

  // Section Title
  children.push(
    new Paragraph({
      text: "11.0 CONCLUSIONS AND RECOMMENDATIONS",
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
          text: "This section summarizes the analytical work completed, presents the final market value conclusion, and outlines considerations that may influence future value. It also includes professional commentary relevant to the subject property, the intended use of this appraisal, and the prevailing market environment as of the effective date.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // 11.1 Summary of Findings
  children.push(
    new Paragraph({
      text: "11.1 Summary of Findings",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The appraisal assignment involved a detailed review of the subject property, analysis of comparable market data, evaluation of applicable valuation approaches, and consideration of local economic and market conditions.",
        }),
      ],
      spacing: { after: 140 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({ text: "Key findings include:", bold: true }),
      ],
      spacing: { after: 100 },
    })
  );

  const findings = [
    "The subject property's physical, legal, and locational characteristics were reviewed through inspection, documentary evidence, and available municipal records.",
    "Market data relevant to agricultural, commercial, or residential properties (as applicable) was analyzed and adjusted for comparability.",
    "The applicable valuation approaches (Direct Comparison, Income Capitalization, and Cost Approach) were tested and weighed according to their relevance, data reliability, and market behaviour.",
    "The highest and best use of the subject property was confirmed based on legally permissible, physically possible, financially feasible, and maximally productive criteria.",
    "The final value conclusion reflects the most reliable indicators derived from market-based evidence.",
  ];

  findings.forEach((f) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${f}` })],
        spacing: { after: 80 },
      })
    );
  });

  children.push(new Paragraph({ spacing: { after: 120 } }));

  // 11.2 Reconciliation
  children.push(
    new Paragraph({
      text: "11.2 Reconciliation of Approaches",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Each valuation approach provided an independent indication of value. The relative weight assigned to each method depended on:",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  const weights = [
    "The quality and quantity of comparable sales",
    "The stability and reliability of income (for income-producing properties)",
    "The relevance of replacement cost information",
    "Market participant behaviour within the subject's asset class",
  ];

  weights.forEach((w) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${w}` })],
        spacing: { after: 60 },
      })
    );
  });

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "The final reconciled value reflects the approach offering the highest degree of reliability and consistency with market evidence.",
        }),
      ],
      spacing: { before: 120, after: 200 },
    })
  );

  // 11.3 Final Market Value Opinion
  children.push(
    new Paragraph({
      text: "11.3 Final Market Value Opinion",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Considering the data analyzed, the methodologies applied, and the highest and best use of the subject property, the market value of the property, in fee simple interest, as of the effective date, is concluded at:",
        }),
      ],
      spacing: { after: 160 },
    })
  );

  // Value display
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: "Final Market Value Estimate:", bold: true, size: 28 }),
      ],
      spacing: { after: 80 },
    })
  );

  // Clean market value display (remove duplicate $ or currency symbols)
  const displayValue = marketValue.toString().replace(/^\$/, "").replace(/ CAD$/, "");
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: formatRealEstateMoney(displayValue, currency),
          bold: true,
          size: 52,
          color: "DC2626",
        }),
      ],
      spacing: { after: 80 },
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `(${currency === "CAD" ? "Canadian Dollars" : currency}, net of GST/HST unless otherwise noted)`,
          italics: true,
          color: "6B7280",
          size: 20,
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
          text: "This value represents the most probable price the property would achieve in an open and competitive market, assuming reasonable exposure time and typical motivations of buyers and sellers.",
        }),
      ],
      spacing: { after: 160 },
    })
  );

  // AI methodology is supplemental evidence after the fixed value opinion. Its
  // absence must not remove or reorder the professionally authored conclusion.
  // AI Valuation Methodology and Calculation Summary
  const valuation = reportData?.valuation || {};
  const farmlandValuation = reportData?.farmland_valuation || {};
  const propertyType = reportData?.property_type || "residential";
  
  // Check if we have valuation details to display
  const hasValuationDetails = valuation?.value_source || valuation?.final_estimate_summary || 
    valuation?.details || farmlandValuation?.fair_market_value;

  if (hasValuationDetails) {
    children.push(
      new Paragraph({
        text: "Valuation Methodology & Calculation",
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 140, after: 100 },
      })
    );

    // Approach Used
    const valueSource = valuation?.value_source || 
      (propertyType === "agricultural" || propertyType === "farmland" 
        ? "Direct Comparison Approach with Income Capitalization" 
        : "Direct Comparison Approach (Price per Sqft)");
    
    children.push(
      new Paragraph({
        style: "BodyLarge",
        children: [
          new TextRun({ text: "Approach Used: ", bold: true }),
          new TextRun({ text: valueSource }),
        ],
        spacing: { after: 100 },
      })
    );

    // For Farmland - show detailed breakdown
    if (farmlandValuation?.fair_market_value || propertyType === "agricultural" || propertyType === "farmland") {
      const fmVal = farmlandValuation;
      
      // Comparable Analysis
      if (fmVal?.weighted_average_rate) {
        children.push(
          new Paragraph({
            style: "BodyLarge",
            children: [
              new TextRun({ text: "Comparable Analysis: ", bold: true }),
              new TextRun({ 
                text: `Based on ${fmVal?.comparables?.length || "multiple"} comparable farmland sales, the weighted average rate was determined to be $${Number(fmVal.weighted_average_rate).toLocaleString()}/acre.` 
              }),
            ],
            spacing: { after: 100 },
          })
        );
      }

      // Direct Comparison Value
      if (fmVal?.direct_comparison_value) {
        const cultivatedAcres = fmVal?.cultivated_acres || reportData?.farmland_details?.cultivated_acres;
        children.push(
          new Paragraph({
            style: "BodyLarge",
            children: [
              new TextRun({ text: "Direct Comparison: ", bold: true }),
              new TextRun({ 
                text: `${cultivatedAcres ? cultivatedAcres + " cultivated acres × " : ""}$${Number(fmVal.weighted_average_rate || 0).toLocaleString()}/acre = $${Number(fmVal.direct_comparison_value).toLocaleString()}` 
              }),
            ],
            spacing: { after: 100 },
          })
        );
      }

      // Income Capitalization
      if (fmVal?.income_capitalization?.indicated_value) {
        const inc = fmVal.income_capitalization;
        children.push(
          new Paragraph({
            style: "BodyLarge",
            children: [
              new TextRun({ text: "Income Capitalization: ", bold: true }),
              new TextRun({ 
                text: `NOI of $${Number(inc.net_operating_income || 0).toLocaleString()} ÷ ${inc.cap_rate || 5}% cap rate = $${Number(inc.indicated_value).toLocaleString()}` 
              }),
            ],
            spacing: { after: 100 },
          })
        );
      }

      // Reconciliation
      if (fmVal?.reconciliation) {
        const rec = fmVal.reconciliation;
        const savedApproaches = fmVal.approaches_used;
        const methods = [
          { key: "direct_comparable", label: "Direct Comparison", weight: rec.direct_comparison_weight, value: rec.direct_comparison_value },
          { key: "income_capitalization", label: "Income Approach", weight: rec.income_weight, value: rec.income_value },
          { key: "cost_approach", label: "Cost Approach", weight: rec.cost_weight, value: rec.cost_value },
        ];
        const hasSavedSelections = methods.some(({ key }) => typeof savedApproaches?.[key] === "boolean");
        const selectedMethods = methods.filter(({ key, weight, value }) =>
          hasSavedSelections ? savedApproaches?.[key] === true : weight != null || value != null
        );
        // This is a display of the saved reconciliation, not a fresh valuation.
        // Never invent legacy 70/30 weights or omit a selected Cost approach.
        const reconciliationText = selectedMethods.map(({ label, weight }) => {
          const hasWeight = weight != null && String(weight).trim() !== "" && Number.isFinite(Number(weight));
          return `${label} (${hasWeight ? `${weight}% weight` : "weight not provided"})`;
        }).join(" + ");
        children.push(
          new Paragraph({
            style: "BodyLarge",
            children: [
              new TextRun({ text: "Reconciliation: ", bold: true }),
              new TextRun({ 
                text: reconciliationText ? `${reconciliationText} = Final Value` : "No selected approaches were recorded."
              }),
            ],
            spacing: { after: 100 },
          })
        );
      }
    } else {
      // For Residential/Commercial - show price per sqft calculation
      if (valuation?.comparable_used) {
        children.push(
          new Paragraph({
            style: "BodyLarge",
            children: [
              new TextRun({ text: "Comparable Used: ", bold: true }),
              new TextRun({ text: valuation.comparable_used }),
            ],
            spacing: { after: 100 },
          })
        );
      }

      if (valuation?.comparable_list_price) {
        children.push(
          new Paragraph({
            style: "BodyLarge",
            children: [
              new TextRun({ text: "Comparable List Price: ", bold: true }),
              new TextRun({ text: valuation.comparable_list_price }),
            ],
            spacing: { after: 100 },
          })
        );
      }
    }

    // Show the AI-generated summary if available
    if (valuation?.final_estimate_summary) {
      children.push(
        new Paragraph({
          style: "BodyLarge",
          children: [
            new TextRun({ text: "Calculation Summary: ", bold: true }),
            new TextRun({ text: valuation.final_estimate_summary }),
          ],
          spacing: { after: 100 },
        })
      );
    }

    // Show additional details if available
    if (valuation?.details && valuation.details !== valuation.final_estimate_summary) {
      children.push(
        new Paragraph({
          style: "BodyLarge",
          children: [
            new TextRun({ text: "Details: ", bold: true }),
            new TextRun({ 
              text: valuation.details,
              italics: true,
              color: "4B5563",
            }),
          ],
          spacing: { after: 100 },
        })
      );
    }

    children.push(new Paragraph({ spacing: { after: 120 } }));
  }

  // 11.4 Assumptions Impacting Future Value
  children.push(
    new Paragraph({
      text: "11.4 Assumptions Impacting Future Value",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "While the valuation reflects conditions as of the effective date, future market value may be influenced by several factors, including:",
        }),
      ],
      spacing: { after: 100 },
    })
  );

  const futureFactors = [
    "Changes in local or regional economic conditions",
    "Shifts in interest rates, capitalization rates, or lending policies",
    "Commodity pricing fluctuations (for agricultural properties)",
    "Variations in supply and demand in commercial or residential markets",
    "Changes to zoning, taxation, or infrastructure",
    "Physical changes to the property arising from deterioration, upgrades, or deferred maintenance",
    "Environmental disclosures or regulatory developments",
  ];

  futureFactors.forEach((f) => {
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
          text: "No opinion is expressed regarding future market trends; however, value may increase or decrease depending on how these factors evolve.",
        }),
      ],
      spacing: { before: 120, after: 200 },
    })
  );

  // 11.5 Professional Opinion
  children.push(
    new Paragraph({
      text: "11.5 Professional Opinion and Commentary",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 120 },
    })
  );

  children.push(
    new Paragraph({
      style: "BodyLarge",
      children: [
        new TextRun({
          text: "Based on the analysis undertaken and information available at the time of preparation, the value conclusion is considered reasonable, well-supported, and consistent with market expectations for similar properties.",
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
          text: "The appraisal has been prepared objectively and independently, without bias or influence from the client or any other party. All assumptions and limiting conditions have been clearly stated within this report.",
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
          text: "This valuation is intended to assist the client for the stated purpose and intended use only.",
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
          text: "Users of this report should rely on the conclusions within the context of the effective date and scope of work completed.",
        }),
      ],
      spacing: { after: 200 },
    })
  );

  return children;
}
