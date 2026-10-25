/**
 * Produces a real-estate fair-market valuation from subject facts and comparable sales.
 * Structured provider output is validated and normalized at this boundary so report
 * builders consume one stable result rather than raw model response shapes.
 */
import openai from "../utils/openaiClient.js";

export interface ValuationResult {
  fair_market_value: string;
  value_source: string;
  comparable_list_price: string;
  comparable_used: string;
  final_estimate_summary: string;
  final_estimate_value: string;
  details: string;
}

export async function calculateFairMarketValue(
  propertyDetails: any,
  comparableProperties: any
): Promise<ValuationResult> {
  console.log("Property Details:", propertyDetails);
  console.log(
    "Comparable Properties:",
    JSON.stringify(comparableProperties, null, 2)
  );

  // Helpers to normalize numeric inputs like "$749,900" or "2,120 sqft"
  const toNumber = (val: unknown): number | null => {
    if (val === undefined || val === null) return null;
    if (typeof val === "number" && Number.isFinite(val)) return val;
    const s = String(val);
    const cleaned = s.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const formatMoneyCAD = (n: number): string => {
    try {
      return n.toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
    } catch {
      // Fallback simple formatter
      const s = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return `$${s} CAD`;
    }
  };

  // Extract subject square footage as a number
  const subjectSqft: number | null = (() => {
    const hd = (propertyDetails as any)?.house_details || {};
    return (
      toNumber(hd.square_footage) ??
      toNumber(hd.squareFootage) ??
      toNumber((propertyDetails as any)?.square_footage) ??
      null
    );
  })();

  // Normalize comparable properties to numeric listPrice and squareFootage
  const compsArr: any[] = Array.isArray(comparableProperties)
    ? comparableProperties
    : [];
  const normalizedComps = compsArr
    .map((c: any) => {
      const listPriceNumeric =
        toNumber(c.listPrice) ?? toNumber(c.price) ?? toNumber(c.list_price);
      const squareFootageNumeric =
        toNumber(c.squareFootage) ??
        toNumber(c.square_footage) ??
        toNumber(c.size);
      return {
        name: c?.name || "Comparable",
        address: c?.address || "",
        listPriceNumeric,
        squareFootageNumeric,
      };
    })
    .filter((c) => c.listPriceNumeric && c.squareFootageNumeric);

  // Choose the best comparable (closest square footage)
  let best: null | typeof normalizedComps[number] = null;
  if (subjectSqft && normalizedComps.length) {
    best = normalizedComps
      .slice()
      .sort(
        (a, b) =>
          Math.abs((a.squareFootageNumeric as number) - subjectSqft) -
          Math.abs((b.squareFootageNumeric as number) - subjectSqft)
      )[0];
  }

  const pricePerSqft: number | null =
    best && best.listPriceNumeric && best.squareFootageNumeric
      ? (best.listPriceNumeric as number) / (best.squareFootageNumeric as number)
      : null;
  const fmvNumber: number | null =
    pricePerSqft && subjectSqft ? pricePerSqft * subjectSqft : null;

  const prompt = `
  Act as a certified real estate appraiser. Use the Direct Comparison Approach.

  Subject (normalized):
  - Address: ${String((propertyDetails as any)?.property_details?.address || (propertyDetails as any)?.address || "")}, ${String((propertyDetails as any)?.property_details?.municipality || (propertyDetails as any)?.municipality || "")}
  - squareFootage_number: ${subjectSqft ?? "null"}

  Comparable Properties (original):
  ${JSON.stringify(comparableProperties, null, 2)}

  Comparable Properties (normalized numeric values):
  ${JSON.stringify(normalizedComps, null, 2)}

  If the normalized values are present, USE the following pre-computed values to build your output (do not re-compute different numbers):
  - best_comparable_name: ${best?.name ?? "null"}
  - best_comparable_address: ${best?.address ?? "null"}
  - best_comparable_list_price_number: ${best?.listPriceNumeric ?? "null"}
  - best_comparable_square_footage_number: ${best?.squareFootageNumeric ?? "null"}
  - price_per_sqft_number: ${pricePerSqft ?? "null"}
  - fair_market_value_number: ${fmvNumber ?? "null"}

  Instructions:
  1. Select the comparable with closest square footage to the subject (already indicated above if available).
  2. price_per_sqft = comparable_list_price_number ÷ comparable_square_footage_number.
  3. fair_market_value_number = price_per_sqft × subject_squareFootage_number.
  4. Format money fields with thousands separators and append " CAD" (e.g., "$749,900 CAD"). Round to the nearest dollar.
  5. Output valid JSON matching the schema below. Use the computed numbers exactly if provided (do not change them). If any number is null, clearly state what's missing in the summary.
  6. In 'final_estimate_summary' and 'details':
     - Explain which comparable was chosen and why (closest square footage).
     - Show the formula with the actual numbers.
     - Explain how FMV was derived.

  Output JSON structure:
  {
    "fair_market_value": "$50,000 CAD",
    "value_source": "Direct Comparison Approach (Price per Sqft)",
    "comparable_list_price": "$100,000 CAD",
    "comparable_used": "123 Example Street, Sample City, SK",
    "final_estimate_summary": "...",
    "final_estimate_value": "Fifty Thousand ($50,000) Dollars",
    "details": "..."
  }
`;

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      input: prompt, // your appraisal prompt here
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "real_estate_appraisal",
          strict: true,
          schema: {
            type: "object",
            properties: {
              fair_market_value: { type: "string" },
              value_source: { type: "string" },
              comparable_list_price: { type: "string" },
              comparable_used: { type: "string" },
              final_estimate_summary: { type: "string" },
              final_estimate_value: { type: "string" },
              details: { type: "string" },
            },
            required: [
              "fair_market_value",
              "value_source",
              "comparable_list_price",
              "comparable_used",
              "final_estimate_summary",
              "final_estimate_value",
              "details",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.output_text;
    if (!content) {
      throw new Error("OpenAI returned an empty valuation response.");
    }
    console.log("Valuation Result:", content);
    let parsed = JSON.parse(content) as ValuationResult;
    // If the model refused due to missing data but we have computed numbers, synthesize a valid result
    const looksUnavailable = (str?: string) =>
      typeof str === "string" && /unable to calculate|insufficient data|n\/?a/i.test(str);
    if ((looksUnavailable(parsed?.fair_market_value) || looksUnavailable(parsed?.final_estimate_value)) && fmvNumber && best && pricePerSqft && subjectSqft) {
      const fmStr = formatMoneyCAD(fmvNumber);
      const compPriceStr = formatMoneyCAD(best.listPriceNumeric as number);
      const ppsStr = `${formatMoneyCAD(pricePerSqft)}/sqft`.replace("$", "$");
      parsed = {
        fair_market_value: fmStr,
        value_source: "Direct Comparison Approach (Price per Sqft)",
        comparable_list_price: compPriceStr,
        comparable_used: best.address || best.name,
        final_estimate_summary: `Chosen comparable: ${best.name} (${best.address}). Price per sqft = ${compPriceStr} ÷ ${best.squareFootageNumeric} sqft = ${pricePerSqft?.toFixed(2)}. Subject sqft = ${subjectSqft}. FMV = ${pricePerSqft?.toFixed(2)} × ${subjectSqft} = ${fmStr}.`,
        final_estimate_value: fmStr,
        details: `Closest sqft comparable used. listPrice_number=${best.listPriceNumeric}, squareFootage_number=${best.squareFootageNumeric}, price_per_sqft=${pricePerSqft?.toFixed(2)}, subject_sqft=${subjectSqft}, fair_market_value=${fmStr}.`,
      };
    }
    return parsed;
  } catch (error) {
    console.error("Error calculating fair market value:", error);
    throw new Error("Failed to calculate fair market value.");
  }
}
