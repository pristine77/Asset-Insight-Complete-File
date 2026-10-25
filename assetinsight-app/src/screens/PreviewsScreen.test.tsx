import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PreviewsScreen from './PreviewsScreen';
import api from '../services/api';
import { assetService } from '../services/assetService';
import salvageService from '../services/salvageService';
import { invalidateAuthOperations } from '../services/authSessionOperation';
import { ThemeProvider } from '../context/ThemeContext';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../components/AssetMergeSheet', () => () => null);
jest.mock('../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
jest.mock('../services/assetService', () => ({ assetService: { getAssetReports: jest.fn() } }));
jest.mock('../services/reportDraftService', () => ({ __esModule: true, default: { list: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/salvageService', () => ({ __esModule: true, default: { list: jest.fn() } }));

const asset = { _id: 'asset-one', status: 'preview', createdAt: '2026-10-02', preview_data: { client_name: 'Retained Asset' } };
const lot = { _id: 'lot-one', status: 'processing', createdAt: '2026-10-02', contract_no: '94677', workflow_stage: 'preparing_preview', files_generating: true };
const props = { onOpenDrawer: jest.fn(), onBack: jest.fn(), onOpenPreview: jest.fn() };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(assetService.getAssetReports).mockResolvedValue([asset as any]);
  jest.mocked(salvageService.list).mockResolvedValue([]);
  jest.mocked(api.get).mockImplementation(async url => ({ data: { data: url === '/lot-listing' ? [lot] : [] } }));
});

it('keeps Lot Listing visible when another report endpoint fails and recovers explicitly', async () => {
  jest.mocked(assetService.getAssetReports).mockRejectedValue({ response: { status: 503 } });
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  expect(await screen.findByText('94677')).toBeTruthy();
  expect(screen.getByRole('alert').props.children.join('')).toContain('server could not load');
  expect(screen.queryByText('No new previews')).toBeNull();
  jest.mocked(assetService.getAssetReports).mockResolvedValue([asset as any]);
  await fireEvent.press(screen.getByRole('button', { name: 'Retry loading previews' }));
  expect(await screen.findByText('Retained Asset')).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(assetService.getAssetReports).toHaveBeenCalledWith('previews');
});

it('preserves loaded items on a later timeout and gives actionable guidance', async () => {
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await screen.findByText('Retained Asset');
  jest.mocked(assetService.getAssetReports).mockRejectedValue({ code: 'ECONNABORTED' });
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh previews' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Retained Asset')).toBeTruthy();
  expect(screen.getByRole('alert').props.children.join('')).toContain('timed out');
});

it('shows unknown counts and an error, not an empty success, when every report read fails', async () => {
  jest.mocked(assetService.getAssetReports).mockRejectedValue({ response: { status: 403 } });
  jest.mocked(api.get).mockRejectedValue({ response: { status: 403 } });
  jest.mocked(salvageService.list).mockRejectedValue({ response: { status: 403 } });
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  expect(await screen.findByText('Preview list unavailable')).toBeTruthy();
  expect(screen.queryByText('No new previews')).toBeNull();
  expect(screen.getByRole('alert').props.children.join('')).toContain('device approval');
});

it('keeps previous reports if a successful response has incomplete report rows', async () => {
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await screen.findByText('Retained Asset');
  jest.mocked(assetService.getAssetReports).mockResolvedValue([{ _id: 'asset-one' } as any]);
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh previews' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Retained Asset')).toBeTruthy();
  expect(screen.getByRole('alert').props.children.join('')).toContain('could not be read');
});

it('retains completed real estate reports in Submitted and offers a direct tab action', async () => {
  jest.mocked(assetService.getAssetReports).mockResolvedValue([]);
  jest.mocked(api.get).mockImplementation(async url => ({ data: { data: url === '/real-estate' ? [{ _id: 'property', status: 'approved', files_ready: true, createdAt: '2026-10-02', property_details: { address: 'Submitted property' } }] : [] } }));
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await fireEvent.press(await screen.findByText('View submitted previews (1)'));
  expect(await screen.findByText('Submitted property')).toBeTruthy();
});

it('does not accept a delayed response from a previous signed-in session', async () => {
  let resolve!: (value: any) => void;
  jest.mocked(assetService.getAssetReports).mockReturnValue(new Promise(r => { resolve = r; }));
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  invalidateAuthOperations();
  await act(async () => { resolve([asset]); });
  expect(screen.queryByText('Retained Asset')).toBeNull();
});

it('shows five processing reports and coalesces repeated refresh while a read is in flight', async () => {
  let finish!: (value: any) => void;
  jest.mocked(assetService.getAssetReports).mockResolvedValue([]);
  jest.mocked(api.get).mockImplementation(async url => ({ data: { data: url === '/lot-listing' ? Array.from({ length: 5 }, (_, i) => ({ ...lot, _id: `report-${i}`, contract_no: `Processing ${i}` })) : [] } }));
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await screen.findByText('Processing 0');
  expect(screen.getByText('Processing 4')).toBeTruthy();
  jest.mocked(assetService.getAssetReports).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh previews' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh previews' }));
  expect(assetService.getAssetReports).toHaveBeenCalledTimes(2);
  await act(async () => { finish([]); });
  expect(screen.getByText('Processing 0')).toBeTruthy();
});
