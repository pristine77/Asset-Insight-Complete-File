import {
  CONDITION_SELECTION_GROUPS,
  normalizeConditionSelection,
  type ConditionSelectionKey,
} from './conditionSelections';

type ConditionLot = {
  condition_report_selections?: Record<string, string>;
  condition_report_specs?: Record<string, string> | Array<{ field?: string; value?: unknown }>;
  condition_report_specs_deleted?: string[];
};

const specKey = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Preserve the existing native Running Condition/spec synchronization contract. */
export function applyRunningConditionSelectionToLot<T extends ConditionLot>(
  lot: T,
  value: string
): T {
  const existing = lot.condition_report_specs || {};
  const specs: Record<string, string> = Array.isArray(existing)
    ? Object.fromEntries(
        existing
          .map((entry) => [String(entry?.field || '').trim(), String(entry?.value ?? '')])
          .filter(([field]) => field)
      )
    : { ...existing };
  const runningKey = specKey('Running Condition');
  const existingKey = Object.keys(specs).find((field) => specKey(field) === runningKey);
  if (normalizeConditionSelection(value) === 'n/a') {
    if (existingKey) delete specs[existingKey];
  } else specs[existingKey || 'Running Condition'] = value;
  return {
    ...lot,
    condition_report_selections: { ...lot.condition_report_selections, condition: value },
    condition_report_specs: specs,
    condition_report_specs_deleted: Array.isArray(lot.condition_report_specs_deleted)
      ? lot.condition_report_specs_deleted
          .map((field) => String(field || '').trim())
          .filter((field) => field && specKey(field) !== runningKey)
      : [],
  };
}

export function applyLotConditionSelection<T extends ConditionLot>(
  lot: T,
  field: ConditionSelectionKey,
  value: string
): T {
  const option = CONDITION_SELECTION_GROUPS.find((group) => group.key === field)?.options.find(
    (candidate) => normalizeConditionSelection(candidate) === normalizeConditionSelection(value)
  );
  if (!option) return lot;
  if (field !== 'condition')
    return {
      ...lot,
      condition_report_selections: { ...lot.condition_report_selections, [field]: option },
    };
  const next = applyRunningConditionSelectionToLot(lot, option);
  const specs = { ...next.condition_report_specs } as Record<string, string>;
  const workingKeys = Object.keys(specs).filter((key) => specKey(key) === 'workingcondition');
  for (const key of workingKeys) {
    if (normalizeConditionSelection(option) === 'n/a') delete specs[key];
    else specs[key] = option;
  }
  return {
    ...next,
    condition_report_specs: specs,
    condition_report_specs_deleted: next.condition_report_specs_deleted?.filter(
      (key) => specKey(key) !== 'workingcondition'
    ),
  };
}

/** Selection indexes are ephemeral and fenced/cleared by the preview lifecycle. */
export function applySelectedLotCondition<T extends ConditionLot>(
  lots: T[],
  indexes: ReadonlySet<number>,
  field: ConditionSelectionKey,
  value: string
): T[] {
  return lots.map((lot, index) =>
    indexes.has(index) ? applyLotConditionSelection(lot, field, value) : lot
  );
}

export function toggleAssetLotSelection(
  indexes: ReadonlySet<number>,
  index: number,
  count: number
): Set<number> {
  const next = new Set(
    [...indexes].filter((item) => Number.isInteger(item) && item >= 0 && item < count)
  );
  if (!Number.isInteger(index) || index < 0 || index >= count) return next;
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}
