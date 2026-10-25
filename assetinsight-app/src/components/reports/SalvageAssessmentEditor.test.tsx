import React, { useState } from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import SalvageAssessmentEditor, { safeAssessmentUrl } from './SalvageAssessmentEditor';
import type {
  SalvageAssessmentInputs,
  SalvageAssessmentV2,
  SalvageComparableEvidence,
  SalvageValueConclusion,
} from '../../types/salvageAssessment';

jest.mock('../../context/ThemeContext', () => ({
  useAppTheme: () => ({
    colors: {
      background: '#111',
      surface: '#222',
      text: '#fff',
      textSecondary: '#ccc',
      textMuted: '#aaa',
      border: '#444',
      accent: '#f47',
      accentSoft: '#321',
      warning: '#fb0',
    },
  }),
}));

const inputs: SalvageAssessmentInputs = {
  year: 2020,
  make: 'Ford',
  model: 'F-150',
  trim: null,
  powertrain: null,
  vin: null,
  odometer: 123456,
  odometerUnit: 'km',
  province: 'AB',
  market: 'Calgary',
  effectiveDate: '2026-09-08',
  lossType: 'Collision',
  condition: null,
  damageDescription: 'Front damage',
  documentedBrand: null,
  brandProvince: null,
  brandEvidenceRef: null,
  currency: 'CAD',
  repairItems: [
    {
      description: 'Bumper',
      quantity: 1,
      unitPrice: 1000,
      referenceIds: ['ref-one'],
      appraiserReason: 'Reviewed supplier quote.',
    },
  ],
  labourItems: [],
  charges: [],
  sellerCosts: { fees: null, transport: null, storage: null, disposal: null },
  overrides: { preLoss: null, asIs: null },
  suppliedComparables: [],
  suppliedReferences: [],
};
const conclusion = (amount: number | null): SalvageValueConclusion => ({
  amount,
  low: null,
  high: null,
  currency: 'CAD',
  priceBasis: null,
  status: 'insufficient_evidence',
  comparableIds: [],
  method: 'Insufficient evidence.',
  referenceIds: [],
});
const candidate: SalvageComparableEvidence = {
  id: 'comp-one',
  basket: 'as_is',
  title: 'Current auction vehicle',
  url: 'https://www.canada.ca/listing',
  sourceName: 'Source',
  listingId: '123',
  vin: null,
  year: 2020,
  make: 'Ford',
  model: 'F-150',
  trim: null,
  powertrain: null,
  odometer: 123000,
  odometerUnit: 'km',
  condition: 'Damaged',
  brand: null,
  location: 'Calgary',
  province: 'AB',
  country: 'CA',
  eventDate: '2026-09-01',
  price: 1000,
  currency: 'CAD',
  priceBasis: 'current_bid',
  verification: 'verified',
  evidence: {},
  referenceIds: ['ref-one'],
  adjustments: [],
  fx: null,
  appraiserReason: null,
  photoIds: [],
  eligible: false,
  selected: false,
  exclusionReasons: ['Current bid is not a sale.'],
  adjustedPrice: null,
  ageDays: 7,
};
const assessment: SalvageAssessmentV2 = {
  schemaVersion: 2,
  generatedAt: '2026-09-08T12:00:00Z',
  stale: true,
  inputs,
  researchedInputs: inputs,
  photoFindings: [],
  candidates: [candidate],
  comparables: [],
  references: [
    {
      id: 'ref-one',
      kind: 'web',
      title: 'Verified source',
      url: 'https://www.canada.ca/listing',
      publisher: 'Publisher',
      accessedAt: '2026-09-08',
      excerpt: 'Actual saved source evidence.',
      photoIds: ['photo-001'],
    },
  ],
  valuations: { preLoss: conclusion(20000), asIs: conclusion(null) },
  repairs: {
    parts: [{ ...inputs.repairItems[0], total: 1000 }],
    labour: [],
    charges: [],
    partsTotal: 1000,
    labourTotal: null,
    chargesTotal: null,
    knownSubtotal: 1000,
    total: null,
    status: 'incomplete',
  },
  netRecovery: {
    gross: null,
    deductions: inputs.sellerCosts,
    knownDeductions: 0,
    total: null,
    status: 'incomplete',
    formula: 'Gross less deductions',
  },
  limitations: [
    {
      code: 'MISSING_COMPS',
      message: 'Comparable evidence is incomplete.',
      severity: 'warning',
      acknowledgementRequired: true,
    },
  ],
  research: { runId: 'original-paid-research' },
};

