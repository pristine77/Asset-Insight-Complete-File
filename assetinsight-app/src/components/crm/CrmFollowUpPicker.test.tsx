/**
 * The follow-up date control in CRM Task Update (2026-10-11): pick a date, an
 * optional time, remove the time, or clear the follow-up.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import CrmFollowUpPicker from './CrmFollowUpPicker';
import type { FollowUpDraft } from '../../services/crmFollowUp';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('expo-localization', () => ({ getCalendars: () => [{ timeZone: 'America/Regina' }] }));
// The system picker: a press picks Oct 20 (date) or 3:30 PM (time); a long
// press is the person closing it without picking.
jest.mock('@react-native-community/datetimepicker', () => {
  const { createElement } = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ testID, mode, onChange }: any) =>
      createElement(Text, {
        testID,
        accessibilityRole: 'button',
        onPress: () => onChange({ type: 'set' }, mode === 'time' ? new Date(2099, 9, 20, 15, 30) : new Date(2099, 9, 20)),
        onLongPress: () => onChange({ type: 'dismissed' }, undefined),
      }, `${mode} picker`),
  };
});

function Harness({ initial, onChange }: { initial: FollowUpDraft; onChange?: (next: FollowUpDraft) => void }) {
  const [value, setValue] = useState(initial);
  return <CrmFollowUpPicker value={value} onChange={(next) => { setValue(next); onChange?.(next); }} />;
}

it('picks a date, adds and removes a time, and clears', async () => {
  const changes: FollowUpDraft[] = [];
  await render(<Harness initial={{ date: null, time: null }} onChange={(next) => changes.push(next)} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Pick a follow-up date' }));
  await fireEvent.press(screen.getByTestId('crm-follow-up-date-picker'));
  expect(changes.at(-1)).toEqual({ date: '2099-10-20', time: null });
  expect(screen.getByRole('button', { name: /^Follow-up date: .*Oct 20.*Change$/ })).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Add a follow-up time' }));
  await fireEvent.press(screen.getByTestId('crm-follow-up-time-picker'));
  expect(changes.at(-1)).toEqual({ date: '2099-10-20', time: '15:30' });

  await fireEvent.press(screen.getByRole('button', { name: 'Remove the follow-up time' }));
  expect(changes.at(-1)).toEqual({ date: '2099-10-20', time: null });

  await fireEvent.press(screen.getByRole('button', { name: 'Clear the follow-up date' }));
  expect(changes.at(-1)).toEqual({ date: null, time: null });
  expect(screen.getByRole('button', { name: 'Pick a follow-up date' })).toBeTruthy();
});

it('changes nothing when the picker is closed without picking', async () => {
  const onChange = jest.fn();
  await render(<CrmFollowUpPicker value={{ date: null, time: null }} onChange={onChange} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Pick a follow-up date' }));
  await fireEvent(screen.getByTestId('crm-follow-up-date-picker'), 'longPress');
  expect(onChange).not.toHaveBeenCalled();
});

it('is read-only while the update is being sent', async () => {
  const onChange = jest.fn();
  await render(<CrmFollowUpPicker value={{ date: '2099-10-20', time: null }} onChange={onChange} disabled />);
  await fireEvent.press(screen.getByRole('button', { name: 'Clear the follow-up date' }));
  expect(onChange).not.toHaveBeenCalled();
});
