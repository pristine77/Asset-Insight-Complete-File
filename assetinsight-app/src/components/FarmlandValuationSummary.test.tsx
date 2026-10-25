import React from 'react';
import { render, screen } from '@testing-library/react-native';
import FarmlandValuationSummary from './FarmlandValuationSummary';

it('renders the saved agricultural calculation and actual selected methods as readonly text', async () => {
  await render(<FarmlandValuationSummary preview={{ fair_market_value: 'CAD 200', farmland_valuation: { fair_market_value_formatted: 'CA$120,000', approaches_used: { direct_comparable: true, income_capitalization: false, cost_approach: true } } }} />);
  expect(screen.getByText('CA$120,000')).toBeTruthy();
  expect(screen.getByText('Saved methods: Direct comparable · Cost approach')).toBeTruthy();
  expect(screen.getByText(/Editing preview fields does not recalculate/)).toBeTruthy();
  expect(screen.queryByText('CAD 200')).toBeNull();
});

it('uses the top-level fallback and preserves a calculated zero', async () => {
  await render(<FarmlandValuationSummary preview={{ fair_market_value: 0 }} />);
  expect(screen.getByText(new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(0))).toBeTruthy();
  expect(screen.getByText('Saved methods: Not recorded')).toBeTruthy();
});

it('does not manufacture a value or applied methods when the saved estimate is absent', async () => {
  await render(<FarmlandValuationSummary preview={{}} />);
  expect(screen.getByText('Not available')).toBeTruthy();
});
