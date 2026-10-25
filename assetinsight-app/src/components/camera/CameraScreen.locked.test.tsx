import React, { useState } from 'react';
import { Alert, Dimensions, Image, Text, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import CameraScreen from './CameraScreen';
import CaptureButtons from './CaptureButtons';
import { type MixedLot } from './types';
import { stampCameraPhoto } from '../../services/cameraPhotoWatermark';
import * as MediaLibrary from 'expo-media-library';
import api from '../../services/api';
import { OfflineCaptureStore } from '../../services/offlineCaptureStore';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'stable-capture-id' }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/', makeDirectoryAsync: jest.fn(async () => {}), moveAsync: jest.fn(async () => {}) }));
jest.mock('../../services/offlineCaptureStore', () => ({ OfflineCaptureStore: {
  getOwnerId: jest.fn(() => 'owner'),
  savePendingCapture: jest.fn(async () => ({ revision: 1 })),
  acknowledgePendingCapture: jest.fn(async () => true),
} }));

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native', () => {
  const React = require('react');
  const actual = jest.requireActual('react-native');
  const NativeView = actual.View;
  return Object.defineProperty(Object.create(actual), 'TouchableOpacity', {
    value: ({ children, ...props }: any) => <NativeView accessible {...props}>{children}</NativeView>,
  });
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-vision-camera', () => {
  const React = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  const device = { id: 'isolated-camera', minZoom: 1, maxZoom: 3, physicalDevices: [], supportsLowLightBoost: true };
  const photoOutput = { capturePhotoToFile: jest.fn(), supportsDepthDataDelivery: false };
  const videoOutput = { createRecorder: jest.fn(), currentResolution: { width: 1280, height: 720 } };
  const fixture = { photoOutput, videoOutput, selectedFPS: 30, cameraProps: null as any, videoOptions: null as any };
  const requestPermission = jest.fn(async () => true);
  return {
    Camera: React.forwardRef((props: any, _ref: any) => {
      const started = React.useRef(false);
      fixture.cameraProps = props;
      React.useEffect(() => {
        if (started.current) {
          props.onSessionConfigSelected({ selectedFPS: fixture.selectedFPS });
          props.onConfigured();
          props.onStarted();
        }
      }, [props.outputs]);
      return <TouchableOpacity accessibilityRole="button" accessibilityLabel="Start test camera" onPress={() => { started.current = true; props.onSessionConfigSelected({ selectedFPS: fixture.selectedFPS }); props.onConfigured(); props.onStarted(); }}>
        <Text>Test camera</Text>
      </TouchableOpacity>;
    }),
    CommonResolutions: {},
    useCameraDevice: () => device,
    useCameraPermission: () => ({ hasPermission: true, requestPermission }),
    useMicrophonePermission: () => ({ hasPermission: true, requestPermission }),
    usePhotoOutput: () => photoOutput,
    useVideoOutput: (options: any) => { fixture.videoOptions = options; return videoOutput; },
    fixture,
  };
});
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'Light' } }));
jest.mock('expo-media-library', () => ({
  usePermissions: () => [{ granted: true }, jest.fn()],
  saveToLibraryAsync: jest.fn(async () => {}),
}));
jest.mock('expo-screen-orientation', () => ({ lockAsync: jest.fn(), unlockAsync: jest.fn(), OrientationLock: { PORTRAIT_UP: 'portrait' } }));
jest.mock('../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../config/api', () => ({ API_BASE_URL: 'http://localhost:4137/api' }));
jest.mock('../../services/cameraPhotoWatermark', () => ({ stampCameraPhoto: jest.fn() }));
jest.mock('./cameraPhotoWatermarkModule', () => ({
  loadCameraPhotoWatermark: async () => jest.requireMock('../../services/cameraPhotoWatermark'),
}));
jest.mock('./CaptureButtons', () => {
  const React = require('react');
  const Actual = jest.requireActual('./CaptureButtons').default;
  const fixture = { props: null };
  return { __esModule: true, default: (props: any) => { fixture.props = props; return <Actual {...props} />; }, fixture };
});
jest.mock('./LotNavigation', () => {
  const React = require('react');
  const Actual = jest.requireActual('./LotNavigation').default;
  const fixture = { props: null };
  return { __esModule: true, default: (props: any) => { fixture.props = props; return <Actual {...props} />; }, fixture };
});
jest.mock('./FocusBox', () => ({ __esModule: true, default: () => null }));
jest.mock('./PhotoThumbnails', () => ({ __esModule: true, default: () => null }));
jest.mock('./RecordingIndicator', () => ({ __esModule: true, default: () => null }));
jest.mock('./TopControls', () => {
  const React = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  return {
    TopControls: () => null,
    DoneButton: ({ onDone }: any) => <TouchableOpacity accessibilityRole="button" accessibilityLabel="Done" onPress={onDone}><Text>Done</Text></TouchableOpacity>,
  };
});

