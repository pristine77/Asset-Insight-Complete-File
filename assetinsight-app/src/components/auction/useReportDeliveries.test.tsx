import React from 'react';
import { AppState, Text, TouchableOpacity, type AppStateStatus } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import useReportDeliveries from './useReportDeliveries';
import auctioneerDeliveryService, { type AuctioneerDeliverySummary } from '../../services/auctioneerDeliveryService';
import { invalidateAuthOperations } from '../../services/authSessionOperation';

jest.mock('../../services/auctioneerDeliveryService', () => ({
  __esModule: true,
  default: { getDeliveries: jest.fn() },
}));

const row = (state = 'ready') => ({
  workItemId: 'work', reportId: 'report', reportModel: 'AssetReport', reportType: 'asset',
  state, canSend: state === 'ready',
}) as AuctioneerDeliverySummary;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function Probe({ owner = 'owner' }: { owner?: string }) {
  const state = useReportDeliveries(owner);
  return <>
    <Text testID="rows">{state.deliveries.map((item) => item.state).join(',')}</Text>
    <Text testID="error">{String(state.error)}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh" onPress={() => void state.refresh()} />
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Receipt" onPress={() => state.updated(row('sent'))} />
  </>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockResolvedValue([row()]);
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it('loads delivery status without any report/media fetch or mutation', async () => {
  await render(<Probe />);
  expect(screen.getByTestId('rows').props.children).toBe('ready');
  expect(auctioneerDeliveryService.getDeliveries).toHaveBeenCalledTimes(1);
});

it('polls only pending transfers, and stops once the server confirms sent', async () => {
  jest.useFakeTimers();
  jest.mocked(auctioneerDeliveryService.getDeliveries)
    .mockResolvedValueOnce([row('queued')]).mockResolvedValue([row('sent')]);
  await render(<Probe />);
  await act(async () => jest.advanceTimersByTime(10_000));
  expect(screen.getByTestId('rows').props.children).toBe('sent');
  await act(async () => jest.advanceTimersByTime(30_000));
  expect(auctioneerDeliveryService.getDeliveries).toHaveBeenCalledTimes(2);
});

it('does not overlap slow polling reads', async () => {
  jest.useFakeTimers();
  const next = deferred<AuctioneerDeliverySummary[]>();
  jest.mocked(auctioneerDeliveryService.getDeliveries)
    .mockResolvedValueOnce([row('sending')]).mockReturnValue(next.promise);
  await render(<Probe />);
  await act(async () => jest.advanceTimersByTime(10_000));
  await act(async () => jest.advanceTimersByTime(40_000));
  expect(auctioneerDeliveryService.getDeliveries).toHaveBeenCalledTimes(2);
  await act(async () => next.resolve([row('sent')]));
});

it('retains confirmed status after failed refresh, then clears the warning on recovery', async () => {
  await render(<Probe />);
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockRejectedValueOnce(new Error('status code 409'));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByTestId('rows').props.children).toBe('ready');
  expect(screen.getByTestId('error').props.children).toBe('true');
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.getByTestId('error').props.children).toBe('false');
});

it('never overwrites a send receipt with a read started before it', async () => {
  await render(<Probe />);
  const next = deferred<AuctioneerDeliverySummary[]>();
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockReturnValueOnce(next.promise);
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Receipt' }));
  await act(async () => next.resolve([row('ready')]));
  expect(screen.getByTestId('rows').props.children).toBe('sent');
});

it('discards a late read and mutation callback after the auth epoch changes', async () => {
  const next = deferred<AuctioneerDeliverySummary[]>();
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockReturnValueOnce(next.promise);
  await render(<Probe />);
  invalidateAuthOperations();
  await act(async () => next.resolve([row()]));
  await fireEvent.press(screen.getByRole('button', { name: 'Receipt' }));
  expect(screen.getByTestId('rows').props.children).toBe('');
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
  expect(auctioneerDeliveryService.getDeliveries).toHaveBeenCalledTimes(1);
});

it('clears rows when the owner changes and ignores the old read', async () => {
  await render(<Probe />);
  const oldRead = deferred<AuctioneerDeliverySummary[]>();
  const newRead = deferred<AuctioneerDeliverySummary[]>();
  jest.mocked(auctioneerDeliveryService.getDeliveries)
    .mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
  await screen.rerender(<Probe owner="other" />);
  expect(screen.getByTestId('rows').props.children).toBe('');
  await act(async () => oldRead.resolve([row('sent')]));
  expect(screen.getByTestId('rows').props.children).toBe('');
  await act(async () => newRead.resolve([]));
});

it('suspends polling in the background and refreshes when returning', async () => {
  jest.useFakeTimers();
  let change!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    change = callback;
    return { remove: jest.fn() };
  });
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockResolvedValue([row('queued')]);
  await render(<Probe />);
  await act(async () => change('background'));
  await act(async () => jest.advanceTimersByTime(30_000));
  expect(auctioneerDeliveryService.getDeliveries).toHaveBeenCalledTimes(1);
  await act(async () => change('active'));
  expect(auctioneerDeliveryService.getDeliveries).toHaveBeenCalledTimes(2);
});

it('does not load without an authenticated owner or apply results after unmount', async () => {
  await render(<Probe owner="" />);
  expect(auctioneerDeliveryService.getDeliveries).not.toHaveBeenCalled();
  const next = deferred<AuctioneerDeliverySummary[]>();
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockReturnValueOnce(next.promise);
  await screen.rerender(<Probe />);
  await screen.unmount();
  await act(async () => next.reject(new Error('offline')));
});
