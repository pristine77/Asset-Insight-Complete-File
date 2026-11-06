import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import LotManager from './LotManager';
import type { MixedLot } from '../camera/types';
import { invalidateAuthOperations } from '../../services/authSessionOperation';

/*
 * Arrival Photos on the phone (owner, 2026-11-04, as on the website): "no
 * need to create more lot. Just A camera option needed", then "Show the three
 * options". The form's one lot is the section: its three mode options, a
 * Camera button that waits for a mode, and the photos taken with Remove only.
 * Manual Upload photos uses that same capture without introducing a New Lot step.
 */
jest.mock('@expo/vector-icons', () => ({
  Feather: ({ name }: { name: string }) =>
    require('react').createElement(require('react-native').Text, null, `icon:${name}`),
}));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn(), MediaTypeOptions: { Images: 'Images' } }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('./LotImageEditor', () => ({ __esModule: true, default: () => null }));
jest.mock('../../services/imageEditService', () => ({
  ImageEditService: { deleteEditedImage: async () => undefined },
}));
jest.mock('./CameraCapture', () => ({}));

const photo = (name: string) => ({ uri: `file:///${name}`, name, type: 'image/jpeg' }) as any;
type Controls = { setLots?: React.Dispatch<React.SetStateAction<MixedLot[]>> };
function Harness({
  initial,
  onOpenCamera = () => {},
  onCreateLot = () => 0,
  contextKey = 'open:arrival-request',
  photosOnly = true,
  busy = false,
  controls,
}: {
  initial: MixedLot[];
  onOpenCamera?: (idx: number) => void;
  onCreateLot?: () => number;
  contextKey?: string;
  photosOnly?: boolean;
  busy?: boolean;
  controls?: Controls;
}) {
  const [lots, setLots] = useState(initial);
  const [active, setActive] = useState(0);
  if (controls) controls.setLots = setLots;
  return (
    <>
      <LotManager
        lots={lots}
        setLots={setLots}
        activeLotIdx={active}
        setActiveLotIdx={setActive}
        onOpenCamera={onOpenCamera}
        onCreateLot={onCreateLot}
        photosOnly={photosOnly}
        photoPickerContextKey={contextKey}
        photoPickerDisabled={busy}
        embedded
        hideSummary
      />
      <Text testID="saved-lots">
        {JSON.stringify(lots.map((lot) => [lot.mode ?? null, lot.files.length]))}
      </Text>
      <Text testID="saved-files">{JSON.stringify(lots)}</Text>
    </>
  );
}
const saved = () => JSON.parse(screen.getByTestId('saved-lots').props.children);
const savedFiles = (): MixedLot[] => JSON.parse(screen.getByTestId('saved-files').props.children);
const picker = jest.mocked(ImagePicker.launchImageLibraryAsync);
const capture = (files = [photo('original.jpg')]): MixedLot => ({
  id: 'arrival', mode: 'single_lot', files, extraFiles: [], coverIndex: 0,
});
const selection = (...names: string[]) => ({ canceled: false as const, assets: names.map(name => ({
  uri: `file:///${name}`, fileName: name, mimeType: 'image/jpeg', width: 800, height: 600,
})) });
let heldPress: Promise<unknown> | undefined;
const pendingPicker = () => {
  let resolve!: (result: ImagePicker.ImagePickerResult) => void;
  picker.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  return async (result: ImagePicker.ImagePickerResult) => {
    await act(async () => { resolve(result); });
    await heldPress;
  };
};
const startPicker = async (label = 'Upload arrival photos') => {
  // fireEvent awaits async handlers; hold the native picker open without awaiting its result.
  heldPress = fireEvent.press(screen.getByLabelText(label));
  await waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
};
beforeEach(() => { picker.mockReset(); heldPress = undefined; });

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
  expect(screen.getByText('Select a mode to enable Camera or Upload photos.')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('arrival-camera-button'));
  await fireEvent.press(screen.getByLabelText('Upload arrival photos'));
  expect(openCamera).not.toHaveBeenCalled();
  expect(picker).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByText('Bundle'));
  expect(saved()).toEqual([['single_lot', 0]]);
  await fireEvent.press(screen.getByTestId('arrival-camera-button'));
  expect(openCamera).toHaveBeenCalledWith(0);
});