const sourceLots = (): MixedLot[] => [1, 2].map((number) => ({
  id: `source-lot-${number}`, mode: 'single_lot', files: [], extraFiles: [], coverIndex: 0,
  sourceKey: `upstream-${number}`, sourceLotId: `auction-${number}`,
}));

function Harness({ initialLots = sourceLots(), locked = true, onClose = jest.fn(), onAutoSave = jest.fn(), sourceLabels, manualSubmissionRequired = false, enhanceImages = false, captureContext, visible = true }: {
  initialLots?: MixedLot[]; locked?: boolean; onClose?: () => void; onAutoSave?: (lots?: MixedLot[], index?: number) => void; sourceLabels?: string[];
  manualSubmissionRequired?: boolean; enhanceImages?: boolean; captureContext?: { ownerId: string; draftId: string; sessionId: string }; visible?: boolean;
}) {
  const [lots, setLots] = useState(initialLots);
  const [activeLotIdx, setActiveLotIdx] = useState(0);
  return <View>
    <Text testID="saved-lots">{JSON.stringify(lots)}</Text>
    <Text testID="active-lot">{activeLotIdx}</Text>
    <CameraScreen visible={visible} lots={lots} setLots={setLots} activeLotIdx={activeLotIdx} setActiveLotIdx={setActiveLotIdx}
      onClose={onClose} onAutoSave={onAutoSave} lockedStructure={locked} sourceLabels={sourceLabels}
      manualSubmissionRequired={manualSubmissionRequired} enhanceImages={enhanceImages} captureContext={captureContext} />
  </View>;
}

const savedLots = (): MixedLot[] => JSON.parse(screen.getByTestId('saved-lots').props.children);
const fixture = () => jest.requireMock('react-native-vision-camera').fixture;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, success) => { success(1200, 900); });
  fixture().photoOutput.capturePhotoToFile.mockResolvedValue({ filePath: '/raw-camera.jpg' });
  jest.mocked(stampCameraPhoto).mockResolvedValue('file:///stamped-camera.jpg');
  fixture().selectedFPS = 30;
  fixture().videoOutput.currentResolution = { width: 1280, height: 720 };
});

afterEach(async () => { await cleanup(); jest.restoreAllMocks(); });

it('keeps Offline captures local and waits for the draft transaction before acknowledge, close or navigation', async () => {
  let finish!: () => void;
  const save = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const close = jest.fn();
  const context = { ownerId: 'owner', draftId: 'draft', sessionId: 'session' };
  await render(<Harness manualSubmissionRequired enhanceImages captureContext={context} onAutoSave={save} onClose={close} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(OfflineCaptureStore.savePendingCapture).toHaveBeenCalledWith(context, expect.any(Array));
  expect(OfflineCaptureStore.acknowledgePendingCapture).not.toHaveBeenCalled();
  expect(savedLots()[0].files).toHaveLength(0);
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByTestId('active-lot').props.children).toBe(0);
  await act(async () => { finish(); });
  await waitFor(() => expect(savedLots()[0].files).toHaveLength(1));
  expect(OfflineCaptureStore.acknowledgePendingCapture).toHaveBeenCalledWith(context, 1);
  expect(api.post).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(close).toHaveBeenCalledTimes(1);
});

