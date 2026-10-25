export const MAXIMUM_DAMAGE_ANALYSIS_LOT_NUMBER = 1000n;

export function resolveDamageAnalysisEnabled(value: unknown, fallback = true): boolean {
  if (value === false || value === 0 || /^(?:false|0|off|no)$/i.test(String(value ?? "").trim())) {
    return false;
  }
  if (value === true || value === 1 || /^(?:true|1|on|yes)$/i.test(String(value ?? "").trim())) {
    return true;
  }
  return fallback;
}

/**
 * Reads the first numeric portion of a user-facing lot identifier.
 * Formatting separators are ignored, so `Lot #0999`, `999A`, `lot-001`,
 * and `1,000` resolve to 999, 999, 1, and 1000 respectively.
 *
 * Missing and completely nonnumeric identifiers return null so they retain
 * the existing damage-analysis behaviour.
 */
export function parseLotNumberNumericPortion(value: unknown): bigint | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const match = text.match(/\d[\d,]*/);
  if (!match) return null;

  const digits = match[0].replace(/,/g, "");
  if (!digits) return null;

  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

export function isLotDamageAnalysisEligible(lotNumber: unknown): boolean {
  const numericPortion = parseLotNumberNumericPortion(lotNumber);
  return numericPortion === null || numericPortion <= MAXIMUM_DAMAGE_ANALYSIS_LOT_NUMBER;
}

export function resolveLotNumberForDamagePolicy(
  lot: Record<string, any> | null | undefined,
  fallbackLotNumber?: unknown
): unknown {
  const candidates = [lot?.lot_number, lot?.lotNumber, lot?.lot, lot?.lot_id, lot?.id];
  for (const candidate of candidates) {
    if (String(candidate ?? "").trim()) return candidate;
  }
  return fallbackLotNumber;
}

export function isLotRecordDamageAnalysisEligible(
  lot: Record<string, any> | null | undefined,
  fallbackLotNumber?: unknown
): boolean {
  return isLotDamageAnalysisEligible(
    resolveLotNumberForDamagePolicy(lot, fallbackLotNumber)
  );
}

export function enforceLotDamageAnalysisPolicy<T extends Record<string, any>>(
  lot: T,
  options: {
    includeDamageAnalysis?: boolean;
    fallbackLotNumber?: unknown;
    inheritedLotNumber?: unknown;
  } = {}
): T {
  if (!lot || typeof lot !== "object") return lot;

  const explicitNestedLotNumber = [lot?.lot_number, lot?.lotNumber, lot?.lot].find(
    (candidate) => String(candidate ?? "").trim()
  );
  const ownLotNumber =
    options.inheritedLotNumber !== undefined && explicitNestedLotNumber === undefined
      ? options.inheritedLotNumber
      : resolveLotNumberForDamagePolicy(lot, options.fallbackLotNumber);
  const damageAllowed =
    options.includeDamageAnalysis !== false &&
    isLotDamageAnalysisEligible(ownLotNumber);
  const next: Record<string, any> = {
    ...lot,
    ...(damageAllowed ? {} : { damage_analysis: null }),
  };

  if (Array.isArray(lot.items)) {
    next.items = lot.items.map((item: any, itemIndex: number) =>
      item && typeof item === "object"
        ? enforceLotDamageAnalysisPolicy(item, {
            includeDamageAnalysis: options.includeDamageAnalysis,
            inheritedLotNumber: ownLotNumber ?? options.fallbackLotNumber,
            fallbackLotNumber: options.fallbackLotNumber ?? itemIndex + 1,
          })
        : item
    );
  }

  return next as T;
}

export function enforceLotsDamageAnalysisPolicy<T extends Record<string, any>>(
  lots: T[] | null | undefined,
  includeDamageAnalysis: boolean = true
): T[] {
  if (!Array.isArray(lots)) return [];
  return lots.map((lot, index) =>
    enforceLotDamageAnalysisPolicy(lot, {
      includeDamageAnalysis,
      fallbackLotNumber: index + 1,
    })
  );
}
