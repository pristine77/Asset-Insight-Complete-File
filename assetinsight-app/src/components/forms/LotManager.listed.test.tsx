import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import LotManager from './LotManager';
import type { MixedLot } from '../camera/types';

// Icons render their name, so the icon-only delete control can be found.
jest.mock('@expo/vector-icons', () => ({
  Feather: ({ name }: { name: string }) => require('react').createElement(require('react-native').Text, null, `icon:${name}`),
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('./LotImageEditor', () => ({ __esModule: true, default: () => null }));
jest.mock('../../services/imageEditService', () => ({ ImageEditService: {} }));
jest.mock('./CameraCapture', () => ({}));

// owner 2026-10-28: a lot that captures a listed Proposal item stays one Bundle
// lot, shows which item it is, and removing it leaves the item to capture.
const initial: MixedLot[] = [
  { id: 'listed-proposal-line_003aL1', mode: 'single_lot', files: [], extraFiles: [], coverIndex: 0 },
  { id: 'lot-extra', mode: 'single_lot', files: [], extraFiles: [], coverIndex: 0 },
];
function Harness({ listed = [true, false] }: { listed?: boolean[] }) {
  const [lots, setLots] = useState(initial);
  const [active, setActive] = useState(0);
  return <><LotManager lots={lots} setLots={setLots} activeLotIdx={active} setActiveLotIdx={setActive}
    onOpenCamera={() => {}} onCreateLot={() => 0}
    sourceLabels={['Lot 12 · 2019 CAT Forklift', '']} sourceTags={[undefined, 'Not on list']}
    sourceDetails={['S/N CAT-991', undefined]} listedItemLots={listed} />
    <Text testID="saved-lots">{JSON.stringify(lots.map(lot => [lot.id, lot.mode]))}</Text></>;
}
const saved = () => JSON.parse(screen.getByTestId('saved-lots').props.children);
afterEach(() => jest.restoreAllMocks());

it('shows the listed item and its serial, tags the added lot, and locks the listed lot to Bundle', async () => {
  await render(<Harness />);
  expect(screen.getByText('Lot 12 · 2019 CAT Forklift')).toBeTruthy();
  expect(screen.getByText('S/N CAT-991')).toBeTruthy();
  expect(screen.getByText('Not on list')).toBeTruthy();
  expect(screen.getByText('Lot 2')).toBeTruthy();
  expect(screen.getByText('Listed item · one lot, Bundle grouping is locked')).toBeTruthy();
  await fireEvent.press(screen.getByText('Per Item'));
  expect(saved()[0]).toEqual(['listed-proposal-line_003aL1', 'single_lot']);
});

it('says a removed listed item stays to capture', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<Harness />);
  // The first lot's delete control: the press reaches its touchable.
  await fireEvent.press(screen.getAllByText('icon:trash-2')[0]);
  expect(alert).toHaveBeenCalledWith('Delete Lot',
    'Remove Lot 12 · 2019 CAT Forklift from this form? It stays to capture in Auctioneer, and you can add it back from Proposal items.',
    expect.any(Array));
  const remove = alert.mock.calls[0][2]!.find(button => button.text === 'Delete')!;
  await act(async () => { remove.onPress?.(); });
  expect(saved()).toEqual([['lot-extra', 'single_lot']]);
});

it('keeps the mode choice open for lots that are not listed items', async () => {
  await render(<Harness listed={[false, false]} />);
  expect(screen.getByText('Select Mode:')).toBeTruthy();
  await fireEvent.press(screen.getByText('Per Item'));
  expect(saved()[0]).toEqual(['listed-proposal-line_003aL1', 'per_item']);
});