function Harness({
  disabled = false,
  changed = jest.fn(),
}: {
  disabled?: boolean;
  changed?: jest.Mock;
}) {
  const [draft, setDraft] = useState<Partial<SalvageAssessmentInputs>>(inputs);
  return (
    <SalvageAssessmentEditor
      assessment={assessment}
      inputs={draft}
      photos={['https://assetinsight.pro/photo-1.jpg']}
      disabled={disabled}
      onChange={(next) => {
        changed(next);
        setDraft(next);
      }}
    />
  );
}
beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => {
  jest.restoreAllMocks();
});

it('displays saved unavailable conclusions and does not recalculate them when inputs change', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} />);
  expect(screen.getAllByText('Unavailable')).toHaveLength(3);
  expect(screen.getByText(/Research is stale:/)).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Assessment make'), 'Chevrolet');
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ make: 'Chevrolet', model: 'F-150' })
  );
  expect(screen.getAllByText('Unavailable')).toHaveLength(3);
  expect(assessment.inputs.make).toBe('Ford');
  expect(assessment.research.runId).toBe('original-paid-research');
  expect(changed.mock.calls.at(-1)[0]).not.toHaveProperty('assessment');
});

it('keeps blank numeric inputs null and preserves explicit zero', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} />);
  await fireEvent.changeText(screen.getByLabelText('Assessment odometer'), '');
  expect(changed.mock.calls.at(-1)[0].odometer).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('Assessment odometer'), '0');
  expect(changed.mock.calls.at(-1)[0].odometer).toBe(0);
  await fireEvent.changeText(screen.getByLabelText('Assessment odometer'), '-7');
  expect(changed.mock.calls.at(-1)[0].odometer).toBe(0);
});

it('edits repair inputs while preserving references, rationale and saved totals', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} />);
  await fireEvent.press(screen.getByLabelText('Repair parts (1)'));
  await fireEvent.press(screen.getByLabelText('Part 1: Bumper'));
  await fireEvent.changeText(screen.getByLabelText('Part 1 quantity'), '2');
  expect(changed.mock.calls.at(-1)[0].repairItems[0]).toMatchObject({
    quantity: 2,
    unitPrice: 1000,
    referenceIds: ['ref-one'],
    appraiserReason: 'Reviewed supplier quote.',
  });
  expect(assessment.repairs.parts[0].total).toBe(1000);
  await fireEvent.changeText(screen.getByLabelText('Part 1 unit price (CAD)'), '');
  expect(changed.mock.calls.at(-1)[0].repairItems[0].unitPrice).toBeNull();
});

it('supports explicit seller zero and clears an override without touching saved valuations', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} />);
  await fireEvent.press(screen.getByLabelText('Seller deductions and net recovery inputs'));
  await fireEvent.press(screen.getByLabelText('Seller fees'));
  await fireEvent.changeText(screen.getByLabelText('Seller fees amount (CAD)'), '0');
  await fireEvent.changeText(
    screen.getByLabelText('Seller fees rationale'),
    'No seller fee per signed agreement.'
  );
  expect(changed.mock.calls.at(-1)[0].sellerCosts.fees).toMatchObject({
    amount: 0,
    appraiserReason: 'No seller fee per signed agreement.',
  });
  expect(changed.mock.calls.at(-1)[0].sellerCosts.transport).toBeNull();
  await fireEvent.press(screen.getByLabelText('Appraiser valuation overrides'));
  await fireEvent.press(screen.getByLabelText('As-is override'));
  await fireEvent.changeText(screen.getByLabelText('As-is override amount (CAD)'), '3000');
  expect(changed.mock.calls.at(-1)[0].overrides.asIs.amount).toBe(3000);
  await fireEvent.press(screen.getByLabelText('Clear As-is override'));
  expect(changed.mock.calls.at(-1)[0].overrides.asIs).toBeNull();
  expect(assessment.valuations.asIs.amount).toBeNull();
});

it('adds dated appraiser evidence and links exact uploaded photo IDs', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} />);
  await fireEvent.press(screen.getByLabelText('Appraiser evidence (0)'));
  await fireEvent.press(screen.getByLabelText('Add appraiser evidence'));
  await fireEvent.press(screen.getByLabelText('Evidence 1: New evidence'));
  await fireEvent.changeText(screen.getByLabelText('Evidence 1 title'), 'Sale invoice');
  await fireEvent.changeText(screen.getByLabelText('Evidence 1 date (YYYY-MM-DD)'), '2026-09-01');
  await fireEvent.press(screen.getByLabelText('Evidence 1 linked photos (0)'));
  await fireEvent.press(screen.getByLabelText('Evidence 1 photo 1'));
  expect(changed.mock.calls.at(-1)[0].suppliedReferences[0]).toMatchObject({
    kind: 'appraiser',
    title: 'Sale invoice',
    accessedAt: '2026-09-01',
    photoIds: ['photo-001'],
  });
  expect(changed.mock.calls.at(-1)[0].suppliedReferences[0].id).toMatch(/^appraiser-/);
});