it.each(['single_lot', 'per_item', 'per_photo'] as const)('adds multiple gallery photos to the same %s Arrival capture', async mode => {
  const original = { ...capture(), mode, extraFiles: [photo('extra.jpg')] };
  const create = jest.fn(() => 0);
  picker.mockResolvedValueOnce(selection('gallery-a.jpg', 'gallery-b.jpg'));
  await render(<Harness initial={[original]} onCreateLot={create} />);
  await fireEvent.press(screen.getByLabelText('Upload arrival photos'));
  expect(picker).toHaveBeenCalledWith({ mediaTypes: 'Images', allowsMultipleSelection: true, selectionLimit: 58, quality: 1 });
  expect(create).not.toHaveBeenCalled();
  expect(savedFiles()).toHaveLength(1);
  expect(savedFiles()[0]).toMatchObject({ id: original.id, mode, coverIndex: 0, extraFiles: original.extraFiles });
  expect(savedFiles()[0].files.map(file => [file.uri, file.originalUri])).toEqual([
    ['file:///original.jpg', undefined], ['file:///gallery-a.jpg', 'file:///gallery-a.jpg'], ['file:///gallery-b.jpg', 'file:///gallery-b.jpg'],
  ]);
  expect(screen.queryByText('Add Lot')).toBeNull();
});

it('keeps photos after cancel and permits another selection without opening concurrent pickers', async () => {
  const finish = pendingPicker();
  await render(<Harness initial={[capture()]} />);
  await startPicker('Upload arrival photos');
  await fireEvent.press(screen.getByLabelText('Upload arrival photos'));
  expect(picker).toHaveBeenCalledTimes(1);
  await finish({ canceled: true, assets: null });
  expect(savedFiles()[0].files).toEqual(capture().files);
  picker.mockResolvedValueOnce(selection('picked.jpg'));
  await fireEvent.press(screen.getByLabelText('Upload arrival photos'));
  expect(savedFiles()[0].files.map(file => file.name)).toEqual(['original.jpg', 'picked.jpg']);
});

it.each(['removed', 'replaced', 'attachments replaced', 'mode changed'])(
  'ignores a held picker when the target lot is %s', async change => {
    const controls: Controls = {};
    const finish = pendingPicker();
    const original = capture();
    await render(<Harness initial={[original]} controls={controls} />);
    await startPicker('Upload arrival photos');
    const replacement = change === 'removed' ? [] : [{
      ...original,
      ...(change === 'replaced' ? { id: 'different-lot' } : {}),
      ...(change === 'attachments replaced' ? { files: [photo('replacement.jpg')] } : {}),
      ...(change === 'mode changed' ? { mode: 'per_photo' as const } : {}),
    }];
    await act(async () => { controls.setLots!(replacement); });
    await finish(selection('late.jpg'));
    expect(savedFiles()).toEqual(replacement);
  }
);

it('keeps a delayed selection with its original lot after an older multi-lot Arrival capture is reordered', async () => {
  const controls: Controls = {};
  const finish = pendingPicker();
  const first = capture();
  const second = { ...capture([photo('second.jpg')]), id: 'second' };
  await render(<Harness initial={[first, second]} controls={controls} />);
  await startPicker('Upload arrival photos to Lot 1');
  await act(async () => { controls.setLots!([second, first]); });
  await finish(selection('picked.jpg'));
  expect(savedFiles().map(lot => [lot.id, lot.files.map(file => file.name)])).toEqual([
    ['second', ['second.jpg']], ['arrival', ['original.jpg', 'picked.jpg']],
  ]);
});

it.each(['request switched', 'request switched back', 'closed and reopened'])(
  'rejects an old picker after the Arrival context is %s', async change => {
    const finish = pendingPicker();
    const initial = [capture()];
    const view = await render(<Harness initial={initial} contextKey="open:request-a" />);
    await startPicker('Upload arrival photos');
    await view.rerender(<Harness initial={initial} contextKey={change === 'closed and reopened' ? 'closed:request-a' : 'open:request-b'} />);
    if (change !== 'request switched') await view.rerender(<Harness initial={initial} contextKey="open:request-a" />);
    await finish(selection('late.jpg'));
    expect(savedFiles()).toEqual(initial);
  }
);

it('ignores a selection after account invalidation', async () => {
  const finish = pendingPicker();
  await render(<Harness initial={[capture()]} />);
  await startPicker('Upload arrival photos');
  invalidateAuthOperations();
  await finish(selection('other-account.jpg'));
  expect(savedFiles()).toEqual([capture()]);
});

