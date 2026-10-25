import { applyPrimarySerialEdit, isPrimarySerialField } from './previewSerialNumber';

type PreviewLot = Record<string, any>;
const baseKey = (field: unknown) => String(field ?? '').trim().toLowerCase()
  .replace(/\s*\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '');
const aliases = [
  ['serialnumber', 'serialno', 'vin', 'sn', 'sno'],
  ['haskey', 'haskeys', 'keys', 'key'],
  ['runningcondition', 'condition', 'workingcondition'],
  ['fueltype', 'fuel', 'primaryfueltype'],
  ['ownershiptype', 'legal', 'titlestatus'],
  ['odometer', 'showingmileage', 'mileage'],
  ['enginehours', 'hours', 'showinghours', 'hourmeter', 'hourmeterreading', 'meterhours', 'operatinghours'],
  ['buckettype', 'bucket'], ['enginemanufacturer', 'enginemake', 'motormanufacturer', 'motormake'],
  ['enginemodel', 'motormodel'], ['enginehp', 'enginehorsepower'],
];
const deletionCollections = ['condition_report_specs_deleted', 'deleted_condition_report_specs',
  'removed_condition_report_specs', 'hidden_condition_report_specs'];

/** Matches backend field aliases. Dimensions alias only with unambiguous category authority. */
export function previewSpecFieldKey(field: unknown, categoryFields: string[] = []): string {
  const key = baseKey(field).replace(/colour/g, 'color');
  for (const dimension of ['length', 'width', 'height']) {
    const overall = `overall${dimension}`;
    if (key === dimension || key === overall) {
      const categoryKeys = categoryFields.map(baseKey);
      if (categoryKeys.includes(dimension) !== categoryKeys.includes(overall)) return overall;
    }
  }
  return aliases.find(group => group.includes(key))?.[0] || key;
}
const record = (value: unknown): Record<string, string> => Array.isArray(value)
  ? Object.fromEntries(value.map(entry => [String(entry?.field ?? '').trim(), String(entry?.value ?? '')]).filter(([field]) => field))
  : value && typeof value === 'object' ? { ...value as Record<string, string> } : {};

/** Later review edits replace earlier CR/Excel overrides, including explicit blanks. */
export function applyPreviewSpecEdit(lot: PreviewLot, fieldName: string, value: string,
  categoryFields: string[] = [], options: { deleted?: boolean; added?: boolean } = {}): PreviewLot {
  const field = fieldName.trim();
  if (!field) return lot;
  if (isPrimarySerialField(field)) return applyPrimarySerialEdit(lot, options.deleted ? '' : value);
  const key = previewSpecFieldKey(field, categoryFields);
  const matches = (candidate: unknown) => previewSpecFieldKey(candidate, categoryFields) === key;
  const next = { ...lot };
  const specs = record(lot.condition_report_specs), overrides = record(lot.condition_report_specs_manual_overrides);
  for (const current of Object.keys(specs)) if (matches(current)) delete specs[current];
  for (const current of Object.keys(overrides)) if (matches(current)) delete overrides[current];
  for (const collectionName of deletionCollections) {
    const collection = lot[collectionName];
    if (Array.isArray(collection)) next[collectionName] = collection.filter(field => !matches(field));
    else if (collection && typeof collection === 'object') {
      next[collectionName] = Object.fromEntries(Object.entries(collection).filter(([field]) => !matches(field)));
    }
  }
  const deletion = next.condition_report_specs_deleted;
  const deleted = (Array.isArray(deletion) ? deletion
    : deletion && typeof deletion === 'object' ? Object.entries(deletion).filter(([, removed]) => removed).map(([field]) => field) : [])
    .map((field: unknown) => String(field ?? '').trim()).filter(Boolean);
  if (options.deleted) deleted.push(field);
  else specs[field] = value;
  // Deletion also suppresses older aliases in generated/imported legacy sources.
  overrides[field] = options.deleted ? '' : value;
  next.condition_report_specs = specs;
  next.condition_report_specs_manual_overrides = overrides;
  next.condition_report_specs_deleted = deleted;
  if (Array.isArray(lot.condition_report_specs_custom_order) || options.added) {
    let inserted = false;
    const order = (Array.isArray(lot.condition_report_specs_custom_order) ? lot.condition_report_specs_custom_order : [])
      .flatMap((candidate: unknown) => {
        if (!matches(candidate)) return [candidate];
        if (options.deleted || inserted) return [];
        inserted = true; return [field];
      });
    if (options.added && !options.deleted && !inserted) order.push(field);
    next.condition_report_specs_custom_order = order;
  }
  return next;
}
