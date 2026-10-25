/**
 * Converts valuation inputs into the four supported method views and narrative analysis.
 * Deterministic arithmetic remains the financial source of truth; AI is restricted to
 * selecting/explaining reasonable assumptions and comparison prose so presentation
 * failure cannot silently alter calculated values.
 */
import openai from "../utils/openaiClient.js";

export type ValuationMethod = "FML" | "TKV" | "OLV" | "FLV";

export interface ValuationResult {
  method: ValuationMethod;
  fullName: string;
  description: string;
  percentage: number; // Percentage of FMV (e.g., 100, 75, 65, 50)
  value: number;
  saleConditions: string;
  timeline: string;
  useCase: string;
  aiExplanation?: string; // Brief AI-generated explanation
}

export interface ValuationMethodData {
  method: ValuationMethod;
  fullName: string;
  value: number;
  aiExplanation: string;
  description: string;
  saleConditions: string;
  timeline: string;
  marketContext: string;
  applicationScenarios: string;
  assumptions: string;
}

export interface ValuationComparisonTable {
  baseFMV: number;
  methods: ValuationResult[];
}

export interface SingleValuationData {
  baseFMV: number;
  selectedMethod: ValuationMethodData;
}

const VALUATION_DEFINITIONS = {
  FML: {
    fullName: "Fair Market Value (FML / FMV In Use)",
    saleConditions: "Installed and operating, open competitive market",
    typicalRange: [95, 100],
    timeline: "Normal market exposure (60-120 days)",
    defaultPercentage: 100,
    description: "Appraised retail value - what the asset would sell for in an open, competitive market between informed buyers and sellers with no pressure to sell.",
    useCase: "Setting reserve prices, insurance valuation, book value, appraisal purposes, establishing loan collateral (top end).",
  },
  TKV: {
    fullName: "Trade Value (TKV / Kelly Value)",
    saleConditions: "Dealer trade-in for quick resale",
    typicalRange: [60, 80],
    timeline: "Immediate dealer acquisition",
    defaultPercentage: 70,
    description: "Dealer in-trade benchmark - what a dealer or reseller would pay to acquire the asset in trade, leaving room for resale profit margin.",
    useCase: "Wholesale comparison, pre-auction liquidation, dealer consignment guarantees, trade-in valuations.",
  },
  OLV: {
    fullName: "Orderly Liquidation Value",
    saleConditions: "Controlled liquidation with marketing period",
    typicalRange: [70, 85],
    timeline: "90-180 days with full marketing",
    defaultPercentage: 77,
    description: "Auction reserve range - expected realizable value when marketed over a reasonable time through a full marketing cycle (email, listing, inspection).",
    useCase: "Secured lending (70-80% LTV), auction reserve pricing, restructuring, voluntary liquidation appraisals.",
  },
  FLV: {
    fullName: "Forced Liquidation Value",
    saleConditions: "Immediate liquidation under distress",
    typicalRange: [40, 65],
    timeline: "10-30 days, minimal marketing",
    defaultPercentage: 52,
    description: "Quick-sale recovery - what could be recovered if the asset must be sold immediately under distress conditions (repossession, bankruptcy, receiver sale).",
    useCase: "Worst-case lender recovery, bankruptcy proceedings, receiver sales, no-reserve auction estimates, risk assessment.",
  },
};

/**
 * Use AI to determine appropriate valuation percentages based on asset characteristics
 */
