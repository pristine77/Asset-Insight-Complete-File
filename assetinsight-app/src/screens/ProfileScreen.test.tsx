import React from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import ProfileScreen from './ProfileScreen';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../services/api', () => ({ __esModule: true, default: { patch: jest.fn(), delete: jest.fn() } }));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('../components/CaptureBackupPanel', () => () => null);
jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({
  colors: new Proxy({}, { get: () => '#222222' }),
}) }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each([false, true])('offers privacy and account-deletion instructions to signed-in users (CRM=%s)', async (isCrmAgent) => {
  const refreshUser = jest.fn();
  jest.mocked(useAuth).mockReturnValue({ user: {
    id: 'fixture-owner', email: 'fixture@example.test', username: 'Fixture', isCrmAgent,
  }, refreshUser } as any);
  await render(<ProfileScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
  expect(Linking.openURL).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));
  await fireEvent.press(screen.getByRole('link', { name: 'Account deletion' }));
  expect(Linking.openURL).toHaveBeenNthCalledWith(1, 'https://assetinsightvaluator.com/privacy');
  expect(Linking.openURL).toHaveBeenNthCalledWith(2, 'https://assetinsightvaluator.com/account-deletion');
  expect(api.patch).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
  expect(refreshUser).not.toHaveBeenCalled();
  expect(screen.getByText('fixture@example.test')).toBeTruthy();
});
