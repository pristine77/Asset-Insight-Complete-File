import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import SalvageVehicleDetailsEditor from './SalvageVehicleDetailsEditor';
import type { SalvageVehicleDetails } from '../../types/salvageAssessment';

jest.mock('../../context/ThemeContext', () => ({
  useAppTheme: () => ({
    colors: {
      background: '#111',
      surface: '#222',
      text: '#fff',
      textSecondary: '#ccc',
      textMuted: '#aaa',
      border: '#444',
      accent: '#67a4ff',
      warning: '#fdb022',
    },
  }),
}));

const fieldMeta = {
  type: 'text' as const,
  options: [],
  required: false,
  source: 'standard' as const,
  manualOverride: null,
};
const details: SalvageVehicleDetails = {
  schemaVersion: 1,
  category: 'Pickup Trucks',
  warnings: ['VIN readings conflict.'],
  fields: [
    {
      ...fieldMeta,
      type: 'select',
      options: ['Pickup Trucks', 'Utility Vehicles', 'Passenger Vehicles'],
      key: 'category',
      label: 'Vehicle type',
      value: 'Pickup Trucks',
      status: 'observed',
      evidence: [],
    },
    {
      ...fieldMeta,
      key: 'vin',
      label: 'VIN',
      value: null,
      status: 'conflict',
      evidence: [
        {
          photoId: 'photo-002',
          rawValue: 'UNREADABLE',
          value: 'UNREADABLE',
          evidence: 'VIN plate is blurred.',
          accepted: false,
          rejectionReason: 'Unreadable VIN characters',
        },
      ],
    },
    { ...fieldMeta, key: 'year', label: 'Year', value: '2020', status: 'observed', evidence: [] },
    {
      ...fieldMeta,
      key: 'odometer',
      label: 'Odometer',
      value: '0',
      status: 'observed',
      evidence: [],
    },
    {
      ...fieldMeta,
      type: 'select',
      options: ['km', 'mi'],
      key: 'odometerUnit',
      label: 'Odometer unit',
      value: null,
      status: 'unknown',
      evidence: [],
    },
    {
      ...fieldMeta,
      key: 'engineDisplacement',
      label: 'Engine displacement',
      value: '3.5 L',
      status: 'observed',
      evidence: [
        {
          photoId: 'photo-001',
          rawValue: '3.5 L',
          value: '3.5 L',
          evidence: 'Engine label reads 3.5 L.',
          accepted: true,
          rejectionReason: null,
        },
      ],
    },
    {
      ...fieldMeta,
      key: 'spec:Transmission',
      label: 'Transmission',
      value: null,
      status: 'unknown',
      evidence: [],
    },
    {
      ...fieldMeta,
      key: 'spec:No inference',
      label: 'No inference',
      value: 'Untrusted guessed value',
      status: 'unknown',
      evidence: [],
    },
  ],
};

function Harness({
  disabled = false,
  changed = jest.fn(),
  initial = {},
}: {
  disabled?: boolean;
  changed?: jest.Mock;
  initial?: Record<string, string | null>;
}) {
  const [overrides, setOverrides] = useState(initial);
  return (
    <SalvageVehicleDetailsEditor
      details={details}
      overrides={overrides}
      disabled={disabled}
      photos={['https://assetinsight.pro/engine.jpg', 'https://assetinsight.pro/vin.jpg']}
      onChange={(next) => {
        changed(next);
        setOverrides(next);
      }}
    />
  );
}

it('shows observed engine evidence and explicit missing/conflicting values without inventing data', async () => {
  await render(<Harness />);
  expect(screen.getByLabelText('Vehicle Engine displacement').props.value).toBe('3.5 L');
  expect(screen.getByLabelText('Vehicle Odometer').props.value).toBe('0');
  expect(screen.getByLabelText('Vehicle VIN').props.value).toBe('');
  expect(screen.getByLabelText('Vehicle VIN').props.placeholder).toBe('Cannot find from image');
  expect(screen.getByLabelText('Vehicle No inference').props.value).toBe('');
  expect(screen.getByText('Conflicting image readings · review needed')).toBeTruthy();
  expect(screen.getByLabelText('Vehicle Transmission').props.placeholder).toBe(
    'Cannot find from image'
  );
  expect(screen.queryByLabelText('Engine displacement evidence photo 1')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Engine displacement photo evidence'));
  expect(screen.getByLabelText('Engine displacement evidence photo 1').props.source.uri).toBe(
    'https://assetinsight.pro/engine.jpg'
  );
  expect(screen.getByText('Engine label reads 3.5 L.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('VIN photo evidence'));
  expect(screen.getByText('Not accepted: Unreadable VIN characters')).toBeTruthy();
});

it('sends only explicit manual overrides and preserves all other values and original evidence', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} initial={{ 'spec:Existing': 'Retained' }} />);
  await fireEvent.changeText(screen.getByLabelText('Vehicle Transmission'), 'Automatic');
  expect(changed).toHaveBeenLastCalledWith({
    'spec:Existing': 'Retained',
    'spec:Transmission': 'Automatic',
  });
  expect(screen.getByLabelText('Vehicle Transmission').props.accessibilityHint).toBe(
    'User-entered · not photo-verified'
  );
  await fireEvent.changeText(screen.getByLabelText('Vehicle Year'), '');
  expect(changed.mock.calls.at(-1)[0]).toEqual({
    'spec:Existing': 'Retained',
    'spec:Transmission': 'Automatic',
    year: null,
  });
  expect(screen.getByLabelText('Vehicle Year').props.accessibilityHint).toBe('Cleared by user');
  expect(details.fields.find((field) => field.key === 'year')?.value).toBe('2020');
  expect(details.fields.find((field) => field.key === 'spec:Transmission')?.status).toBe('unknown');
});

it('keeps assigned approval review read-only while permitting evidence expansion', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} disabled />);
  expect(screen.getByLabelText('Vehicle VIN').props.editable).toBe(false);
  await fireEvent.changeText(screen.getByLabelText('Vehicle VIN'), 'FORGED');
  expect(changed).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('VIN photo evidence'));
  expect(screen.getByText('VIN plate is blurred.')).toBeTruthy();
});

it('selects only supplied vehicle categories and odometer units, and explicitly clears a selection', async () => {
  const changed = jest.fn();
  await render(<Harness changed={changed} />);
  await fireEvent.press(screen.getByLabelText('Vehicle Vehicle type'));
  expect(screen.getByLabelText('Vehicle type: Utility Vehicles')).toBeTruthy();
  expect(screen.queryByLabelText('Vehicle type: Invented category')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Vehicle type: Utility Vehicles'));
  expect(changed).toHaveBeenLastCalledWith({ category: 'Utility Vehicles' });
  await fireEvent.press(screen.getByLabelText('Vehicle Odometer unit'));
  await fireEvent.press(screen.getByLabelText('Odometer unit: km'));
  expect(changed).toHaveBeenLastCalledWith({ category: 'Utility Vehicles', odometerUnit: 'km' });
  await fireEvent.press(screen.getByLabelText('Vehicle Odometer unit'));
  await fireEvent.press(screen.getByLabelText('Odometer unit: Cannot find from image'));
  expect(changed).toHaveBeenLastCalledWith({ category: 'Utility Vehicles', odometerUnit: null });
});
