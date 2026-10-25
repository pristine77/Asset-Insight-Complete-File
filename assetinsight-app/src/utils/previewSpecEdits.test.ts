import { applyPreviewSpecEdit, previewSpecFieldKey } from './previewSpecEdits';

const fields = ['Overall Length', 'Overall Width', 'Overall Height'];
const lot = () => ({
  lot_id: 'lot-1826', description: 'Keep description', categories: 'Equipment',
  image_urls: ['original-a', 'original-b'], image_indexes: [1, 2], cover_image_url: 'original-b',
  condition_report_specs_reviewed: true,
  condition_report_specs: { Length: '10 ft', 'Overall Length': 'Old length', Width: '5 ft', Height: '6 ft', 'Internal Length': '4 ft', Notes: 'Scratches visible on left side' },
  condition_report_specs_manual_overrides: { Length: 'older override', 'Overall Length': 'stale duplicate', Width: 'older width', Notes: 'Keep note override' },
  condition_report_specs_deleted: ['Length', 'Colour'],
  deleted_condition_report_specs: { 'Overall Length': true, Width: true, Axles: false },
  removed_condition_report_specs: ['Length', 'Engine Serial Number'],
  hidden_condition_report_specs: { Length: true, 'Internal Length': true },
  condition_report_specs_custom_order: ['Notes', 'Length', 'Width', 'Internal Length'],
});

it('replaces stale aliases and manual overrides, clears all matching legacy tombstones, and retains unrelated data', () => {
  const original = lot(), edited = applyPreviewSpecEdit(original, 'Overall Length', '12 ft', fields);
  expect(edited.condition_report_specs).toEqual({ 'Overall Length': '12 ft', Width: '5 ft', Height: '6 ft', 'Internal Length': '4 ft', Notes: 'Scratches visible on left side' });
  expect(edited.condition_report_specs_manual_overrides).toEqual({ 'Overall Length': '12 ft', Width: 'older width', Notes: 'Keep note override' });
  expect(edited.condition_report_specs_deleted).toEqual(['Colour']);
  expect(edited.deleted_condition_report_specs).toEqual({ Width: true, Axles: false });
  expect(edited.removed_condition_report_specs).toEqual(['Engine Serial Number']);
  expect(edited.hidden_condition_report_specs).toEqual({ 'Internal Length': true });
  expect(edited.condition_report_specs_custom_order).toEqual(['Notes', 'Overall Length', 'Width', 'Internal Length']);
  expect(edited.image_urls).toBe(original.image_urls); expect(edited.image_indexes).toBe(original.image_indexes);
  expect(edited.cover_image_url).toBe('original-b'); expect(edited.condition_report_specs_reviewed).toBe(true);
  expect(original).toEqual(lot());
});

it.each(['', '   ', 'Scratches visible on left side'])('keeps intentional reviewed text exactly: %j', value => {
  const edited = applyPreviewSpecEdit(lot(), 'Overall Length', value, fields);
  expect(edited.condition_report_specs['Overall Length']).toBe(value);
  expect(edited.condition_report_specs_manual_overrides['Overall Length']).toBe(value);
  expect(edited.condition_report_specs_deleted).toEqual(['Colour']);
});

it('deletion removes every matching alias and leaves explicit suppression rather than an older manual override', () => {
  const edited = applyPreviewSpecEdit(lot(), 'Overall Width', '', fields, { deleted: true });
  expect(edited.condition_report_specs).not.toHaveProperty('Width');
  expect(edited.condition_report_specs_manual_overrides).not.toHaveProperty('Width');
  expect(edited.condition_report_specs_manual_overrides['Overall Width']).toBe('');
  expect(edited.condition_report_specs_deleted).toEqual(['Length', 'Colour', 'Overall Width']);
  expect(edited.deleted_condition_report_specs).toEqual({ 'Overall Length': true, Axles: false });
});

it('deleting the last canonical spec retains an explicit empty object through JSON and supports re-entry', () => {
  const original = { condition_report_specs: [{ field: 'Width', value: '5 ft' }], condition_report_specs_manual_overrides: { Width: '6 ft' } };
  const deleted = applyPreviewSpecEdit(original, 'Overall Width', '', fields, { deleted: true });
  const reloaded = JSON.parse(JSON.stringify(deleted));
  expect(reloaded.condition_report_specs).toEqual({});
  expect(reloaded.condition_report_specs_manual_overrides).toEqual({ 'Overall Width': '' });
  expect(reloaded.condition_report_specs_deleted).toEqual(['Overall Width']);
  const edited = applyPreviewSpecEdit(reloaded, 'Width', '7 ft', fields, { added: true });
  expect(edited.condition_report_specs).toEqual({ Width: '7 ft' });
  expect(edited.condition_report_specs_manual_overrides).toEqual({ Width: '7 ft' });
  expect(edited.condition_report_specs_deleted).toEqual([]);
});

it.each([{ categoryFields: [] }, { categoryFields: ['Length', 'Overall Length'] }])('does not collapse ambiguous dimension authority %j', ({ categoryFields }) => {
  const edited = applyPreviewSpecEdit(lot(), 'Overall Length', '12 ft', categoryFields);
  expect(edited.condition_report_specs.Length).toBe('10 ft');
  expect(edited.condition_report_specs_manual_overrides.Length).toBe('older override');
  expect(previewSpecFieldKey('Length', categoryFields)).not.toBe(previewSpecFieldKey('Overall Length', categoryFields));
});

it('keeps Internal/Cargo/Bed/Working dimensions separate from overall dimensions', () => {
  for (const field of ['Internal Length', 'Cargo Width', 'Bed Length', 'Working Width']) {
    expect(previewSpecFieldKey(field, fields)).not.toBe(previewSpecFieldKey(field.includes('Width') ? 'Overall Width' : 'Overall Length', fields));
  }
});

it('keeps numeric zero from legacy arrays and all unrelated order when adding a field', () => {
  const edited = applyPreviewSpecEdit({ condition_report_specs: [{ field: 'Count', value: 0 }], condition_report_specs_custom_order: ['Count'] }, 'Notes', 'Exact\ntext', [], { added: true });
  expect(edited.condition_report_specs).toEqual({ Count: '0', Notes: 'Exact\ntext' });
  expect(edited.condition_report_specs_custom_order).toEqual(['Count', 'Notes']);
});

it('retains the established primary serial root/legacy tombstone semantics', () => {
  const edited = applyPreviewSpecEdit({ serial_number: 'old', vin: 'stale', condition_report_specs: { VIN: 'old' }, condition_report_specs_manual_overrides: { 'Serial No': 'old' } }, 'Serial Number', '');
  expect(edited.serial_number).toBe(''); expect(edited.vin).toBe('');
  expect(edited.condition_report_specs_manual_overrides).toEqual({ 'Serial Number': '' });
  expect(edited.condition_report_specs_deleted).toEqual(['Serial Number']);
});