it('retains the photo and journal after a failed save and retries from Done without capturing or stamping again', async () => {
  const save = jest.fn().mockRejectedValueOnce(new Error('Full disk')).mockResolvedValue(undefined);
  const close = jest.fn();
  await render(<Harness manualSubmissionRequired captureContext={{ ownerId: 'owner', draftId: 'draft', sessionId: 'session' }} onAutoSave={save} onClose={close} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Capture not saved to draft', expect.any(String)));
  expect(savedLots()[0].files).toHaveLength(1);
  expect(OfflineCaptureStore.acknowledgePendingCapture).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(stampCameraPhoto).toHaveBeenCalledTimes(1);
  expect(OfflineCaptureStore.acknowledgePendingCapture).toHaveBeenCalledTimes(1);
});

it('cancels active enhancement and skips queued uploads when Offline is selected', async () => {
  let finishUpload!: (value: unknown) => void;
  jest.mocked(api.post).mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
  const view = await render(<Harness enhanceImages />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  await waitFor(() => expect(savedLots()[0].files).toHaveLength(2));
  await view.rerender(<Harness enhanceImages manualSubmissionRequired />);
  expect(jest.mocked(api.post).mock.calls[0][2]?.signal?.aborted).toBe(true);
  await act(async () => { finishUpload({ data: { data: [{ url: '/photo.jpg' }] } }); });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.get).not.toHaveBeenCalled();
});

it.each([false, true])('shows only the saved Bundle and Extra capture controls (landscape=%s)', async (isLandscape) => {
  const capture = jest.fn();
  await render(<CaptureButtons onCapture={capture} lockedStructure currentMode="single_lot" isLandscape={isLandscape} />);
  expect(screen.queryByRole('button', { name: 'Capture Per Item photo' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Capture Per Photo photo' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture extra Bundle photo' }));
  expect(capture.mock.calls).toEqual([['single_lot', false], ['single_lot', true]]);
});

it('rejects stale mode-change button handlers after locking while ordinary capture remains available', async () => {
  const capture = jest.fn();
  const view = await render(<CaptureButtons onCapture={capture} />);
  const staleModePress = screen.getByRole('button', { name: 'Capture Per Item photo' }).props.onPress;
  const staleExtraPress = screen.getByRole('button', { name: 'Capture extra Per Photo photo' }).props.onPress;
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Per Item photo' }));
  expect(capture).toHaveBeenCalledWith('per_item', false);
  capture.mockClear();
  await view.rerender(<CaptureButtons onCapture={capture} lockedStructure currentMode="single_lot" />);
  await act(async () => { staleModePress(); staleExtraPress(); });
  expect(capture).not.toHaveBeenCalled();
});

it('does not create an empty locked source lot or permit capture without a saved mode', async () => {
  await render(<Harness initialLots={[]} />);
  expect(savedLots()).toEqual([]);
  expect(screen.getByText('No fixed lots available. Return to the imported form.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Capture Bundle photo' })).toBeNull();
  await act(async () => { jest.requireMock('./LotNavigation').fixture.props.onNextLot(); });
  expect(savedLots()).toEqual([]);
});

