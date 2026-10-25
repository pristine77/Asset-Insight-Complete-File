import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import LotManager from './LotManager';
import type { MixedLot } from '../camera/types';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('./LotImageEditor', () => ({ __esModule: true, default: () => null }));
jest.mock('../../services/imageEditService', () => ({ ImageEditService: {} }));
jest.mock('./CameraCapture', () => ({}));

const video = { uri: 'content://media/external/video/media/720', name: 'long-camera-video-name.mp4', type: 'video/mp4', size: 8_000_000 };
const initial: MixedLot[] = [{ id: 'stable-lot', lotNumber: '157A', files: [], extraFiles: [], coverIndex: 0, mode: 'single_lot', videoFile: video }];
function Harness() {
  const [lots, setLots] = useState(initial);
  const [active, setActive] = useState(0);
  return <><LotManager lots={lots} setLots={setLots} activeLotIdx={active} setActiveLotIdx={setActive} onOpenCamera={() => {}} onCreateLot={() => 0} />
    <Text testID="saved-lots">{JSON.stringify(lots)}</Text></>;
}
afterEach(() => jest.restoreAllMocks());

it('shows a separate accessible video attachment without increasing the image count', async () => {
  await render(<Harness />);
  expect(screen.getByText('0 images • 1 video • Bundle')).toBeTruthy();
  expect(screen.getByText(video.name)).toBeTruthy();
  expect(screen.getByText(/Included in media ZIP/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Remove video from Lot 157A' })).toBeTruthy();
});

it('requires confirmation and removes only the draft reference, retaining its lot and original', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await render(<Harness />);
  await fireEvent.press(screen.getByRole('button', { name: 'Remove video from Lot 157A' }));
  expect(JSON.parse(screen.getByTestId('saved-lots').props.children)[0].videoFile.uri).toBe(video.uri);
  expect(alert).toHaveBeenCalledWith('Remove video?', expect.stringContaining('original stays on this device'), expect.any(Array));
  const remove = alert.mock.calls[0][2]!.find(button => button.text === 'Remove')!;
  await act(async () => { remove.onPress?.(); });
  const saved = JSON.parse(screen.getByTestId('saved-lots').props.children);
  expect(saved).toEqual([{ ...initial[0], videoFile: undefined }]);
  expect(video.uri).toBe('content://media/external/video/media/720');
  expect(screen.queryByRole('button', { name: 'Remove video from Lot 157A' })).toBeNull();
});
