/**
 * "Choose your workspace" on one page (owner 2026-10-11): the helper lines stay
 * while everything fits and are dropped only when the screen would scroll.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import CrmEntryScreen from './CrmEntryScreen';
import { useAppTheme } from '../context/ThemeContext';

jest.mock('../context/ThemeContext', () => ({ useAppTheme: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));

const HELPER = 'Your selection can be changed later from the side menu.';
const HERO_HELPER = 'Continue to appraisals or manage customer follow-up.';

beforeEach(() => {
  jest.mocked(useAppTheme).mockReturnValue({ isDark: false, toggleTheme: jest.fn(), colors: {} } as any);
});

async function measure(viewport: number, content: number) {
  const scroll = screen.getByTestId('workspace-scroll');
  await act(async () => {
    fireEvent(scroll, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 360, height: viewport } } });
    fireEvent(scroll, 'contentSizeChange', 360, content);
  });
}

it('keeps the helper lines when the page fits', async () => {
  await render(<CrmEntryScreen onSelectListings={jest.fn()} onSelectCrm={jest.fn()} />);
  await measure(700, 700);
  expect(screen.getByText(HELPER)).toBeTruthy();
  expect(screen.getByText(HERO_HELPER)).toBeTruthy();
});

it('drops only the helper lines when the page would scroll; both workspaces stay', async () => {
  const onSelectCrm = jest.fn();
  await render(<CrmEntryScreen onSelectListings={jest.fn()} onSelectCrm={onSelectCrm} />);
  await measure(568, 626);
  expect(screen.queryByText(HELPER)).toBeNull();
  expect(screen.queryByText(HERO_HELPER)).toBeNull();
  expect(screen.getByText('Choose your workspace')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open Listings workspace' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Open CRM workspace' }));
  expect(onSelectCrm).toHaveBeenCalledTimes(1);
});