it.each([false, true])('navigates only existing fixed source lots and guards next-at-end (landscape=%s)', async (landscape) => {
  if (landscape) jest.mocked(Dimensions.get).mockReturnValue({ width: 844, height: 390, scale: 1, fontScale: 1 });
  await render(<Harness />);
  expect(screen.getByText('Fixed imported lots; capture mode is locked.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  expect(screen.getByTestId('active-lot').props.children).toBe(1);
  expect(screen.getByRole('button', { name: 'Next lot' }).props.accessibilityState.disabled).toBe(true);
  await act(async () => { jest.requireMock('./LotNavigation').fixture.props.onNextLot(); });
  expect(savedLots()).toEqual(sourceLots());
  await fireEvent.press(screen.getByRole('button', { name: 'Previous lot' }));
  expect(screen.getByTestId('active-lot').props.children).toBe(0);
});

it('retains normal empty auto-create and next-at-end behavior when not locked', async () => {
  await render(<Harness initialLots={[]} locked={false} />);
  expect(savedLots()).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Per Item photo' }));
  await waitFor(() => expect(savedLots()[0].files).toHaveLength(1));
  expect(savedLots()[0].mode).toBe('per_item');
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  expect(savedLots()).toHaveLength(2);
  expect(screen.getByTestId('active-lot').props.children).toBe(1);
});

it.each([false, true])('shows the imported lot number during navigation without changing IDs (landscape=%s)', async (landscape) => {
  if (landscape) jest.mocked(Dimensions.get).mockReturnValue({ width: 844, height: 390, scale: 1, fontScale: 1 });
  await render(<Harness sourceLabels={['Lot 157', 'Lot 203']} />);
  expect(screen.getByText('Lot 157')).toBeTruthy();
  expect(screen.queryByText('Lot 1')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  expect(screen.getByText('Lot 203')).toBeTruthy();
  expect(savedLots()).toEqual(sourceLots());
});

it('uses the imported label in photo-limit feedback', async () => {
  const lots = sourceLots();
  lots[0].files = Array.from({ length: 200 }, (_, index) => ({ uri: `file:///saved-${index}.jpg`, name: `${index}.jpg`, type: 'image/jpeg' }));
  await render(<Harness initialLots={lots} sourceLabels={['Lot 157', 'Lot 203']} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  expect(Alert.alert).toHaveBeenCalledWith('Photo Limit Reached', 'Lot 157 already has 200 photos. Delete photos before capturing more.');
  expect(fixture().photoOutput.capturePhotoToFile).not.toHaveBeenCalled();
});

it('adds a video to the selected source lot without changing fixed structure', async () => {
  const recorder = { startRecording: jest.fn(async () => {}), stopRecording: jest.fn(async () => {}) };
  fixture().videoOutput.createRecorder.mockResolvedValue(recorder);
  const autoSave = jest.fn();
  await render(<Harness onAutoSave={autoSave} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  await fireEvent.press(screen.getByText('Rec'));
  await waitFor(() => expect(recorder.startRecording).toHaveBeenCalledTimes(1));
  expect(fixture().videoOutput.createRecorder).toHaveBeenCalledWith({ filePath: '/documents/camera-videos/stable-capture-id.mp4' });
  await act(async () => { await (recorder.startRecording.mock.calls[0] as any)[0]('/saved-video.mp4'); });
  const result = savedLots();
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual(sourceLots()[0]);
  expect(result[1]).toEqual({ ...sourceLots()[1], videoFile: expect.objectContaining({ uri: 'file:///documents/camera-videos/stable-capture-id.mp4', type: 'video/mp4' }) });
  expect(autoSave).toHaveBeenCalledWith(result, 1);
});

it.each(['Quality', 'Balanced', 'Speed'])('records HD MP4 at 30 fps independently of %s still-photo quality', async (mode) => {
  const recorder = { startRecording: jest.fn(async () => {}), stopRecording: jest.fn(async () => {}) };
  fixture().videoOutput.createRecorder.mockResolvedValue(recorder);
  await render(<Harness />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByText(mode));
  await fireEvent.press(screen.getByRole('button', { name: 'Low-light photo mode' }));
  expect(fixture().cameraProps.constraints[0]).toEqual({ fps: 24 });
  await fireEvent.press(screen.getByRole('button', { name: 'Record video, 720p at 30 frames per second' }));
  await waitFor(() => expect(recorder.startRecording).toHaveBeenCalledTimes(1));
  expect(fixture().videoOptions).toEqual({ targetResolution: { width: 1280, height: 720 }, targetBitRate: 5_000_000, enableAudio: true, fileType: 'mp4' });
  expect(fixture().cameraProps.outputs).toEqual([fixture().videoOutput]);
  expect(fixture().cameraProps.constraints).toEqual([{ fps: 30 }, { resolutionBias: fixture().videoOutput }]);
  expect(fixture().cameraProps.enableLowLightBoost).toBe(false);
  await act(async () => { await (recorder.startRecording.mock.calls[0] as any)[0]('/documents/camera-videos/stable-capture-id.mp4'); });
  expect(fixture().cameraProps.outputs).toEqual([fixture().photoOutput]);
  expect(fixture().cameraProps.constraints[0]).toEqual({ fps: 24 });
});

it.each([
  [1920, 1080, 30], [1280, 720, 24], [1280, 720, 60], [640, 480, 30],
])('refuses negotiated %sx%s at %sfps instead of silently recording another format', async (width, height, fps) => {
  fixture().videoOutput.currentResolution = { width, height };
  fixture().selectedFPS = fps;
  await render(<Harness />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByText('Rec'));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('720p recording unavailable', expect.any(String)));
  expect(fixture().videoOutput.createRecorder).not.toHaveBeenCalled();
  expect(savedLots()).toEqual(sourceLots());
  expect(fixture().cameraProps.outputs).toEqual([fixture().photoOutput]);
});

it('locks the target lot while the recording session is preparing, not just after recording starts', async () => {
  const recorder = { startRecording: jest.fn(async () => {}), stopRecording: jest.fn(async () => {}) };
  fixture().videoOutput.createRecorder.mockResolvedValue(recorder);
  const close = jest.fn();
  await render(<Harness onClose={close} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByText('Rec'));
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(screen.getByTestId('active-lot').props.children).toBe(0);
  expect(close).not.toHaveBeenCalled();
  await waitFor(() => expect(recorder.startRecording).toHaveBeenCalledTimes(1));
  await act(async () => { await (recorder.startRecording.mock.calls[0] as any)[0]('/documents/camera-videos/stable-capture-id.mp4'); });
  expect(savedLots()[0].videoFile?.uri).toContain('/documents/camera-videos/');
  expect(savedLots()[1].videoFile).toBeUndefined();
});

it('clears an abandoned preparation when hidden so reopening does not lock the lot or start the old recording', async () => {
  const recorder = { startRecording: jest.fn(async () => {}), stopRecording: jest.fn(async () => {}) };
  fixture().videoOutput.createRecorder.mockResolvedValue(recorder);
  const view = await render(<Harness />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByText('Rec'));
  await view.rerender(<Harness visible={false} />);
  await view.rerender(<Harness />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  expect(screen.getByTestId('active-lot').props.children).toBe(1);
  expect(fixture().videoOutput.createRecorder).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Rec'));
  await waitFor(() => expect(recorder.startRecording).toHaveBeenCalledTimes(1));
  await act(async () => { await (recorder.startRecording.mock.calls[0] as any)[0]('/documents/camera-videos/stable-capture-id.mp4'); });
  expect(savedLots()[1].videoFile).toBeDefined();
  expect(savedLots()[0].videoFile).toBeUndefined();
});

it('waits for video local saving and preserves a failed video for retry without recording again', async () => {
  const recorder = { startRecording: jest.fn(async () => {}), stopRecording: jest.fn(async () => {}) };
  fixture().videoOutput.createRecorder.mockResolvedValue(recorder);
  let rejectSave!: (error: Error) => void;
  const save = jest.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; })).mockResolvedValue(undefined);
  const close = jest.fn();
  await render(<Harness manualSubmissionRequired captureContext={{ ownerId: 'owner', draftId: 'draft', sessionId: 'session' }} onAutoSave={save} onClose={close} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByText('Rec'));
  await waitFor(() => expect(recorder.startRecording).toHaveBeenCalledTimes(1));
  let complete!: Promise<void>;
  await act(async () => { complete = (recorder.startRecording.mock.calls[0] as any)[0]('/saved-video.mp4'); });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  expect(close).not.toHaveBeenCalled();
  expect(OfflineCaptureStore.acknowledgePendingCapture).not.toHaveBeenCalled();
  expect(screen.getByTestId('active-lot').props.children).toBe(0);
  await act(async () => { rejectSave(new Error('Full storage')); await complete; });
  expect(savedLots()[0].videoFile?.uri).toContain('/documents/camera-videos/');
  expect(Alert.alert).toHaveBeenCalledWith('Capture not saved to draft', expect.any(String));
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(recorder.startRecording).toHaveBeenCalledTimes(1);
  expect(OfflineCaptureStore.acknowledgePendingCapture).toHaveBeenCalledTimes(1);
});

it.each([false, true])('waits for stamped capture before publish, close or navigation, preserving fixed IDs and mode (extra=%s)', async (extra) => {
  let finishStamp!: (uri: string) => void;
  jest.mocked(stampCameraPhoto).mockReturnValueOnce(new Promise((resolve) => { finishStamp = resolve; }));
  const close = jest.fn();
  const autoSave = jest.fn();
  await render(<Harness onClose={close} onAutoSave={autoSave} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: extra ? 'Capture extra Bundle photo' : 'Capture Bundle photo' }));
  await waitFor(() => expect(stampCameraPhoto).toHaveBeenCalledWith('file:///raw-camera.jpg'));
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  expect(close).not.toHaveBeenCalled();
  expect(autoSave).not.toHaveBeenCalled();
  expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  expect(savedLots()).toEqual(sourceLots());
  expect(screen.getByTestId('active-lot').props.children).toBe(0);
  expect(fixture().photoOutput.capturePhotoToFile).toHaveBeenCalledTimes(1);
  await act(async () => { finishStamp('file:///stamped-receipt.jpg'); });
  await waitFor(() => expect(autoSave).toHaveBeenCalledTimes(1));
  const result = savedLots();
  expect(result).toHaveLength(2);
  expect(result.map(({ files, extraFiles, ...identity }) => identity)).toEqual(sourceLots().map(({ files, extraFiles, ...identity }) => identity));
  expect(result[0][extra ? 'extraFiles' : 'files'][0]).toMatchObject({ uri: 'file:///stamped-receipt.jpg', originalUri: 'file:///stamped-receipt.jpg' });
  expect(result[1]).toEqual(sourceLots()[1]);
  expect(autoSave).toHaveBeenCalledWith(result, 0);
  expect(MediaLibrary.saveToLibraryAsync).toHaveBeenCalledWith('file:///stamped-receipt.jpg');
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  expect(screen.getByTestId('active-lot').props.children).toBe(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(close).toHaveBeenCalledTimes(1);
});

it('rejects direct stale capture-mode callbacks, including Extra, after locking', async () => {
  const view = await render(<Harness locked={false} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  const staleCapture = jest.requireMock('./CaptureButtons').fixture.props.onCapture;
  const staleNext = jest.requireMock('./LotNavigation').fixture.props.onNextLot;
  await view.rerender(<Harness locked />);
  await act(async () => { await staleCapture('per_photo', false); await staleCapture('per_item', true); });
  expect(fixture().photoOutput.capturePhotoToFile).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Next lot' }));
  await act(async () => { staleNext(); });
  expect(savedLots()).toEqual(sourceLots());
  expect(screen.getByTestId('active-lot').props.children).toBe(1);
});

it('does not publish an unmarked photo when stamping fails and releases the close lock', async () => {
  jest.mocked(stampCameraPhoto).mockRejectedValueOnce(new Error('Synthetic stamping failure'));
  const close = jest.fn();
  const autoSave = jest.fn();
  await render(<Harness onClose={close} onAutoSave={autoSave} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start test camera' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Capture Bundle photo' }));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Capture Failed', expect.any(String)));
  expect(savedLots()).toEqual(sourceLots());
  expect(autoSave).not.toHaveBeenCalled();
  expect(MediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(close).toHaveBeenCalledTimes(1);
});
