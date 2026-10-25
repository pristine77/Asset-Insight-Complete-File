export type LotValuationMethodDetail = {
  method?: unknown;
  fullName?: unknown;
  percentage?: unknown;
};

export type LotValuationLine = {
  method: string;
  fullName: string;
  percentage: number | null;
  value: number | null;
};

const METHOD_NAMES: Record<string, string> = {
  FML: "Fair Market Value",
  TKV: "Trade Value",
  OLV: "Orderly Liquidation Value",
  FLV: "Forced Liquidation Value",
};

const CURRENCY_ALIASES: Record<string, string> = {
  "$": "USD",
  "US$": "USD",
  "C$": "CAD",
  "CA$": "CAD",
};

function normalizedMethod(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function finitePercentage(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseLotEstimatedValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? "").replace(/,/g, "");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildLotValuationLines(
  estimatedValue: unknown,
  selectedMethods: unknown,
  methodDetails: unknown
): LotValuationLine[] {
  const details = Array.isArray(methodDetails)
    ? (methodDetails as LotValuationMethodDetail[])
    : [];
  const detailByMethod = new Map(
    details
      .map((detail) => [normalizedMethod(detail?.method), detail] as const)
      .filter(([method]) => Boolean(method))
  );
  const requestedMethods = Array.isArray(selectedMethods)
    ? selectedMethods.map(normalizedMethod)
    : [];
  const orderedMethods = requestedMethods.length
    ? requestedMethods
    : details.map((detail) => normalizedMethod(detail?.method));
  const baseValue = parseLotEstimatedValue(estimatedValue);

  return Array.from(new Set(orderedMethods.filter(Boolean))).map((method) => {
    const detail = detailByMethod.get(method);
    const percentage =
      finitePercentage(detail?.percentage) ?? (method === "FML" ? 100 : null);

    return {
      method,
      fullName:
        String(detail?.fullName ?? "").trim() || METHOD_NAMES[method] || method,
      percentage,
      value:
        baseValue === null || percentage === null
          ? null
          : (baseValue * percentage) / 100,
    };
  });
}

export function formatLotValuationValue(value: number | null, currency: unknown) {
  if (value === null || !Number.isFinite(value)) return "—";

  const rawCurrency = String(currency ?? "CAD").trim() || "CAD";
  const currencyCode = CURRENCY_ALIASES[rawCurrency] || rawCurrency.toUpperCase();
  if (/^[A-Z]{3}$/.test(currencyCode)) {
    try {
      return new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency: currencyCode,
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      // Fall through to a readable value for legacy currency labels.
    }
  }

  const amount = new Intl.NumberFormat("en-CA", {
    maximumFractionDigits: 0,
  }).format(value);
  return rawCurrency.endsWith("$") ? `${rawCurrency}${amount}` : `${rawCurrency} ${amount}`;
}
