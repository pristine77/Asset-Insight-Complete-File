export type ConditionSelectionKey = 'condition' | 'completeness' | 'legal';

export type ConditionSelections = Partial<Record<ConditionSelectionKey, string>>;

export const CONDITION_SELECTION_GROUPS: {
  key: ConditionSelectionKey;
  label: string;
  options: string[];
}[] = [
  {
    key: 'condition',
    label: 'Running Condition',
    options: [
      'Starts and Runs',
      'Does not Start or Run',
      'Starts and Runs with Boost',
      'Unverified Running Condition',
      'N/A',
    ],
  },
  {
    key: 'completeness',
    label: 'Completeness',
    options: ['Has Keys', 'Missing Parts', 'Incomplete Unit', 'N/A'],
  },
  {
    key: 'legal',
    label: 'Legal',
    options: ['Salvage', 'No Title', 'N/A'],
  },
];

const getLotNumber = (lot: any, index: number) =>
  String(lot?.lot_number ?? lot?.lot_id ?? lot?.id ?? index + 1);

export const normalizeConditionSelection = (value: unknown) => {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/^na$/, 'n/a')
    .replace(/^not applicable$/, 'n/a');
  if (
    normalized === 'unknown working condition' ||
    normalized === 'untested' ||
    normalized === 'unverified working condition'
  ) {
    return 'unverified running condition';
  }
  if (normalized === 'non-operational' || normalized === 'non operational') {
    return 'does not start or run';
  }
  return normalized;
};

export const getMissingConditionSelectionMessage = (lots: any[] = []) => {
  const missingLabels = new Set<string>();
  const missingLots: string[] = [];

  lots.forEach((lot, index) => {
    const selections = lot?.condition_report_selections || {};
    const missingForLot = CONDITION_SELECTION_GROUPS.filter((group) => {
      const selected = normalizeConditionSelection(selections[group.key]);
      return !group.options.some((option) => normalizeConditionSelection(option) === selected);
    });

    if (missingForLot.length === 0) {
      return;
    }

    missingForLot.forEach((group) => missingLabels.add(group.label));
    missingLots.push(getLotNumber(lot, index));
  });

  if (missingLots.length === 0) {
    return '';
  }

  return `Please select ${Array.from(missingLabels).join(', ')} for Lot ${missingLots.join(', ')}`;
};
