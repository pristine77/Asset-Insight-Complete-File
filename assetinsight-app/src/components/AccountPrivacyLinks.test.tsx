import React from 'react';
import { Alert, Linking, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import AccountPrivacyLinks from './AccountPrivacyLinks';
import { useAppTheme } from '../context/ThemeContext';

jest.mock('../context/ThemeContext', () => ({ useAppTheme: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useAppTheme).mockReturnValue({ colors: { accent: '#1557ed', textSecondary: '#555555' } } as any);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('does not open or send anything on render and exposes labelled links with 48px touch targets', async () => {
  await render(<AccountPrivacyLinks />);
  expect(Linking.openURL).not.toHaveBeenCalled();
  for (const name of ['Privacy policy', 'Account deletion']) {
    const link = screen.getByRole('link', { name });
    expect(StyleSheet.flatten(link.props.style).minHeight).toBeGreaterThanOrEqual(48);
    expect(link.props.accessibilityHint).toContain('browser');
  }
});

it.each([
  ['Privacy policy', 'https://assetinsightvaluator.com/privacy'],
  ['Account deletion', 'https://assetinsightvaluator.com/account-deletion'],
])('opens %s only through an explicit press, without account or draft identifiers', async (name, url) => {
  await render(<AccountPrivacyLinks />);
  await fireEvent.press(screen.getByRole('link', { name }));
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  expect(Linking.openURL).toHaveBeenCalledWith(url);
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('shows a useful failure and allows the same link to be retried', async () => {
  jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('Device has no browser handler'));
  await render(<AccountPrivacyLinks />);
  await fireEvent.press(screen.getByRole('link', { name: 'Account deletion' }));
  expect(Alert.alert).toHaveBeenCalledWith(
    'Could not open account deletion',
    'Try again, or open https://assetinsightvaluator.com/account-deletion in your browser. Your account and saved work are unchanged.',
  );
  await fireEvent.press(screen.getByRole('link', { name: 'Account deletion' }));
  expect(Linking.openURL).toHaveBeenCalledTimes(2);
});

it('coalesces repeated presses while the browser is opening', async () => {
  let complete!: () => void;
  jest.mocked(Linking.openURL).mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
  await render(<AccountPrivacyLinks />);
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));
  await fireEvent.press(screen.getByRole('link', { name: 'Account deletion' }));
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  await act(async () => complete());
  await fireEvent.press(screen.getByRole('link', { name: 'Account deletion' }));
  expect(Linking.openURL).toHaveBeenCalledTimes(2);
});

it('uses current dark theme colors without changing destinations', async () => {
  jest.mocked(useAppTheme).mockReturnValue({ colors: { accent: '#a6c8ff', textSecondary: '#cccccc' } } as any);
  await render(<AccountPrivacyLinks />);
  expect(StyleSheet.flatten(screen.getByText('Privacy policy').props.style).color).toBe('#a6c8ff');
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));
  expect(Linking.openURL).toHaveBeenCalledWith('https://assetinsightvaluator.com/privacy');
});
