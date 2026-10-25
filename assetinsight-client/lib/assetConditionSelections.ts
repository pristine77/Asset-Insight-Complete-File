export type AssetConditionSelectionKey = "condition" | "completeness" | "legal";

export const ASSET_CONDITION_SELECTION_GROUPS: ReadonlyArray<{
  key: AssetConditionSelectionKey;
  label: string;
  options: readonly string[];
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
  { key: "legal", label: "Legal", options: ["Salvage", "No Title", "N/A"] },
];

export function normalizeAssetConditionSelection(value: unknown) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (["na", "not applicable"].includes(normalized)) return "n/a";
  if (["unknown working condition", "untested", "unverified working condition"].includes(normalized)) {
    return "unverified running condition";
  }
  if (["non-operational", "non operational"].includes(normalized)) {
    return "does not start or run";
  }
  return normalized;
}

const normalizeSpecKey = (value: unknown) =>
  String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

function specsToRecord(rawSpecs: any): Record<string, string> {
  if (!Array.isArray(rawSpecs)) {
    return rawSpecs && typeof rawSpecs === "object" ? { ...rawSpecs } : {};
  }
  return Object.fromEntries(
    rawSpecs
      .map((entry: any) => [
        String(entry?.field || "").trim(),
        String(entry?.value ?? ""),
      ])
      .filter((entry: string[]) => entry[0]),
  );
}

/** Apply one group only; mirror backend Running/Working Condition aliases. */
export function applyAssetConditionSelection(
  lot: any,
  key: AssetConditionSelectionKey,
  value: string,
) {
  const group = ASSET_CONDITION_SELECTION_GROUPS.find((entry) => entry.key === key);
  if (!group?.options.includes(value)) return lot;
  const nextLot = {
    ...lot,
    condition_report_selections: { ...lot?.condition_report_selections, [key]: value },
  };
  if (key !== "condition") return nextLot;
  const specs = specsToRecord(lot?.condition_report_specs);
  const isRunningField = (field: string) =>
    ["runningcondition", "workingcondition"].includes(normalizeSpecKey(field));
  const existingKeys = Object.keys(specs).filter(isRunningField);
  if (normalizeAssetConditionSelection(value) === "n/a") {
    existingKeys.forEach((field) => delete specs[field]);
  } else {
    // Keep existing schema labels, but never leave a stale alias visible locally.
    const fields = existingKeys.length ? existingKeys : ["Running Condition"];
    fields.forEach((field) => { specs[field] = value; });
  }
  const deletedSpecs = Array.isArray(lot?.condition_report_specs_deleted)
    ? lot.condition_report_specs_deleted
        .map((field: any) => String(field || "").trim())
        .filter((field: string) => field && !isRunningField(field))
    : [];
  return {
    ...nextLot,
    condition_report_specs: specs,
    condition_report_specs_deleted: deletedSpecs,
  };
}

export function applyAssetConditionSelectionToLots(
  lots: any[],
  indexes: ReadonlySet<number>,
  key: AssetConditionSelectionKey,
  value: string,
) {
  return lots.map((lot, index) =>
    indexes.has(index) ? applyAssetConditionSelection(lot, key, value) : lot,
  );
}

export function getSharedAssetConditionSelection(
  lots: any[],
  indexes: ReadonlySet<number>,
  key: AssetConditionSelectionKey,
) {
  const selected = Array.from(indexes).filter(
    (index) => index >= 0 && index < lots.length,
  );
  if (!selected.length) return "";
  const first = normalizeAssetConditionSelection(
    lots[selected[0]]?.condition_report_selections?.[key],
  );
  const group = ASSET_CONDITION_SELECTION_GROUPS.find((entry) => entry.key === key);
  const isKnown = group?.options.some(
    (option) => normalizeAssetConditionSelection(option) === first,
  );
  const allSame = selected.every(
    (index) => normalizeAssetConditionSelection(lots[index]?.condition_report_selections?.[key]) === first,
  );
  return isKnown && allSame ? first : "";
}
