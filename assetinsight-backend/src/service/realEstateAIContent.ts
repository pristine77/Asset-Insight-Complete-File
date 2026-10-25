/**
 * Real Estate AI Content Generation Service
 * Uses OpenAI to generate professional appraisal report content
 */
import openai from "../utils/openaiClient.js";

export interface RealEstateReportInput {
  property_type: "agricultural" | "commercial" | "residential";
  property_details: {
    address?: string;
    legal_description?: string;
    municipality?: string;
    owner_name?: string;
    land_area_acres?: number;
    zoning?: string;
  };
  farmland_details?: {
    total_title_acres?: number;
    cultivated_acres?: number;
    rm_area?: string;
    soil_class?: string;
    crop_type?: string;
    is_rented?: boolean;
    annual_rent_per_acre?: number;
    access_quality?: string;
  };
  house_details?: any;
  inspector_info?: {
    inspector_name?: string;
    company_name?: string;
    credentials?: string;
  };
  report_dates?: {
    report_date?: string;
    effective_date?: string;
    inspection_date?: string;
  };
  valuation?: any;
  farmland_valuation?: any;
  ai_extracted_features?: any;
  comparableProperties?: any;
}

export interface GeneratedSections {
  transmittal: string;
  exec_summary: string;
  certification: string;
  assumptions: string;
  scope: string;
  basis: string;
  factual: string;
  site_desc: string;
  hbu: string;
  valuation: string;
  market: string;
  conclusions: string;
}

/**
 * Generate comprehensive real estate report content using AI
 */
export async function generateRealEstateReportContent(
  input: RealEstateReportInput
): Promise<GeneratedSections> {
  const propertyType = input.property_type || "residential";
  const address = input.property_details?.address || "Subject Property";
  const ownerName = input.property_details?.owner_name || "Property Owner";
  const inspectorName = input.inspector_info?.inspector_name || "Appraiser";
  const companyName = input.inspector_info?.company_name || "Company";
  const effectiveDate =
    input.report_dates?.effective_date || new Date().toISOString().slice(0, 10);
  const marketValue =
    input.farmland_valuation?.fair_market_value_formatted ||
    input.valuation?.fair_market_value ||
    "$0";

  // Limit data size to prevent token overflow
  const propertyDataStr = JSON.stringify(
    input.farmland_details || input.house_details || {}
  ).slice(0, 800);
  const comparablesStr = JSON.stringify(input.comparableProperties || {}).slice(
    0,
    800
  );

  const systemPrompt = `You are a professional real estate appraiser writing a CUSPAP-compliant valuation report.
Property: ${propertyType} at ${address}
Owner: ${ownerName} | Date: ${effectiveDate} | Value: ${marketValue}
Appraiser: ${inspectorName}, ${companyName}

IMPORTANT: Keep each section CONCISE - ONE paragraph only (3-5 sentences max). Be professional but brief.`;

  const schema = {
    type: "object" as const,
    properties: {
      transmittal: { type: "string" as const },
      exec_summary: { type: "string" as const },
      certification: { type: "string" as const },
      assumptions: { type: "string" as const },
      scope: { type: "string" as const },
      basis: { type: "string" as const },
      factual: { type: "string" as const },
      site_desc: { type: "string" as const },
      hbu: { type: "string" as const },
      valuation: { type: "string" as const },
      market: { type: "string" as const },
      conclusions: { type: "string" as const },
    },
    required: [
      "transmittal",
      "exec_summary",
      "certification",
      "assumptions",
      "scope",
      "basis",
      "factual",
      "site_desc",
      "hbu",
      "valuation",
      "market",
      "conclusions",
    ],
    additionalProperties: false,
  };

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "low" },
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Generate 12 report sections for this ${propertyType} appraisal. Property data: ${propertyDataStr}. Comparables: ${comparablesStr}. Keep each section to ONE concise paragraph.`,
            },
          ],
        },
      ] as any,
      text: {
        format: {
          type: "json_schema",
          name: "report_sections",
          strict: true,
          schema,
        },
      },
    } as any);

    const content = response?.output_text?.trim();
    if (!content) throw new Error("Empty response");
    return JSON.parse(content) as GeneratedSections;
  } catch (error) {
    console.error("AI content generation failed:", error);
    return getDefaultSections(input);
  }
}

function getDefaultSections(input: RealEstateReportInput): GeneratedSections {
  const addr = input.property_details?.address || "Subject Property";
  const owner = input.property_details?.owner_name || "Owner";
  const date =
    input.report_dates?.effective_date || new Date().toISOString().slice(0, 10);
  const value =
    input.farmland_valuation?.fair_market_value_formatted ||
    input.valuation?.fair_market_value ||
    "$0";
  const appraiser = input.inspector_info?.inspector_name || "Appraiser";
  const company = input.inspector_info?.company_name || "Company";

  return {
    transmittal: `In accordance with your request, this report presents an independent appraisal of the subject property located at ${addr}. The objective is to determine the current market value as of ${date}. Based on our analysis, the estimated market value is ${value}.\n\nRespectfully submitted,\n${appraiser}\n${company}`,
    exec_summary: `The subject property at ${addr} has been appraised to determine fair market value. After thorough analysis of the property and market data, the concluded value as of ${date} is ${value}. This report has been prepared in accordance with CUSPAP standards.`,
    certification: `I hereby certify that the statements of fact in this report are accurate and complete. I have no bias with respect to the property appraised. My analyses and conclusions reflect my impartial professional judgment. This report complies with CUSPAP standards.`,
    assumptions: `This report is subject to standard assumptions and limiting conditions. The property is assumed to have good and marketable title. Environmental conditions are assumed to be satisfactory. Market conditions are as of the effective date only.`,
    scope: `The scope of this assignment includes inspection of the subject property, collection and analysis of relevant market data, verification of comparable sales, and application of appropriate valuation methodologies.`,
    basis: `Market Value is defined as the most probable price that a property should bring in a competitive and open market under fair sale conditions. This appraisal considers fee simple interest.`,
    factual: `The property is located at ${addr} within the local municipal jurisdiction. The legal description and title have been reviewed. Assessment and taxation information has been considered in the analysis.`,
    site_desc: `The subject property is located at ${addr} with adequate access and typical topography for the area. Utilities and services are available. The site is suitable for its current use.`,
    hbu: `The highest and best use analysis considers legally permissible, physically possible, financially feasible, and maximally productive use. The current use is concluded to represent highest and best use.`,
    valuation: `The Direct Comparison Approach was applied using comparable sales from the market area. After adjustments for differences, the indicated value is ${value}. This represents the most reliable indication of market value.`,
    market: `Market conditions as of ${date} reflect stable activity with adequate supply and demand. The exposure time is consistent with typical marketing periods for this property type.`,
    conclusions: `Based on the analyses undertaken, the market value of the subject property as of ${date} is concluded at ${value}. This conclusion is subject to the assumptions and limiting conditions stated in this report.`,
  };
}
