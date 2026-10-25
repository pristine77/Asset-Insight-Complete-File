import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import SalvageReportEnrichment from './SalvageReportEnrichment';
import SalvageReportContextEditor from './SalvageReportContextEditor';
import type {
  SalvageReportContext,
  SalvageReportEnrichment as Enrichment,
} from '../../types/salvageReportEnrichment';

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
    },
  }),
}));

const enrichment: Enrichment = {
  schemaVersion: 1,
  sections: [
    {
      id: 'executive-summary',
      title: 'Synthèse',
      paragraphs: ['Recovery is unknown; storage fees were not provided.'],
      tables: [
        {
          headers: ['Measure', 'Saved value', 'Basis'],
          rows: [['Net recovery', 'Unknown', 'Incomplete deductions']],
        },
      ],
    },
    {
      id: 'photo-findings',
      title: 'Photo findings',
      paragraphs: ['One photo could not be analyzed.'],
      tables: [
        {
          headers: ['Photo', 'Status', 'Observation'],
          rows: [['photo-001', 'not_analyzed', 'Unreadable VIN']],
        },
      ],
    },
    {
      id: 'references',
      title: 'Références',
      paragraphs: [],
      tables: [
        { headers: ['Reference', 'Excerpt'], rows: [['[R1]', 'Original supporting content']] },
      ],
    },
  ],
};

it('shows canonical localized text without calculating unknowns or mounting collapsed evidence tables', async () => {
  await render(<SalvageReportEnrichment enrichment={enrichment} />);
  expect(screen.getByText('Synthèse')).toBeTruthy();
  expect(screen.getByText('Recovery is unknown; storage fees were not provided.')).toBeTruthy();
  expect(screen.getByLabelText('Saved value: Unknown')).toBeTruthy();
  expect(screen.queryByText('Unreadable VIN')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Photo findings' }));
  expect(screen.getByText('One photo could not be analyzed.')).toBeTruthy();
  expect(screen.getByLabelText('Observation: Unreadable VIN')).toBeTruthy();
  expect(screen.queryByText('Recovery is unknown; storage fees were not provided.')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Références' }));
  expect(screen.getByLabelText('Reference: [R1]')).toBeTruthy();
  expect(screen.getByText('Original supporting content')).toBeTruthy();
  expect(screen.getByLabelText('Références, table 1').props.horizontal).toBe(true);
});

it('identifies saved projections as stale during unsaved local edits', async () => {
  await render(<SalvageReportEnrichment enrichment={enrichment} dirty />);
  expect(
    screen.getByText('Unsaved edits are not reflected below. Save to refresh the report review.')
  ).toBeTruthy();
  expect(screen.getByLabelText('Saved value: Unknown')).toBeTruthy();
});

it('keeps legacy reports compatible without fabricating missing enrichment', async () => {
  await render(<SalvageReportEnrichment />);
  expect(screen.queryByText('Saved report review')).toBeNull();
});

function ContextHarness({ changed, disabled = false }: { changed: jest.Mock; disabled?: boolean }) {
  const [context, setContext] = useState<SalvageReportContext>({
    intended_use: 'Existing use',
    market_context: 'Retained context',
  });
  return (
    <SalvageReportContextEditor
      context={context}
      disabled={disabled}
      onChange={(next) => {
        changed(next);
        setContext(next);
      }}
    />
  );
}

it('keeps appraiser notes separate and preserves unedited context while supporting explicit null clears', async () => {
  const changed = jest.fn();
  await render(<ContextHarness changed={changed} />);
  expect(screen.queryByLabelText('Report notes: Intended use')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Appraiser report notes' }));
  expect(
    screen.getByText(/Optional appraiser-authored context, not verified findings/)
  ).toBeTruthy();
  await fireEvent.changeText(
    screen.getByLabelText('Report notes: Intended use'),
    'Auction planning'
  );
  expect(changed).toHaveBeenLastCalledWith({
    intended_use: 'Auction planning',
    market_context: 'Retained context',
  });
  await fireEvent.changeText(screen.getByLabelText('Report notes: Intended use'), '');
  expect(changed).toHaveBeenLastCalledWith({
    intended_use: null,
    market_context: 'Retained context',
  });
  await fireEvent.changeText(
    screen.getByLabelText('Report notes: Reconciliation notes'),
    'First reason\nSecond reason'
  );
  expect(changed).toHaveBeenLastCalledWith({
    intended_use: null,
    market_context: 'Retained context',
    reconciliation_notes: 'First reason\nSecond reason',
  });
  expect(screen.getByLabelText('Report notes: Reconciliation notes').props.maxLength).toBe(6000);
  expect(screen.getByLabelText('Report notes: Repair estimate date').props.maxLength).toBe(10);
  expect(changed.mock.lastCall![0]).not.toHaveProperty('inspection_basis');
  expect(changed.mock.lastCall![0]).not.toHaveProperty('report_enrichment');
});

it('makes context readable but not editable during assigned review or active workflow locks', async () => {
  const changed = jest.fn();
  await render(<ContextHarness changed={changed} disabled />);
  await fireEvent.press(screen.getByRole('button', { name: 'Appraiser report notes' }));
  const input = screen.getByLabelText('Report notes: Intended use');
  expect(input.props.editable).toBe(false);
  await fireEvent.changeText(input, 'Cannot apply');
  expect(changed).not.toHaveBeenCalled();
});
