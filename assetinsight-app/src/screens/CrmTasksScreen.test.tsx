import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import CrmTasksScreen from './CrmTasksScreen';
import CrmOutlookCalendarScreen from './CrmOutlookCalendarScreen';
import crmTaskApi, { type CrmTaskItem } from '../services/crmService';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null, FontAwesome: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
// A press on the picker reports Oct 20, 2099 (date) or 3:30 PM (time).
jest.mock('@react-native-community/datetimepicker', () => {
  const { createElement } = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ testID, mode, onChange }: any) =>
      createElement(Text, {
        testID: testID || 'date-picker',
        onPress: () => onChange({ type: 'set' }, mode === 'time' ? new Date(2099, 9, 20, 15, 30) : new Date(2099, 9, 20)),
      }, `${mode} picker`),
  };
});
jest.mock('expo-localization', () => ({ getCalendars: () => [{ timeZone: 'America/Regina' }] }));
jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-av', () => ({ Audio: {} }));
jest.mock('expo-mail-composer', () => ({}));
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('../context/AuthContext', () => {
  const user = { _id: 'agent-1', username: 'Test agent' };
  return { useAuth: () => ({ user, refreshUser: jest.fn() }) };
});
jest.mock('../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../services/crmService', () => ({
  ...jest.requireActual('../services/crmService'),
  __esModule: true,
  default: {
    getMyTasks: jest.fn(),
    getOutlookCalendarStatus: jest.fn(),
    getMyTransferRequests: jest.fn(),
    listTransferAgents: jest.fn(),
    submitTaskUpdate: jest.fn(),
    requestTaskTransfer: jest.fn(),
    getTask: jest.fn(),
    addTaskToOutlookCalendar: jest.fn(),
    addTasksToOutlookCalendarBulk: jest.fn(),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(crmTaskApi.getMyTasks).mockResolvedValue({
    items: [
      {
        _id: 'task-1',
        clientName: 'Example Client',
        status: 'new_lead',
        email: 'client@example.test',
        updates: [],
      } as unknown as CrmTaskItem,
    ],
    total: 1,
  } as Awaited<ReturnType<typeof crmTaskApi.getMyTasks>>);
  jest
    .mocked(crmTaskApi.getOutlookCalendarStatus)
    .mockResolvedValue({ connected: false, configured: true });
  jest.mocked(crmTaskApi.getMyTransferRequests).mockResolvedValue([]);
  jest
    .mocked(crmTaskApi.listTransferAgents)
    .mockResolvedValue([{ _id: 'agent-2', username: 'Receiving agent' }] as Awaited<
      ReturnType<typeof crmTaskApi.listTransferAgents>
    >);
});

describe('truthful Outlook synchronization', () => {
  it('shows queued bulk calendar work separately from confirmed additions', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.mocked(crmTaskApi.getOutlookCalendarStatus).mockResolvedValue({ connected: true, configured: true });
    jest.mocked(crmTaskApi.addTasksToOutlookCalendarBulk).mockResolvedValue({
      createdCount: 0, failedCount: 0, pendingCount: 1, created: [], failed: [],
      pending: [{ taskId: 'task-1', reason: 'Queued for Outlook.' }],
    });
    await render(<CrmOutlookCalendarScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
    await fireEvent.press(screen.getByText('Pick Tasks to Sync'));
    await fireEvent.press(screen.getByRole('button', { name: 'Sync selected tasks' }));
    expect(alert).toHaveBeenCalledWith('Outlook sync queued', '0 task(s) added to calendar.\n\n1 queued, not yet confirmed by Outlook.');
    alert.mockRestore();
  });
  it.each([
    [{ pending: true, message: 'Queued for Outlook.' }, 'Outlook sync queued', 'Queued for Outlook.'],
    [{ pending: false }, 'Outlook confirmation unavailable', expect.stringContaining('not confirmed')],
    [{ pending: false, eventId: 'confirmed-event' }, 'Added to Outlook', 'Task added to your Outlook calendar.'],
  ])('distinguishes queued, unconfirmed and confirmed responses', async (response, title, message) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.mocked(crmTaskApi.getOutlookCalendarStatus).mockResolvedValue({ connected: true, configured: true });
    jest.mocked(crmTaskApi.addTaskToOutlookCalendar).mockResolvedValue(response);
    await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Add Example Client to calendar' }));
    expect(alert).toHaveBeenCalledWith(title, message);
    if (!('eventId' in response)) expect(alert).not.toHaveBeenCalledWith('Added to Outlook', expect.anything());
    alert.mockRestore();
  });
});

it('keeps task comments stable through status edits and cancel does not submit', async () => {
  await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Update Example Client' }));
  expect(screen.getByLabelText('Task update form').props.keyboardShouldPersistTaps).toBe('handled');
  const comment = screen.getByLabelText('Task comment');
  await fireEvent.changeText(comment, 'First finding\nSecond finding');
  await fireEvent.press(screen.getByRole('radio', { name: 'Task status: Contacted' }));
  expect(screen.getByLabelText('Task comment')).toBe(comment);
  expect(comment.props.value).toBe('First finding\nSecond finding');
  expect(screen.getByRole('button', { name: 'Submit task update' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel task update' }));
  expect(screen.queryByLabelText('Task comment')).toBeNull();
  expect(crmTaskApi.submitTaskUpdate).not.toHaveBeenCalled();
});

it('keeps transfer notes and actions scroll-reachable without changing the request rules', async () => {
  await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Transfer Example Client' }));
  expect(screen.getByLabelText('Transfer task form').props.keyboardShouldPersistTaps).toBe(
    'handled'
  );
  expect(
    screen.getByRole('button', { name: 'Send transfer request' }).props.accessibilityState.disabled
  ).toBe(true);
  await fireEvent.changeText(screen.getByLabelText('Transfer note'), 'First line\nSecond line');
  await fireEvent.press(screen.getByRole('radio', { name: 'Receiving agent' }));
  expect(
    screen.getByRole('button', { name: 'Send transfer request' }).props.accessibilityState.disabled
  ).toBe(false);
  expect(screen.getByLabelText('Transfer note').props.value).toBe('First line\nSecond line');
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel task transfer' }));
  expect(crmTaskApi.requestTaskTransfer).not.toHaveBeenCalled();
});

it('keeps email message identity and multiline content while editing the subject', async () => {
  await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Email Example Client' }));
  expect(screen.getByLabelText('Compose email form').props.keyboardShouldPersistTaps).toBe(
    'handled'
  );
  const message = screen.getByLabelText('Email message');
  await fireEvent.changeText(message, 'Hello\nPlease review the details.');
  await fireEvent.changeText(screen.getByLabelText('Email subject'), 'Review request');
  expect(screen.getByLabelText('Email message')).toBe(message);
  expect(message.props.value).toBe('Hello\nPlease review the details.');
  expect(screen.getByRole('button', { name: 'Send email' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel email' }));
  expect(screen.queryByLabelText('Email message')).toBeNull();
});

/*
 * Follow-up dates in Task Update (owner decision 2026-10-11): the lead's
 * upcoming follow-up is shown and kept unless changed; a picked date goes with
 * the phone's time zone; clearing sends clear; Won and Lost hide the picker.
 */
describe('follow-up dates', () => {
  const withFollowUp = (extra: Partial<CrmTaskItem> = {}) => {
    jest.mocked(crmTaskApi.getMyTasks).mockResolvedValue({
      items: [{
        _id: 'task-1', clientName: 'Curtis Metz', status: 'contacted', updates: [],
        followUpDate: '2099-01-15', followUpTimeZone: 'America/Regina', ...extra,
      } as unknown as CrmTaskItem],
      total: 1,
    } as Awaited<ReturnType<typeof crmTaskApi.getMyTasks>>);
    jest.mocked(crmTaskApi.submitTaskUpdate).mockResolvedValue({ _id: 'task-1', status: 'contacted' } as CrmTaskItem);
  };
  const openUpdate = async () => {
    await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Update Curtis Metz' }));
  };
  const submitted = () => jest.mocked(crmTaskApi.submitTaskUpdate).mock.calls[0][1];

  it('shows the follow-up on the card and keeps it when the update leaves it alone', async () => {
    withFollowUp();
    await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} />);
    expect(screen.getByText(/Follow-up .*Jan 15/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Update Curtis Metz' }));
    expect(screen.getByRole('button', { name: /^Follow-up date: .*Jan 15.*Change$/ })).toBeTruthy();
    expect(screen.getByText(/Reminder at 8 a\.m\. that day\. Automatic reminders are paused/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Task comment'), 'Called, visit still on');
    await fireEvent.press(screen.getByRole('button', { name: 'Submit task update' }));
    expect(submitted()).toMatchObject({ comment: 'Called, visit still on', status: 'contacted', followUp: undefined });
  });

  it('sends a newly picked date and time with the phone zone', async () => {
    withFollowUp({ followUpDate: undefined, followUpTimeZone: undefined });
    await openUpdate();
    expect(screen.getByText('Automatic reminder every 7 days if this status does not change.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Pick a follow-up date' }));
    await fireEvent.press(screen.getByTestId('crm-follow-up-date-picker'));
    await fireEvent.press(screen.getByRole('button', { name: 'Add a follow-up time' }));
    await fireEvent.press(screen.getByTestId('crm-follow-up-time-picker'));
    expect(screen.getByText(/Reminder 1 hour before/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Submit task update' }));
    expect(submitted().followUp).toEqual({ date: '2099-10-20', time: '15:30', timeZone: 'America/Regina' });
  });

  it('sends clear when the follow-up is removed, and hides the picker for Won', async () => {
    withFollowUp();
    await openUpdate();
    await fireEvent.press(screen.getByRole('radio', { name: 'Task status: Won' }));
    expect(screen.queryByTestId('crm-follow-up-picker')).toBeNull();
    await fireEvent.press(screen.getByRole('radio', { name: 'Task status: Contacted' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Clear the follow-up date' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Submit task update' }));
    expect(submitted().followUp).toBe('clear');
  });

  it('opens a lead that is not in the loaded list by fetching it', async () => {
    withFollowUp();
    jest.mocked(crmTaskApi.getTask).mockResolvedValue({ _id: 'far-away', clientName: 'Far Away Lead', status: 'contacted', updates: [] } as unknown as CrmTaskItem);
    const onClearInitialTask = jest.fn();
    await render(<CrmTasksScreen onOpenDrawer={jest.fn()} onBack={jest.fn()} initialTaskId="far-away" onClearInitialTask={onClearInitialTask} />);
    expect(await screen.findByText('Far Away Lead')).toBeTruthy();
    expect(crmTaskApi.getTask).toHaveBeenCalledWith('far-away');
    expect(onClearInitialTask).toHaveBeenCalled();
  });
});