export async function determineValuationPercentages(
  assetTitle: string,
  assetDescription: string,
  assetCondition: string,
  industry: string,
  baseFMV: number
): Promise<Record<ValuationMethod, number>> {
  try {
    const prompt = `You are an expert appraiser and valuation specialist. Based on the asset details below, determine appropriate valuation percentages for different liquidation scenarios.

**Asset Details:**
- Title: ${assetTitle}
- Description: ${assetDescription || "N/A"}
- Condition: ${assetCondition || "Unknown"}
- Industry: ${industry || "General"}
- Base Fair Market Value (FMV): $${baseFMV.toLocaleString()}

**Valuation Methods to Calculate:**

1. **FML (Fair Market Value)** - Always 100%
2. **TKV (Trade Value)** - Typical range: 60-80% of FMV
3. **OLV (Orderly Liquidation Value)** - Typical range: 70-85% of FMV
4. **FLV (Forced Liquidation Value)** - Typical range: 40-65% of FMV

**Instructions:**
Consider the following factors when determining percentages:
- Asset type and marketability
- Condition and age
- Industry demand
- Liquidity (how quickly it can be sold)
- Specialized vs. general-purpose equipment
- Market conditions

Return ONLY a JSON object with the following structure (no markdown, no explanations):
{
  "FML": 100,
  "TKV": 70,
  "OLV": 77,
  "FLV": 52
}

The percentages must be realistic numbers within the typical ranges specified above.`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.choices[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(content);

    // Validate and apply bounds
    return {
      FML: 100, // Always 100%
      TKV: Math.max(60, Math.min(80, parsed.TKV || 70)),
      OLV: Math.max(70, Math.min(85, parsed.OLV || 77)),
      FLV: Math.max(40, Math.min(65, parsed.FLV || 52)),
    };
  } catch (error) {
    console.error("AI valuation percentage determination failed:", error);
    // Return default percentages
    return {
      FML: 100,
      TKV: 70,
      OLV: 77,
      FLV: 52,
    };
  }
}

/**
 * Generate valuation comparison table
 */
export function generateValuationTable(
  baseFMV: number,
  selectedMethods: ValuationMethod[],
  percentages?: Partial<Record<ValuationMethod, number>>
): ValuationComparisonTable {
  const methods: ValuationResult[] = selectedMethods.map((method) => {
    const def = VALUATION_DEFINITIONS[method];
    const percentage = percentages?.[method] ?? def.defaultPercentage;
    const value = (baseFMV * percentage) / 100;

    return {
      method,
      fullName: def.fullName,
      description: def.description,
      percentage,
      value,
      saleConditions: def.saleConditions,
      timeline: def.timeline,
      useCase: def.useCase,
    };
  });

  return {
    baseFMV,
    methods,
  };
}

/**
 * Format valuation table for display
 */
export function formatValuationTableText(table: ValuationComparisonTable): string {
  let output = `VALUATION COMPARISON TABLE\n`;
  output += `Base Fair Market Value: $${table.baseFMV.toLocaleString()}\n\n`;
  output += `${"Method".padEnd(15)} ${"% of FMV".padEnd(12)} ${"Value".padEnd(15)} Timeline\n`;
  output += `${"-".repeat(70)}\n`;

  for (const m of table.methods) {
    output += `${m.method.padEnd(15)} ${(m.percentage + "%").padEnd(12)} $${m.value.toLocaleString().padEnd(13)} ${m.timeline}\n`;
  }

  return output;
}

/**
 * Get detailed explanation for a valuation method
 */
export function getValuationMethodExplanation(method: ValuationMethod): string {
  const def = VALUATION_DEFINITIONS[method];
  return `
${def.fullName}

Sale Conditions: ${def.saleConditions}
Typical Range: ${def.typicalRange[0]}-${def.typicalRange[1]}% of FMV
Timeline: ${def.timeline}

Description:
${def.description}

Use Cases:
${def.useCase}
  `.trim();
}

/**
 * Generate comprehensive AI explanation for a single valuation method
 */
export async function generateValuationMethodAnalysis(
  method: ValuationMethod,
  assetTitle: string,
  assetDescription: string,
  assetCondition: string,
  industry: string,
  baseFMV: number,
  calculatedValue: number
): Promise<ValuationMethodData> {
  const def = VALUATION_DEFINITIONS[method];
  
  try {
    const prompt = `You are an expert appraisal professional. Provide a comprehensive, production-ready analysis for the ${def.fullName} valuation method.

**Asset Information:**
- Title: ${assetTitle}
- Description: ${assetDescription || "N/A"}
- Condition: ${assetCondition || "Unknown"}
- Industry: ${industry || "General"}
- Base Fair Market Value: $${baseFMV.toLocaleString()}
- Calculated ${method} Value: $${calculatedValue.toLocaleString()}

**Valuation Method:** ${def.fullName}
**Sale Conditions:** ${def.saleConditions}
**Timeline:** ${def.timeline}

Provide a detailed analysis with the following sections (return as JSON object):

1. **aiExplanation**: A concise 2-3 sentence summary explaining this specific valuation for this asset (suitable for table display)

2. **marketContext**: A comprehensive 3-4 sentence paragraph analyzing current market conditions, demand trends, and how they affect this valuation for this specific asset type in this industry

3. **applicationScenarios**: A detailed 3-4 sentence paragraph describing ideal use cases, when this valuation method should be applied, and who would use it (lenders, buyers, sellers, etc.)

4. **assumptions**: A thorough 3-4 sentence paragraph listing key assumptions made in this valuation, including asset condition, market access, timeline expectations, and any caveats

Return ONLY valid JSON (no markdown formatting):
{
  "aiExplanation": "...",
  "marketContext": "...",
  "applicationScenarios": "...",
  "assumptions": "..."
}

Make the content professional, specific to this asset, and production-ready for client distribution.`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(content);

    return {
      method,
      fullName: def.fullName,
      value: calculatedValue,
      aiExplanation: parsed.aiExplanation || `This ${def.fullName} represents the estimated value based on ${def.saleConditions.toLowerCase()}.`,
      description: def.description,
      saleConditions: def.saleConditions,
      timeline: def.timeline,
      marketContext: parsed.marketContext || `The market conditions for this asset type support this valuation under ${def.saleConditions.toLowerCase()} circumstances.`,
      applicationScenarios: parsed.applicationScenarios || def.useCase,
      assumptions: parsed.assumptions || "This valuation assumes normal market conditions and the asset information provided is accurate.",
    };
  } catch (error) {
    console.error("AI explanation generation failed:", error);
    
    // Return fallback with basic information
    return {
      method,
      fullName: def.fullName,
      value: calculatedValue,
      aiExplanation: `This ${def.fullName} represents the estimated value based on ${def.saleConditions.toLowerCase()}, calculated at ${Math.round((calculatedValue/baseFMV)*100)}% of the fair market value.`,
      description: def.description,
      saleConditions: def.saleConditions,
      timeline: def.timeline,
      marketContext: `The market conditions for this asset type in the ${industry} industry typically support ${def.typicalRange[0]}-${def.typicalRange[1]}% of FMV under ${def.saleConditions.toLowerCase()}. This specific asset has been evaluated considering its condition, marketability, and current demand factors.`,
      applicationScenarios: def.useCase,
      assumptions: `This valuation assumes: (1) the asset condition and specifications as described are accurate, (2) typical market access and buyer availability within the ${def.timeline.toLowerCase()}, (3) no hidden defects or undisclosed issues, and (4) sale under ${def.saleConditions.toLowerCase()}.`,
    };
  }
}

/**
 * Generate single valuation method data with AI analysis
 */
export async function generateSingleValuationAnalysis(
  baseFMV: number,
  selectedMethod: ValuationMethod,
  assetTitle: string,
  assetDescription: string,
  assetCondition: string,
  industry: string
): Promise<SingleValuationData> {
  const def = VALUATION_DEFINITIONS[selectedMethod];
  
  // Determine percentage using AI
  const percentages = await determineValuationPercentages(
    assetTitle,
    assetDescription,
    assetCondition,
    industry,
    baseFMV
  );
  
  const percentage = percentages[selectedMethod];
  const calculatedValue = (baseFMV * percentage) / 100;
  
  // Generate comprehensive AI analysis
  const methodData = await generateValuationMethodAnalysis(
    selectedMethod,
    assetTitle,
    assetDescription,
    assetCondition,
    industry,
    baseFMV,
    calculatedValue
  );
  
  return {
    baseFMV,
    selectedMethod: methodData,
  };
}

/**
 * Generate brief AI explanation for a single method (for comparison table)
 */
async function generateBriefExplanation(
  method: ValuationMethod,
  assetTitle: string,
  assetDescription: string,
  assetCondition: string,
  industry: string,
  baseFMV: number,
  calculatedValue: number
): Promise<string> {
  const def = VALUATION_DEFINITIONS[method];
  
  try {
    const prompt = `You are an expert appraiser. Provide a brief, professional explanation (2-3 sentences) for why this ${def.fullName} was calculated at $${calculatedValue.toLocaleString()} for this asset.

**Asset:** ${assetTitle}
**Description:** ${assetDescription || "N/A"}
**Condition:** ${assetCondition || "Unknown"}
**Industry:** ${industry || "General"}
**Base FMV:** $${baseFMV.toLocaleString()}

**Method:** ${def.fullName}
**Use:** ${def.useCase}
**Conditions:** ${def.saleConditions}

Provide ONLY the 2-3 sentence explanation (no JSON, no labels, just the text). Make it specific to this asset and professional for client reports. DO NOT mention percentages or % in your explanation.`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 200,
    });

    return response.choices[0]?.message?.content?.trim() || 
      `This ${def.fullName} reflects ${def.saleConditions.toLowerCase()} within a ${def.timeline.toLowerCase()} timeframe.`;
  } catch (error) {
    console.error(`Brief explanation generation failed for ${method}:`, error);
    return `This ${def.fullName} reflects ${def.saleConditions.toLowerCase()} within a ${def.timeline.toLowerCase()} timeframe.`;
  }
}

/**
 * Generate comparison table with brief AI explanations for multiple methods
 */
export async function generateComparisonTableWithAI(
  baseFMV: number,
  selectedMethods: ValuationMethod[],
  assetTitle: string,
  assetDescription: string,
  assetCondition: string,
  industry: string
): Promise<ValuationComparisonTable> {
  // Get AI-determined percentages
  const percentages = await determineValuationPercentages(
    assetTitle,
    assetDescription,
    assetCondition,
    industry,
    baseFMV
  );

  // Generate brief explanations for each method in parallel
  const methods: ValuationResult[] = await Promise.all(
    selectedMethods.map(async (method) => {
      const def = VALUATION_DEFINITIONS[method];
      const percentage = percentages[method];
      const value = (baseFMV * percentage) / 100;

      // Generate brief AI explanation
      const aiExplanation = await generateBriefExplanation(
        method,
        assetTitle,
        assetDescription,
        assetCondition,
        industry,
        baseFMV,
        value
      );

      return {
        method,
        fullName: def.fullName,
        description: def.description,
        percentage,
        value,
        saleConditions: def.saleConditions,
        timeline: def.timeline,
        useCase: def.useCase,
        aiExplanation,
      };
    })
  );

  return {
    baseFMV,
    methods,
  };
}
