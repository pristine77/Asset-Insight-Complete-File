import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import LotManager from './LotManager';
import type { MixedLot } from '../camera/types';

/*
 * Arrival Photos on the phone (owner, 2026-11-04, as on the website): "no
 * need to create more lot. Just A camera option needed", then "Show the three
 * options". The form's one lot is the section: its three mode options, a
 * Camera button that waits for a mode, and the photos taken with Remove only.
 */
jest.mock('@expo/vector-icons', () => ({
  Feather: ({ name }: { name: string }) =>
    require('react').createElement(require('react-native').Text, null, `icon:${name}`),
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('./LotImageEditor', () => ({ __esModule: true, default: () => null }));
jest.mock('../../services/imageEditService', () => ({
  ImageEditService: { deleteEditedImage: async () => undefined },
}));
jest.mock('./CameraCapture', () => ({}));

const photo = (name: string) => ({ uri: `file:///${name}`, name, type: 'image/jpeg' }) as any;
function Harness({
  initial,
  onOpenCamera = () => {},
}: {
  initial: MixedLot[];
  onOpenCamera?: (idx: number) => void;
}) {
  const [lots, setLots] = useState(initial);
  const [active, setActive] = useState(0);
  return (
    <>
      <LotManager
        lots={lots}
        setLots={setLots}
        activeLotIdx={active}
        setActiveLotIdx={setActive}
        onOpenCamera={onOpenCamera}
        onCreateLot={() => 0}
        photosOnly
        embedded
        hideSummary
      />
      <Text testID="saved-lots">
        {JSON.stringify(lots.map((lot) => [lot.mode ?? null, lot.files.length]))}
      </Text>
    </>
  );
}
const saved = () => JSON.parse(screen.getByTestId('saved-lots').props.children);

it('offers no lots to create: the three options, and a Camera that waits for one', async () => {
  const openCamera = jest.fn();
  await render(
    <Harness
      initial={[{ id: 'arrival', files: [], extraFiles: [], coverIndex: 0 }]}
      onOpenCamera={openCamera}
    />
  );
  expect(screen.getByTestId('arrival-camera-panel')).toBeTruthy();
  expect(screen.queryByText('Add Lot')).toBeNull();
  expect(screen.queryByText('Create First Lot')).toBeNull();
  expect(screen.queryByText('Gallery')).toBeNull();
  for (const option of ['Bundle', 'Per Item', 'Per Photo'])
    expect(screen.getByText(option)).toBeTruthy();
  expect(screen.getByText('Select a mode to enable the camera.')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('arrival-camera-button'));
  expect(openCamera).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByText('Bundle'));
  expect(saved()).toEqual([['single_lot', 0]]);
  await fireEvent.press(screen.getByTestId('arrival-camera-button'));
  expect(openCamera).toHaveBeenCalledWith(0);
});

it('shows the photos taken with Remove only: no cover star', async () => {
  await render(
    <Harness
      initial={[
        {
          id: 'arrival',
          mode: 'per_item',
          files: [photo('a.jpg'), photo('b.jpg')],
          extraFiles: [photo('c.jpg')],
          coverIndex: 0,
        },
      ]}
    />
  );
  expect(screen.getByText('3 photos taken')).toBeTruthy();
  expect(screen.getByText(/\+ 1 extra photo from the camera/)).toBeTruthy();
  expect(screen.queryByText('icon:star')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Remove arrival photo 2'));
  expect(saved()).toEqual([['per_item', 1]]);
});

it('keeps the ordinary list while an older capture holds more than one lot', async () => {
  await render(
    <Harness
      initial={[
        { id: 'one', mode: 'single_lot', files: [photo('a.jpg')], extraFiles: [], coverIndex: 0 },
        { id: 'two', mode: 'single_lot', files: [photo('b.jpg')], extraFiles: [], coverIndex: 0 },
      ]}
    />
  );
  expect(screen.queryByTestId('arrival-camera-panel')).toBeNull();
  expect(screen.getByText('Image Lots')).toBeTruthy();
});


it('shows a legacy video as excluded and removes only the attachment after confirmation', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<Harness initial={[{id:'arrival',mode:'single_lot',files:[photo('a.jpg')],extraFiles:[],coverIndex:0,
    videoFile:{uri:'file:///saved.mp4',name:'saved.mp4',type:'video/mp4'} as any}]} />);
  expect(screen.getByText('saved.mp4')).toBeTruthy();
  expect(screen.getByText(/Video is kept on this device/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Remove video from Arrival capture'));
  await fireEvent.press(screen.getByText('Bundle'));
  await require('@testing-library/react-native').act(async () => { alert.mock.calls[0][2]?.find(button => button.text === 'Remove')?.onPress?.(); });
  expect(screen.queryByText('saved.mp4')).toBeNull();
  expect(saved()).toEqual([['single_lot',1]]);
  alert.mockRestore();
});
