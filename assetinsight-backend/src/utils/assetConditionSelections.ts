export type AssetConditionSelectionKey = "condition" | "completeness" | "legal";

export type AssetConditionReportSelections = Partial<
  Record<AssetConditionSelectionKey, string>
>;

export const assetConditionSelectionGroups: Array<{
  key: AssetConditionSelectionKey;
  label: string;
  options: string[];
}> = [
  {
    key: "condition",
    label: "Running Condition",
    options: [
      "Starts and Runs",
      "Does not Start or Run",
      "Starts and Runs with Boost",
      "Unverified Running Condition",
      "N/A",
    ],
  },
  {
    key: "completeness",
    label: "Completeness",
    options: ["Has Keys", "Missing Parts", "Incomplete Unit", "N/A"],
  },
  {
    key: "legal",
    label: "Legal",
    options: ["Salvage", "No Title", "N/A"],
  },
];

const selectionOptionsByKey = new Map(
  assetConditionSelectionGroups.map((group) => [
    group.key,
    new Map(group.options.map((option) => [normalizeOption(option), option])),
  ])
);

function normalizeOption(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function normalizeAssetConditionSelectionValue(
  key: AssetConditionSelectionKey,
  value: unknown
): string {
  const normalized = normalizeOption(value);
  if (!normalized) return "";

  const canonical = selectionOptionsByKey.get(key)?.get(normalized);
  if (canonical) return canonical;

  if (
    key === "condition" &&
    (normalized === "unknown working condition" ||
      normalized === "untested" ||
      normalized === "unverified working condition")
  ) {
    return "Unverified Running Condition";
  }

  if (
    key === "condition" &&
    (normalized === "non operational" ||
      normalized === "non-operational" ||
      normalized === "does not start or run")
  ) {
    return "Does not Start or Run";
  }

  if (normalized === "na" || normalized === "n/a" || normalized === "not applicable") {
    return "N/A";
  }

  return "";
}

export function normalizeAssetConditionReportSelections(
  value: unknown
): AssetConditionReportSelections {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  return assetConditionSelectionGroups.reduce((acc, group) => {
    const normalized = normalizeAssetConditionSelectionValue(group.key, source[group.key]);
    if (normalized) acc[group.key] = normalized;
    return acc;
  }, {} as AssetConditionReportSelections);
}

function getLotDisplayNumber(lot: any, index: number): string {
  const candidates = [lot?.lot_number, lot?.lot_id, lot?.lot, lot?.id];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }
  return String(index + 1);
}

export function getMissingAssetConditionSelectionMessage(
  lots: any[] | null | undefined
): string | null {
  if (!Array.isArray(lots) || lots.length === 0) return null;

  const missingKeys = new Set<AssetConditionSelectionKey>();
  const invalidLotNumbers: string[] = [];

  lots.forEach((lot, index) => {
    const selections = normalizeAssetConditionReportSelections(
      lot?.condition_report_selections
    );

    const lotMissing = assetConditionSelectionGroups.filter((group) => {
      const value = selections[group.key];
      return !value || !selectionOptionsByKey.get(group.key)?.has(normalizeOption(value));
    });

    if (lotMissing.length > 0) {
      invalidLotNumbers.push(getLotDisplayNumber(lot, index));
      lotMissing.forEach((group) => missingKeys.add(group.key));
    }
  });

  if (invalidLotNumbers.length === 0) return null;

  const missingLabels = assetConditionSelectionGroups
    .filter((group) => missingKeys.has(group.key))
    .map((group) => group.label)
    .join(", ");

  return `Please select ${missingLabels} for Lot ${invalidLotNumbers.join(", ")}`;
}
