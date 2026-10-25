import { applyPrimarySerialEdit, isPrimarySerialField } from './previewSerialNumber';

describe('preview serial authority', () => {
  it.each(['Serial Number', 'VIN', 'S/N', 'Serial No', 'S. No', 'Serial Number (Unverified)'])(
    'replaces an older %s correction when the appraiser edits or clears it',
    (field) => {
      const original = {
        serial_number: 'OLD-123',
        condition_report_specs: { [field]: 'OLD-123', 'Engine Serial Number': 'ENGINE-456' },
        condition_report_specs_manual_overrides: { [field]: 'ADMIN-OLD', Colour: 'Red' },
        condition_report_specs_deleted: [field, 'Hours'],
      };
      const edited = applyPrimarySerialEdit(original, 'NEW-789');
      expect(edited.serial_number).toBe('NEW-789');
      expect(edited.condition_report_specs).toEqual({
        'Serial Number': 'NEW-789', 'Engine Serial Number': 'ENGINE-456',
      });
      expect(edited.condition_report_specs_manual_overrides).toEqual({
        'Serial Number': 'NEW-789', Colour: 'Red',
      });
      expect(edited.condition_report_specs_deleted).toEqual(['Hours']);
      expect(original.condition_report_specs_manual_overrides[field]).toBe('ADMIN-OLD');
      const cleared = applyPrimarySerialEdit(edited, '');
      expect(cleared.serial_number).toBe('');
      expect(cleared.condition_report_specs_manual_overrides).toEqual({ 'Serial Number': '', Colour: 'Red' });
      expect(cleared.condition_report_specs_deleted).toEqual(['Hours', 'Serial Number']);
    },
  );

  it('allows re-entry after legacy deletion markers without restoring unrelated deleted fields', () => {
    const original = {
      serial_number: '',
      condition_report_specs_deleted: { 'Serial Number (Unverified)': true, Colour: true, Axles: false },
      deleted_condition_report_specs: ['VIN', 'Engine Serial Number'],
      removed_condition_report_specs: { 'S. No': true, Hours: true },
      hidden_condition_report_specs: ['Serial No', 'Make'],
    };
    const edited = applyPrimarySerialEdit(original, 'RESTORED-123');
    expect(edited.serial_number).toBe('RESTORED-123');
    expect(edited.condition_report_specs_manual_overrides).toEqual({ 'Serial Number': 'RESTORED-123' });
    expect(edited.condition_report_specs_deleted).toEqual(['Colour']);
    expect(edited.deleted_condition_report_specs).toEqual(['Engine Serial Number']);
    expect(edited.removed_condition_report_specs).toEqual({ Hours: true });
    expect(edited.hidden_condition_report_specs).toEqual(['Make']);
    expect(original.removed_condition_report_specs).toEqual({ 'S. No': true, Hours: true });
  });

  it('does not classify a separate engine serial as the primary serial', () => {
    expect(isPrimarySerialField('Engine Serial Number')).toBe(false);
  });
});
