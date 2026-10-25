import {
  applyLotConditionSelection,
  applyRunningConditionSelectionToLot,
  applySelectedLotCondition,
  toggleAssetLotSelection,
} from './assetConditionSelection';

const lots = () =>
  Array.from({ length: 100 }, (_, index) => ({
    lot_id: `stable-${index}`,
    lot_number: String(index + 1),
    title: `Lot ${index + 1}`,
    description: 'First line\nSecond line',
    details: 'Original details',
    image_indexes: [index * 2, index * 2 + 1],
    image_urls: [`https://assetinsight.pro/${index}.jpg`],
    cover_index: index * 2 + 1,
    condition_report_selections: {
      condition: 'Starts and Runs',
      completeness: 'Has Keys',
      legal: 'No Title',
    },
    condition_report_specs: {
      'Running Condition': 'Starts and Runs',
      'Serial Number': `VIN-${index}`,
    },
    condition_report_specs_deleted: ['Running Condition', 'Other field'],
  }));

it('changes only lots4/8/9 and only the requested group without mutating photos, text or numbers', () => {
  const before = lots(),
    snapshot = JSON.stringify(before);
  const result = applySelectedLotCondition(before, new Set([3, 7, 8]), 'legal', 'Salvage');
  result.forEach((lot, index) => {
    if ([3, 7, 8].includes(index)) {
      expect(lot).toEqual({
        ...before[index],
        condition_report_selections: {
          ...before[index].condition_report_selections,
          legal: 'Salvage',
        },
      });
      expect(lot.image_indexes).toBe(before[index].image_indexes);
    } else expect(lot).toBe(before[index]);
  });
  expect(JSON.stringify(before)).toBe(snapshot);
});

it('supports all100 lots, every group and an authoritative individual override', () => {
  const indexes = new Set(Array.from({ length: 100 }, (_, index) => index));
  let result = applySelectedLotCondition(lots(), indexes, 'condition', 'Does not Start or Run');
  result = applySelectedLotCondition(result, indexes, 'completeness', 'Missing Parts');
  result = applySelectedLotCondition(result, indexes, 'legal', 'N/A');
  expect(
    result.every(
      (lot) =>
        lot.condition_report_selections.condition === 'Does not Start or Run' &&
        lot.condition_report_specs['Running Condition'] === 'Does not Start or Run' &&
        lot.condition_report_selections.completeness === 'Missing Parts' &&
        lot.condition_report_selections.legal === 'N/A'
    )
  ).toBe(true);
  const override = applyLotConditionSelection(result[7], 'legal', 'No Title');
  expect(override.condition_report_selections).toEqual({
    condition: 'Does not Start or Run',
    completeness: 'Missing Parts',
    legal: 'No Title',
  });
  expect(result[7].condition_report_selections.legal).toBe('N/A');
});

it('retains Running Condition spec/deletion synchronization including legacy array specs and N/A', () => {
  const lot = {
    condition_report_selections: { completeness: 'Has Keys', legal: 'Salvage' },
    condition_report_specs: [
      { field: 'running_condition', value: 'Old' },
      { field: 'Notes', value: 'Visible damage remains' },
    ],
    condition_report_specs_deleted: ['Running Condition', 'VIN'],
  };
  const changed = applyRunningConditionSelectionToLot(lot, 'Starts and Runs');
  expect(changed.condition_report_specs).toEqual({
    running_condition: 'Starts and Runs',
    Notes: 'Visible damage remains',
  });
  expect(changed.condition_report_specs_deleted).toEqual(['VIN']);
  expect(applyLotConditionSelection(changed, 'condition', 'N/A').condition_report_specs).toEqual({
    Notes: 'Visible damage remains',
  });
});

it('ignores unsupported values/invalid indexes and clears or toggles index selection without changing inputs', () => {
  const before = lots(),
    selected = new Set([3, 7, 8]);
  expect(applySelectedLotCondition(before, selected, 'legal', 'invented')).toEqual(before);
  expect(applySelectedLotCondition(before, new Set([-1, 100, NaN]), 'legal', 'Salvage')).toEqual(
    before
  );
  expect(toggleAssetLotSelection(selected, 7, 100)).toEqual(new Set([3, 8]));
  expect(toggleAssetLotSelection(selected, 100, 100)).toEqual(selected);
  expect(selected).toEqual(new Set([3, 7, 8]));
});

it('synchronizes both condition aliases for Asset while keeping the older LotListing helper unchanged', () => {
  const lot = {
    condition_report_specs: {
      'Running Condition': 'Old',
      'Working Condition': 'Stale',
      Notes: 'Keep',
    },
    condition_report_specs_deleted: ['Working Condition', 'Notes'],
  };
  const changed = applyLotConditionSelection(lot, 'condition', 'Starts and Runs');
  expect(changed.condition_report_specs).toEqual({
    'Running Condition': 'Starts and Runs',
    'Working Condition': 'Starts and Runs',
    Notes: 'Keep',
  });
  expect(changed.condition_report_specs_deleted).toEqual(['Notes']);
  expect(applyLotConditionSelection(lot, 'condition', 'N/A').condition_report_specs).toEqual({
    Notes: 'Keep',
  });
  expect(applyRunningConditionSelectionToLot(lot, 'N/A').condition_report_specs).toEqual({
    'Working Condition': 'Stale',
    Notes: 'Keep',
  });
});
