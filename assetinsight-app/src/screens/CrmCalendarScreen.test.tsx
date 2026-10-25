/**
 * CRM Calendar (2026-10-11): follow-ups on their days, the overdue list, month
 * paging over the server's calendar read, opening a lead, and the online-only
 * error state.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import CrmCalendarScreen from './CrmCalendarScreen';
import crmTaskApi, { type CrmTaskItem } from '../services/crmService';
import { localDateString } from '../services/crmFollowUp';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: jest.requireActual('react-native').View }));
jest.mock('expo-localization', () => ({ getCalendars: () => [{ timeZone: 'America/Regina' }] }));
jest.mock('../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../services/crmService', () => ({
  ...jest.requireActual('../services/crmService'),
  __esModule: true,
  default: { getFollowUps: jest.fn() },
}));

const now = new Date();
const today = localDateString(now);
const lead = (extra: Partial<CrmTaskItem>) => ({ _id: 'l', status: 'contacted', ...extra }) as CrmTaskItem;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(crmTaskApi.getFollowUps).mockResolvedValue({
    asOf: now.toISOString(), from: '', to: '', timeZone: 'America/Regina',
    items: [
      lead({ _id: 'visit', clientName: 'Curtis Metz', companyName: 'Metz Farms', followUpDate: today, followUpTime: '15:00' }),
      lead({ _id: 'call', clientName: 'All Day Lead', followUpDate: today }),
    ],
    overdue: [lead({ _id: 'late', clientName: 'Late Lead', followUpDate: '2020-01-02' })],
  });
});

it("shows today's follow-ups, the overdue ones, and opens a lead", async () => {
  const onOpenTask = jest.fn();
  await render(<CrmCalendarScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} onOpenTask={onOpenTask} />);
  expect(await screen.findByText('Curtis Metz')).toBeTruthy();
  expect(screen.getByText('All day')).toBeTruthy();
  expect(screen.getByText('Metz Farms')).toBeTruthy();
  expect(screen.getByText('Overdue follow-ups (1)')).toBeTruthy();
  // The day with two follow-ups says so.
  expect(screen.getByRole('button', { name: /, 2 follow-ups$/ })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /^Curtis Metz, .*Open Task Update$/ }));
  expect(onOpenTask).toHaveBeenCalledWith('visit');

  const [{ from, to, timeZone }] = jest.mocked(crmTaskApi.getFollowUps).mock.calls[0];
  expect(timeZone).toBe('America/Regina');
  expect(from <= today && today <= to).toBe(true);
});

it('reads the next month when paging forward', async () => {
  await render(<CrmCalendarScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} onOpenTask={jest.fn()} />);
  await screen.findByText('Curtis Metz');
  await fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
  expect(crmTaskApi.getFollowUps).toHaveBeenCalledTimes(2);
  const [first, next] = jest.mocked(crmTaskApi.getFollowUps).mock.calls.map(([params]) => params);
  const firstOfNextMonth = localDateString(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  expect(next.from > first.from).toBe(true);
  expect(next.from <= firstOfNextMonth && firstOfNextMonth <= next.to).toBe(true);
});

it('says when the follow-ups cannot be loaded and tries again', async () => {
  jest.mocked(crmTaskApi.getFollowUps).mockRejectedValueOnce(new Error('Network Error'));
  await render(<CrmCalendarScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} onOpenTask={jest.fn()} />);
  expect(await screen.findByText('Could not load your follow-ups. Check the connection and try again.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Curtis Metz')).toBeTruthy();
});