it('does not add held selections during or after a send/save and blocks a new picker while busy', async () => {
  const finish = pendingPicker();
  const initial = [capture()];
  const view = await render(<Harness initial={initial} />);
  await startPicker('Upload arrival photos');
  await view.rerender(<Harness initial={initial} busy />);
  await fireEvent.press(screen.getByLabelText('Upload arrival photos'));
  expect(picker).toHaveBeenCalledTimes(1);
  await view.rerender(<Harness initial={initial} />);
  await finish(selection('after-send.jpg'));
  expect(savedFiles()).toEqual(initial);
});

it('never calls the form setter after unmount', async () => {
  const finish = pendingPicker();
  const setLots = jest.fn();
  const view = await render(<LotManager lots={[capture()]} setLots={setLots} activeLotIdx={0}
    setActiveLotIdx={jest.fn()} onOpenCamera={jest.fn()} onCreateLot={() => 0} photosOnly embedded />);
  await startPicker('Upload arrival photos');
  await view.unmount();
  await finish(selection('late.jpg'));
  expect(setLots).not.toHaveBeenCalled();
});

it('rechecks the 60-photo Arrival limit across all lots and extra photos after camera additions', async () => {
  const controls: Controls = {};
  const finish = pendingPicker();
  const first = capture(Array.from({ length: 28 }, (_, i) => photo(`first-${i}.jpg`)));
  const second = { ...capture(Array.from({ length: 29 }, (_, i) => photo(`second-${i}.jpg`))), id: 'second', extraFiles: [photo('extra.jpg')] };
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<Harness initial={[first, second]} controls={controls} />);
  await startPicker('Upload arrival photos to Lot 1');
  expect(picker.mock.calls[0][0]?.selectionLimit).toBe(2);
  await act(async () => { controls.setLots!([first, { ...second, files: [...second.files, photo('camera.jpg')] }]); });
  await finish(selection('one.jpg', 'two.jpg'));
  expect(savedFiles().reduce((sum, lot) => sum + lot.files.length + lot.extraFiles.length, 0)).toBe(60);
  expect(savedFiles()[0].files.at(-1)?.name).toBe('one.jpg');
  expect(savedFiles()[1].files.at(-1)?.name).toBe('camera.jpg');
  expect(alert).toHaveBeenCalledWith('Some Photos Skipped', expect.stringContaining('60 photos'));
  await fireEvent.press(screen.getByLabelText('Upload arrival photos to Lot 1'));
  expect(picker).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});

it('skips oversized selections and known-total overflow while retaining unknown metadata and existing photos', async () => {
  const mib = 1024 * 1024;
  const existing = Array.from({ length: 5 }, (_, i) => ({ ...photo(`existing-${i}.jpg`), size: 20 * mib }));
  const result = selection('too-large.jpg', 'fits.jpg', 'overflow.jpg', 'unknown.jpg');
  result.assets.forEach((asset, index) => Object.assign(asset, { fileSize: [21 * mib, 20 * mib, 1, undefined][index] }));
  picker.mockResolvedValueOnce(result);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<Harness initial={[capture(existing)]} />);
  await fireEvent.press(screen.getByLabelText('Upload arrival photos'));
  expect(savedFiles()[0].files.slice(0, 5)).toEqual(existing);
  expect(savedFiles()[0].files.slice(5).map(file => [file.name, file.size])).toEqual([['fits.jpg', 20 * mib], ['unknown.jpg', undefined]]);
  expect(alert).toHaveBeenCalledWith('Some Photos Skipped', expect.stringContaining('120 MiB total'));
  alert.mockRestore();
});

it('retains the ordinary report Gallery and its 200-photo limit', async () => {
  const existing = Array.from({ length: 199 }, (_, i) => photo(`old-${i}.jpg`));
  picker.mockResolvedValueOnce(selection('last.jpg'));
  await render(<Harness initial={[capture(existing)]} photosOnly={false} />);
  await fireEvent.press(screen.getByLabelText('Gallery for Lot 1'));
  expect(picker.mock.calls[0][0]?.selectionLimit).toBe(1);
  expect(savedFiles()[0].files).toHaveLength(200);
  expect(screen.getByText('Add Lot')).toBeTruthy();
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
