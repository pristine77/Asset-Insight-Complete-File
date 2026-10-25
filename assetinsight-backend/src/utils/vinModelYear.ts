const MODEL_YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

/**
 * Finds a complete VIN in a label or free-text value. VINs exclude I, O, and Q;
 * U and Z remain valid outside the model-year position.
 */
export function extractFullVin(value: unknown): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  const match = text.match(
    /(?:^|[^A-Z0-9])([A-HJ-NPR-Z0-9]{17})(?=$|[^A-Z0-9])/
  );
  return match?.[1] || null;
}

/**
 * Decodes the VIN model-year cycle without a network call. For standard VINs,
 * a numeric seventh character selects the 1980-2009 cycle and an alphabetic
 * seventh character selects the 2010-2039 cycle. The result is only suitable
 * as a fallback because specialty/heavy vehicle VINs can require manufacturer
 * or vPIC context to disambiguate the repeating 30-year code.
 */
export function modelYearFromVin(value: unknown): number | undefined {
  const vin = extractFullVin(value);
  if (!vin) return undefined;

  const codeIndex = MODEL_YEAR_CODES.indexOf(vin[9]);
  if (codeIndex < 0) return undefined;

  const seventh = vin[6];
  if (/^[0-9]$/.test(seventh)) return 1980 + codeIndex;
  if (/^[A-HJ-NPR-Z]$/.test(seventh)) return 2010 + codeIndex;
  return undefined;
}
