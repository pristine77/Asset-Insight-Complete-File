import React from 'react';
import { StyleSheet } from 'react-native';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react-native';
import AuctioneerFormHeader from './AuctioneerFormHeader';
import type { AuctioneerWorkItemSetup } from '../../services/auctioneerService';

jest.mock('../../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: {
  surface: '#fff', border: '#ddd', text: '#111',
} }) }));

const setup: AuctioneerWorkItemSetup = {
  workItemId: 'work', cycleKey: 'cycle', clientSubmissionId: 'submission', kind: 'scheduleA', reportType: 'lotListing',
  status: 'claimed', reportId: null, contract: { id: 'contract', contractNo: '03434', customerName: '', eventTitle: '', location: '' }, lots: [],
};

async function mount(overrides: Partial<React.ComponentProps<typeof AuctioneerFormHeader>> = {}) {
  const onPress = jest.fn();
  const onSubmit = jest.fn();
  const view = await render(<AuctioneerFormHeader setup={setup} disabled={false} closeDisabled={false}
    submitting={false} paused={false} onPress={onPress} onSubmit={onSubmit} {...overrides} />);
  return { ...view, onPress, onSubmit };
}

afterEach(cleanup);

it('places the green Continue and red Close actions in one equal-width row', async () => {
  await mount();
  const row = screen.getByTestId('auctioneer-create-actions');
  const buttons = within(row).getAllByRole('button');
  expect(buttons.map(button => button.props.accessibilityLabel)).toEqual(['Create Lot & Continue', 'Create Lot & Close']);
  expect(StyleSheet.flatten(row.props.style)).toMatchObject({ flexDirection: 'row', gap: 8 });
  expect(StyleSheet.flatten(buttons[0].props.style)).toMatchObject({ flex: 1, minWidth: 0, minHeight: 48, backgroundColor: '#15803D' });
  expect(StyleSheet.flatten(buttons[1].props.style)).toMatchObject({ flex: 1, minWidth: 0, minHeight: 48, backgroundColor: '#B91C1C' });
  expect(screen.getByText('Contract 03434 · Schedule A lots are locked')).toBeTruthy();
  expect(screen.queryByText(/Submit this report, then open a new form/)).toBeNull();
});

it('keeps Continue and Close connected to their separate existing actions', async () => {
  const { onPress, onSubmit } = await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Close' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('preserves independent eligibility for both actions', async () => {
  const { onPress, onSubmit } = await mount({ disabled: true });
  const next = screen.getByRole('button', { name: 'Create Lot & Continue' });
  const close = screen.getByRole('button', { name: 'Create Lot & Close' });
  expect(next.props.accessibilityState.disabled).toBe(true);
  expect(close.props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(next);
  await fireEvent.press(close);
  expect(onPress).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('blocks both actions during a submission and exposes its busy state', async () => {
  const { onPress, onSubmit } = await mount({ disabled: true, closeDisabled: true, submitting: true });
  const close = screen.getByRole('button', { name: 'Create Lot & Close' });
  expect(close.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  expect(within(close).getByLabelText('Submitting report')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Create Lot & Continue' }));
  await fireEvent.press(close);
  expect(onPress).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

it('retains the Resume upload action after a paused upload', async () => {
  const { onSubmit } = await mount({ paused: true });
  expect(screen.queryByRole('button', { name: 'Create Lot & Close' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Resume upload' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('allows labels to wrap and grow for narrow screens and larger text', async () => {
  await mount();
  for (const button of within(screen.getByTestId('auctioneer-create-actions')).getAllByRole('button')) {
    const style = StyleSheet.flatten(button.props.style);
    expect(style.height).toBeUndefined();
    expect(style.width).toBeUndefined();
    const label = within(button).getByText(/Create Lot/);
    expect(label.props.numberOfLines).toBeUndefined();
    expect(label.props.allowFontScaling).not.toBe(false);
    expect(StyleSheet.flatten(label.props.style)).toMatchObject({ color: '#fff', textAlign: 'center' });
  }
});
