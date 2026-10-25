import React, { useState } from 'react';
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })) } }));
jest.mock('../../services/offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => 'owner', setSubmissionState: jest.fn(async () => undefined), recordDraftOpened: jest.fn(async () => undefined) } }));
import { Alert, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ListingTextInput from './ListingTextInput';
import AssetFormSheet from './AssetFormSheet';
import LotListingFormSheet from './LotListingFormSheet';
import PreviewScreen from '../../screens/PreviewScreen';
import api from '../../services/api';
import assetService from '../../services/assetService';
import lotListingService from '../../services/lotListingService';
import AutoSaveService from '../../services/autoSaveService';
import NetInfo from '@react-native-community/netinfo';
import { getHiddenCurrentLocation } from '../../utils/mobileLocation';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@shopify/react-native-skia', () => ({ Canvas: () => null, Group: () => null, Path: () => null, Skia: {} }));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { username: 'Inspector', companyName: 'QA' } }) }));
jest.mock('../../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: {} }) }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-CA', regionCode: 'CA' }] }));
jest.mock('./CameraCapture', () => ({ __esModule: true, default: () => null }));
jest.mock('../camera/NativeAuctionCameraScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('./LotManager', () => ({ __esModule: true, default: () => null }));
jest.mock('../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
jest.mock('../../services/assetService', () => ({ __esModule: true, default: { createAssetReport: jest.fn() } }));
jest.mock('../../services/lotListingService', () => ({ __esModule: true, default: { createLotListing: jest.fn() } }));
jest.mock('../../services/assignedApprovalService', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/savedInputService', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../services/offlineQueueService', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/reportDraftService', () => ({ __esModule: true, default: {}, getDuplicateLotWarning: () => null }));
jest.mock('../../services/autoSaveService', () => ({ __esModule: true, default: {
  getDraft: jest.fn(),
  migrateLegacyAutoSaveIfNeeded: jest.fn(), getAutoSaveSummary: jest.fn(async () => null), saveDraft: jest.fn(async () => ({ id: 'local' })),
} }));
jest.mock('../../utils/mobileLocation', () => ({ normalizeHiddenLocation: (location = 'Not provided', latitude?: number, longitude?: number) => ({ location, latitude, longitude }), getHiddenCurrentLocation: jest.fn(async () => ({ location: 'Not provided' })) }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(api.get).mockImplementation(async (url) => ({ data: { data: String(url).includes('category-specs') ? { specs: [] } : {
    status: 'preview', imageUrls: ['https://example.test/original.jpg'], grouping_mode: 'mixed',
    preview_data: { currency: 'CAD', lots: [{ id: 'stable-lot', lot_number: '157', title: 'Saved vehicle', description: 'First line', details: '', condition_report_specs: { 'Engine Hours': '10', 'Exterior notes': 'No visible defects in this photograph', 'Spare wheel': 'Visible', 'Tool kit': 'Not visible' }, image_indexes: [0] }] },
  } } }));
});

it('keeps one native input mounted while typing and preserves every multiline character', async () => {
  function Editor() { const [value, setValue] = useState(''); return <ListingTextInput accessibilityLabel="Notes" value={value} onChangeText={setValue} multiline />; }
  await render(<Editor />);
  const input = screen.getByLabelText('Notes');
  for (const value of ['Line one', 'Line one\nLine two', `Line one\nLine two\n${'More evidence. '.repeat(300)}`]) {
    await fireEvent.changeText(input, value);
    expect(screen.getByLabelText('Notes')).toBe(input);
    expect(input.props.value).toBe(value);
  }
  expect(input.props.submitBehavior).toBe('newline');
  expect(input.props.scrollEnabled).toBe(true);
  expect(StyleSheet.flatten(input.props.style)).toMatchObject({ minHeight: 88, maxHeight: 200, textAlignVertical: 'top' });
});

it('keeps Asset fields mounted and accepts split contract identifiers without submission', async () => {
  const view = await render(<AssetFormSheet visible onClose={jest.fn()} />);
  const name = screen.getByLabelText('Client name, required');
  await fireEvent.changeText(name, 'C');
  await fireEvent.changeText(name, 'Client name');
  expect(screen.getByLabelText('Client name, required')).toBe(name);
  await fireEvent.changeText(screen.getByLabelText('Contract number'), '93530.3-A');
  expect(screen.getByLabelText('Contract number').props.value).toBe('93530.3-A');
  const notes = screen.getByLabelText('Analysis notes');
  await fireEvent.changeText(notes, 'One\nTwo\nThree');
  expect(notes.props.value).toBe('One\nTwo\nThree');
  expect(StyleSheet.flatten(screen.getByTestId('asset-form-keyboard-layout').props.style)).toMatchObject({ flex: 1, minHeight: 0 });
  expect(assetService.createAssetReport).not.toHaveBeenCalled();
  await view.unmount();
});

it('keeps an expanded condition field editor scrollable and retains long multiline values locally', async () => {
  const view = await render(<PreviewScreen reportId="fixture" reportType="LotListing" mode="pending" onBack={jest.fn()} onSuccess={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('Lot 1 title')).toBeTruthy());
  expect(screen.getByLabelText('Lot 1, Exterior notes').props.value).toBe('No visible defects in this photograph');
  expect(screen.getByLabelText('Lot 1, Spare wheel').props.value).toBe('Yes');
  expect(screen.getByLabelText('Lot 1, Tool kit').props.value).toBe('No');
  await fireEvent.press(screen.getByRole('button', { name: 'Add condition report field to lot 1' }));
  expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Cancel add' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete field' })).toBeNull();
  const fieldName = screen.getByLabelText('Condition report field name');
  await fireEvent.changeText(fieldName, 'Inspection notes');
  const notes = screen.getByLabelText('Condition report field value');
  const multiline = `Visible condition\n${'Detailed note. '.repeat(200)}\nFinal observation`;
  await fireEvent.changeText(notes, multiline);
  expect(screen.getByLabelText('Condition report field value')).toBe(notes);
  expect(notes.props.value).toBe(multiline);
  expect(screen.getByTestId('listing-spec-editor-scroll').props.keyboardShouldPersistTaps).toBe('handled');
  await fireEvent.press(screen.getByRole('button', { name: 'Save condition report field' }));
  expect(screen.getByLabelText('Lot 1, Inspection notes').props.value).toBe(multiline);
  expect(screen.queryByLabelText('Condition report field name')).toBeNull();
  await fireEvent(screen.getByLabelText('Lot 1, Inspection notes'), 'pressIn');
  expect(screen.getByRole('button', { name: 'Delete field' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.put).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  await view.unmount();
});

it('gives Lot Listing a keyboard viewport and retains typed contract text across section toggles', async () => {
  const view = await render(<LotListingFormSheet visible onClose={jest.fn()} />);
  const input = screen.getByLabelText('Contract number, required');
  await fireEvent.changeText(input, '93530.3');
  await fireEvent.changeText(input, '93530.3-A');
  expect(screen.getByLabelText('Contract number, required')).toBe(input);
  expect(input.props.keyboardType).not.toBe('number-pad');
  expect(StyleSheet.flatten(screen.getByTestId('lot-listing-keyboard-layout').props.style)).toMatchObject({ flex: 1, minHeight: 0 });
  await fireEvent.press(screen.getByRole('button', { name: 'Listing details' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Listing details' }));
  expect(screen.getByLabelText('Contract number, required').props.value).toBe('93530.3-A');
  expect(lotListingService.createLotListing).not.toHaveBeenCalled();
  await view.unmount();
});

it.each(['asset', 'lotListing'] as const)('%s Offline saves incomplete details locally, never creates a preview or upload', async (type) => {
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: false, isInternetReachable: false } as any);
  const Form = type === 'asset' ? AssetFormSheet : LotListingFormSheet;
  const view = await render(<Form visible onClose={jest.fn()} />);
  expect(screen.getByRole('radio', { name: 'Online capture' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(screen.getByRole('radio', { name: 'Offline capture' }));
  expect(screen.getByRole('radio', { name: 'Offline capture' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(screen.getByRole('button', { name: 'Save on device' }));
  expect(AutoSaveService.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ type, captureMode: 'offline', formData: expect.objectContaining({ captureMode: 'offline' }) }));
  expect(assetService.createAssetReport).not.toHaveBeenCalled();
  expect(lotListingService.createLotListing).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
  await view.unmount();
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: true, isInternetReachable: true } as any);
});

it.each(['Asset', 'LotListing'] as const)('%s preview retains focused lot Title and user lot number on parent updates', async (reportType) => {
  const view = await render(<PreviewScreen reportId="fixture" reportType={reportType} mode="pending" onBack={jest.fn()} onSuccess={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('Lot 1 title')).toBeTruthy());
  expect(screen.queryByLabelText('Lot 1 description')).toBeNull();
  const title = screen.getByLabelText('Lot 1 title');
  for (const text of ['Edited', 'Edited vehicle', 'Edited vehicle with attachments']) {
    await fireEvent.changeText(title, text);
    expect(screen.getByLabelText('Lot 1 title')).toBe(title);
    expect(title.props.value).toBe(text);
  }
  await fireEvent.changeText(screen.getByLabelText('Lot 1 number'), '157A');
  expect(screen.getByLabelText('Lot 1 number').props.value).toBe('157A');
  expect(title.props.value).toBe('Edited vehicle with attachments');
  expect(api.put).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  await view.unmount();
});

it('keeps a saved manual Asset location when optional GPS resolves later', async () => {
  let resolveLocation!: (value: any) => void;
  jest.mocked(getHiddenCurrentLocation).mockReturnValueOnce(new Promise((resolve) => { resolveLocation = resolve; }));
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue({ id: 'manual-location', type: 'asset', ownerId: 'owner',
    captureMode: 'offline', formData: { captureMode: 'offline', location: 'Toronto inspection yard', contractNo: '93530' },
    lots: [], activeLotIdx: 0, createdAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T10:00:00Z', title: 'Manual location',
  });
  const view = await render(<AssetFormSheet visible draftIdToLoad="manual-location" onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Offline capture' }).props.accessibilityState.checked).toBe(true));
  await act(async () => resolveLocation({ location: 'Current Browser Location', latitude: 43.65, longitude: -79.38 }));
  await fireEvent.press(screen.getByRole('button', { name: 'Save on device' }));
  expect(AutoSaveService.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({
    formData: expect.objectContaining({ location: 'Toronto inspection yard', latitude: 43.65, longitude: -79.38 }),
  }));
  await view.unmount();
});