it('keeps manual comparables appraiser supplied and supports documented signed adjustments', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} />);
  await fireEvent.press(screen.getByLabelText('Appraiser comparables (0)'));
  await fireEvent.press(screen.getByLabelText('Add appraiser comparable'));
  await fireEvent.press(screen.getByLabelText('Comparable 1: New vehicle'));
  await fireEvent.press(screen.getByLabelText('Comparable 1 price basis: sold'));
  await fireEvent.changeText(screen.getByLabelText('Comparable 1 price'), '5000');
  await fireEvent.press(screen.getByLabelText('Comparable 1 adjustments (0)'));
  await fireEvent.press(screen.getByLabelText('Add comparable 1 adjustment'));
  await fireEvent.press(screen.getByLabelText('Adjustment 1: New adjustment'));
  await fireEvent.changeText(screen.getByLabelText('Comparable 1 adjustment 1 amount'), '-500');
  const row = changed.mock.calls.at(-1)[0].suppliedComparables[0];
  expect(row).toMatchObject({
    price: 5000,
    priceBasis: 'sold',
    verification: 'appraiser_supplied',
    eligible: false,
    selected: false,
    adjustedPrice: null,
  });
  expect(row.adjustments[0].amount).toBe(-500);
});

it('keeps disabled assessments read-only while allowing safe source review', async () => {
  const changed = jest.fn();
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await render(<Harness changed={changed} disabled />);
  expect(screen.getByLabelText('Assessment make').props.editable).toBe(false);
  await fireEvent.changeText(screen.getByLabelText('Assessment make'), 'Forged');
  expect(changed).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Saved researched candidates (1)'));
  await fireEvent.press(screen.getByLabelText('Current auction vehicle'));
  expect(screen.getByText('Current bid is not a sale.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Open source: Current auction vehicle'));
  expect(open).toHaveBeenCalledWith('https://www.canada.ca/listing');
  expect(changed).not.toHaveBeenCalled();
});

it('does not open unsafe URLs or privileged application schemes', () => {
  for (const value of [
    'javascript:alert(1)',
    'file:///private/data',
    'intent://example.com',
    'http://localhost./',
    'http://127.0.0.1',
    'http://0x7f000001',
    'http://[::1]',
    'https://user:password@example.com',
    'http://192.168.1.1.nip.io',
    'http://metadata.google.internal',
    'https://site.local/',
    null,
  ])
    expect(safeAssessmentUrl(value)).toBeNull();
  expect(safeAssessmentUrl('https://assetinsight.pro/photo.jpg')).toBe(
    'https://assetinsight.pro/photo.jpg'
  );
});

it('does not present a comparable with missing currency as a CAD price', async () => {
  await render(
    <SalvageAssessmentEditor
      assessment={{ ...assessment, candidates: [{ ...candidate, currency: null }] }}
      inputs={inputs}
      disabled
      onChange={jest.fn()}
    />
  );
  await fireEvent.press(screen.getByLabelText('Saved researched candidates (1)'));
  await fireEvent.press(screen.getByLabelText('Current auction vehicle'));
  expect(screen.getByText('1000 · currency unavailable')).toBeTruthy();
});

it('uses photo-derived vehicle fields without duplicate legacy controls or writable AI evidence', async () => {
  const changed = jest.fn();
  const vehicleDetails: NonNullable<SalvageAssessmentV2['vehicleDetails']> = {
    schemaVersion: 1, category: null, warnings: [], fields: [
      { key: 'engineModel', label: 'Engine model', value: null, status: 'unknown', evidence: [], type: 'text', options: [], required: false, source: 'standard', manualOverride: null },
    ],
  };
  await render(<SalvageAssessmentEditor assessment={{ ...assessment, vehicleDetails }} inputs={inputs} disabled={false} onChange={changed} />);
  expect(screen.queryByLabelText('Assessment make')).toBeNull();
  expect(screen.queryByLabelText('Odometer unit: km')).toBeNull();
  expect(screen.getByLabelText('Market city or region')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Vehicle Engine model'), 'EcoBoost');
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ vehicleOverrides: { engineModel: 'EcoBoost' }, market: 'Calgary' }));
  expect(changed.mock.calls.at(-1)[0]).not.toHaveProperty('vehicleDetails');
  expect(vehicleDetails.fields[0].value).toBeNull();
});
