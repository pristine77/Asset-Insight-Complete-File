import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import PreviewLotNavigation from './PreviewLotNavigation';

it.each(['top', 'bottom'] as const)('identifies the complete list and exposes accessible %s edge controls', async position => {
  const onJump = jest.fn();
  await render(<PreviewLotNavigation count={142} position={position} onJump={onJump} />);
  expect(screen.getByText(position === 'top' ? 'Showing all 142 lots' : 'End of all 142 lots')).toBeTruthy();
  expect(screen.getByText('All 142 lots are in this list. There are no other pages.')).toBeTruthy();
  const first = screen.getByRole('button', { name: 'Go to first lot' });
  const last = screen.getByRole('button', { name: 'Go to last lot' });
  expect(StyleSheet.flatten(first.props.style).minHeight).toBeGreaterThanOrEqual(44);
  expect(StyleSheet.flatten(last.props.style).minHeight).toBeGreaterThanOrEqual(44);
  expect(StyleSheet.flatten(first.parent?.props.style).flexWrap).toBe('wrap');
  await fireEvent.press(last);
  await fireEvent.press(first);
  expect(onJump.mock.calls).toEqual([['last'], ['first']]);
});

it.each([0, 1])('does not offer a misleading jump for %i lots', async count => {
  await render(<PreviewLotNavigation count={count} position="top" onJump={jest.fn()} />);
  expect(screen.getByText(count === 0 ? 'No lots in this preview' : 'Showing all 1 lot')).toBeTruthy();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
