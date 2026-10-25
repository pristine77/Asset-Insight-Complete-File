import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import CrmDashboardScreen from './CrmDashboardScreen';
import crmTaskApi, { CRM_SPECIALIZATION_OPTIONS } from '../services/crmService';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: jest.requireActual('react-native').View }));
jest.mock('@react-native-community/datetimepicker', () => () => null);
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { username: 'Test agent' } }) }));
jest.mock('../context/NotificationContext', () => ({ useNotifications: () => ({ notifications: [], unreadCount: 0, totalCount: 0 }) }));
jest.mock('../components/NotificationCenterModal', () => () => null);
jest.mock('../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../services/crmService', () => ({
  ...jest.requireActual('../services/crmService'),
  __esModule: true,
  default: { getMyTasks: jest.fn(), quickAddLead: jest.fn() },
}));
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(crmTaskApi.getMyTasks).mockResolvedValue({ items: [], total: 0 } as any);
});
afterEach(() => jest.restoreAllMocks());

it('keeps Quick Add fields and actions inside the reachable scroll and preserves Notes through edits', async () => {
  await render(<CrmDashboardScreen onOpenDrawer={jest.fn()} onOpenTasks={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Quick Add lead' }));
  expect(screen.getByLabelText('Quick Add lead form').props.keyboardShouldPersistTaps).toBe('handled');
  const notesBefore = screen.getByLabelText('Lead notes');
  await fireEvent.changeText(notesBefore, 'One detail\nSecond detail\nThird detail');
  await fireEvent.changeText(screen.getByLabelText('Lead name'), 'Example Lead');
  await fireEvent.changeText(screen.getByLabelText('Lead phone number'), '555-0100');
  expect(screen.getByLabelText('Lead notes')).toBe(notesBefore);
  expect(screen.getByLabelText('Lead notes').props.value).toBe('One detail\nSecond detail\nThird detail');
  expect(screen.getByRole('button', { name: 'Create lead' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel Quick Add' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel Quick Add' }));
  expect(crmTaskApi.quickAddLead).not.toHaveBeenCalled();
});

it('preserves existing validation and payload while preventing edits/close during submission', async () => {
  let resolveRequest!: (value: any) => void;
  jest.mocked(crmTaskApi.quickAddLead).mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));
  await render(<CrmDashboardScreen onOpenDrawer={jest.fn()} onOpenTasks={jest.fn()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Quick Add lead' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Create lead' }));
  expect(crmTaskApi.quickAddLead).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('Lead name'), 'Example Lead');
  await fireEvent.changeText(screen.getByLabelText('Lead phone number'), '555-0100');
  await fireEvent.changeText(screen.getByLabelText('Lead notes'), 'One\nTwo');
  const selected = CRM_SPECIALIZATION_OPTIONS[0];
  await fireEvent.press(screen.getByRole('radio', { name: selected.label }));
  await fireEvent.press(screen.getByRole('button', { name: 'Create lead' }));
  expect(crmTaskApi.quickAddLead).toHaveBeenCalledWith(expect.objectContaining({ name: 'Example Lead', phone: '555-0100', notes: 'One\nTwo', specialization: selected.value }));
  expect(screen.getByRole('button', { name: 'Create lead' }).props.accessibilityState).toEqual(expect.objectContaining({ busy: true, disabled: true }));
  expect(screen.getByLabelText('Lead notes').props.editable).toBe(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Close Quick Add' }));
  expect(screen.getByLabelText('Lead notes')).toBeTruthy();
  await act(async () => { resolveRequest({}); });
  expect(crmTaskApi.quickAddLead).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Lead notes')).toBeNull();
});
