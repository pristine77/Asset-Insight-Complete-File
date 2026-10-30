import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import NetInfo from '@react-native-community/netinfo';
import ProposalListPanel, { useProposalList } from './ProposalListPanel';
import { proposalItemLot } from './proposalListPolicy';
import type { MixedLot } from '../camera/types';
import auctioneerService, { type AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import { invalidateAuthOperations } from '../../services/authSessionOperation';

let mockOwner: string | null = 'owner';
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn() } }));
jest.mock('../../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => mockOwner } }));
jest.mock('../../services/auctioneerService', () => ({ __esModule: true, default: { getSetup: jest.fn(), markProposalItemsNotFound: jest.fn() } }));

const setup = (workItemId = 'work-a'): AuctioneerWorkItemSetup => ({
  workItemId, cycleKey: `cycle-${workItemId}`, kind: 'unknown', reportType: 'asset',
  contract: { id: `contract-${workItemId}`, contractNo: workItemId, customerName: 'QA customer', eventTitle: 'QA event', location: 'Regina, Canada' }, lots: [],
  proposalList: { items: [{ lineId: 'L1', sourceKey: 'proposal-line:L1', title: 'Equipment', state: 'outstanding' }] },
});
const returned = (source: AuctioneerWorkItemSetup) => ({
  notFound: ['L1'], remainsInAssetInsight: true,
  setup: { ...source, proposalList: { items: source.proposalList!.items.map(item => ({ ...item, state: 'not_found' as const })) } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Harness({ current, changed, active = true }: { current: AuctioneerWorkItemSetup; changed?: jest.Mock; active?: boolean }) {
  const [lots, setLotsRaw] = useState<MixedLot[]>(() => [proposalItemLot(current.proposalList!.items[0])]);
  useEffect(() => { setLotsRaw([proposalItemLot(current.proposalList!.items[0])]); }, [current]);
  const setLots = useCallback<React.Dispatch<React.SetStateAction<MixedLot[]>>>((update) => {
    setLotsRaw(previous => {
      const next = typeof update === 'function' ? update(previous) : update;
      changed?.(next);
      return next;
    });
  }, [changed]);
  const list = useProposalList({ setup: current, lots, setLots, active });
  return <View><Text testID="lot-count">{lots.length}</Text><ProposalListPanel list={list} /></View>;
}
const confirm = () => jest.mocked(Alert.alert).mock.calls.at(-1)![2]!.find(button => button.text === 'Return as not found')!.onPress!;
async function beginNotFound() {
  await fireEvent.press(screen.getByRole('button', { name: 'Not found: Equipment' }));
  await act(async () => { confirm()(); });
}
beforeEach(() => {
  jest.clearAllMocks(); mockOwner = 'owner'; invalidateAuthOperations();
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: true } as any);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(async () => { await cleanup(); jest.restoreAllMocks(); });

it('keeps normal confirmed not-found removal working', async () => {
  const current = setup();
  jest.mocked(auctioneerService.markProposalItemsNotFound).mockResolvedValue(returned(current));
  await render(<Harness current={current} />);
  await beginNotFound();
  await waitFor(() => expect(screen.getByTestId('lot-count').props.children).toBe(0));
  expect(screen.getByText('Equipment was returned as not found.')).toBeTruthy();
});

it('does not apply a late receipt to another work item using the same source key', async () => {
  const current = setup(), pending = deferred<ReturnType<typeof returned>>();
  jest.mocked(auctioneerService.markProposalItemsNotFound).mockReturnValue(pending.promise);
  const tree = await render(<Harness current={current} />);
  await beginNotFound();
  await waitFor(() => expect(auctioneerService.markProposalItemsNotFound).toHaveBeenCalledTimes(1));
  await tree.rerender(<Harness current={setup('work-b')} />);
  await act(async () => { pending.resolve(returned(current)); });
  expect(screen.getByTestId('lot-count').props.children).toBe(1);
  expect(screen.queryByText(/was returned as not found/)).toBeNull();
});

it('fences A-to-B-to-A setup changes even when the original setup object returns', async () => {
  const current = setup(), pending = deferred<ReturnType<typeof returned>>();
  jest.mocked(auctioneerService.markProposalItemsNotFound).mockReturnValue(pending.promise);
  const tree = await render(<Harness current={current} />);
  await beginNotFound();
  await waitFor(() => expect(auctioneerService.markProposalItemsNotFound).toHaveBeenCalledTimes(1));
  await tree.rerender(<Harness current={setup('work-b')} />);
  await tree.rerender(<Harness current={current} />);
  await act(async () => { pending.resolve(returned(current)); });
  expect(screen.getByTestId('lot-count').props.children).toBe(1);
});

it('ignores an old-account receipt after switching away and back', async () => {
  const current = setup(), pending = deferred<ReturnType<typeof returned>>();
  jest.mocked(auctioneerService.markProposalItemsNotFound).mockReturnValue(pending.promise);
  await render(<Harness current={current} />);
  await beginNotFound();
  await waitFor(() => expect(auctioneerService.markProposalItemsNotFound).toHaveBeenCalledTimes(1));
  mockOwner = null; invalidateAuthOperations();
  mockOwner = 'owner'; invalidateAuthOperations();
  await act(async () => { pending.resolve(returned(current)); });
  expect(screen.getByTestId('lot-count').props.children).toBe(1);
});

it('ignores a receipt from a form that was closed and reopened', async () => {
  const current = setup(), pending = deferred<ReturnType<typeof returned>>();
  jest.mocked(auctioneerService.markProposalItemsNotFound).mockReturnValue(pending.promise);
  const tree = await render(<Harness current={current} />);
  await beginNotFound();
  await waitFor(() => expect(auctioneerService.markProposalItemsNotFound).toHaveBeenCalledTimes(1));
  await tree.rerender(<Harness current={current} active={false} />);
  await tree.rerender(<Harness current={current} active />);
  await act(async () => { pending.resolve(returned(current)); });
  expect(screen.getByTestId('lot-count').props.children).toBe(1);
});

it('does not send a confirmation retained from another work item', async () => {
  const current = setup();
  const tree = await render(<Harness current={current} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Not found: Equipment' }));
  const oldConfirm = confirm();
  await tree.rerender(<Harness current={setup('work-b')} />);
  await act(async () => { oldConfirm(); });
  expect(auctioneerService.markProposalItemsNotFound).not.toHaveBeenCalled();
  expect(screen.getByTestId('lot-count').props.children).toBe(1);
});

it('does not send after the connectivity check outlives its work item', async () => {
  const current = setup(), network = deferred<any>();
  jest.mocked(NetInfo.fetch).mockReturnValue(network.promise);
  const tree = await render(<Harness current={current} />);
  await beginNotFound();
  await tree.rerender(<Harness current={setup('work-b')} />);
  await act(async () => { network.resolve({ isConnected: true }); });
  expect(auctioneerService.markProposalItemsNotFound).not.toHaveBeenCalled();
  expect(screen.getByTestId('lot-count').props.children).toBe(1);
});

it('keeps the current operation locked when an older operation settles', async () => {
  const current = setup(), next = setup('work-b');
  const first = deferred<ReturnType<typeof returned>>(), second = deferred<ReturnType<typeof returned>>();
  jest.mocked(auctioneerService.markProposalItemsNotFound).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const tree = await render(<Harness current={current} />);
  await beginNotFound();
  await waitFor(() => expect(auctioneerService.markProposalItemsNotFound).toHaveBeenCalledTimes(1));
  await tree.rerender(<Harness current={next} />);
  await beginNotFound();
  await waitFor(() => expect(auctioneerService.markProposalItemsNotFound).toHaveBeenCalledTimes(2));
  await act(async () => { first.resolve(returned(current)); });
  expect(screen.getByRole('button', { name: 'Not found: Equipment' }).props.accessibilityState.disabled).toBe(true);
  await act(async () => { second.resolve(returned(next)); });
  expect(screen.getByTestId('lot-count').props.children).toBe(0);
});

it('does not update a new setup from an older refresh', async () => {
  const current = setup(), pending = deferred<AuctioneerWorkItemSetup>();
  jest.mocked(auctioneerService.getSetup).mockReturnValue(pending.promise);
  const tree = await render(<Harness current={current} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh Proposal items' }));
  await tree.rerender(<Harness current={setup('work-b')} />);
  await tree.rerender(<Harness current={current} />);
  await act(async () => { pending.resolve(returned(current).setup); });
  expect(screen.getByRole('button', { name: 'Not found: Equipment' })).toBeTruthy();
});

it('does not invoke form mutations after unmount', async () => {
  const current = setup(), pending = deferred<ReturnType<typeof returned>>(), changed = jest.fn();
  jest.mocked(auctioneerService.markProposalItemsNotFound).mockReturnValue(pending.promise);
  const tree = await render(<Harness current={current} changed={changed} />);
  await beginNotFound();
  await waitFor(() => expect(auctioneerService.markProposalItemsNotFound).toHaveBeenCalledTimes(1));
  await tree.unmount(); changed.mockClear();
  await act(async () => { pending.resolve(returned(current)); });
  expect(changed).not.toHaveBeenCalled();
});
