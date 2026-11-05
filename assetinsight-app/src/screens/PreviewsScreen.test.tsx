import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PreviewsScreen from './PreviewsScreen';
import api from '../services/api';
import { assetService } from '../services/assetService';
import salvageService from '../services/salvageService';
import { invalidateAuthOperations } from '../services/authSessionOperation';
import { ThemeProvider } from '../context/ThemeContext';
import reportDraftService from '../services/reportDraftService';

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
  jest.mocked(api.post).mockReset();
  jest.mocked(reportDraftService.list).mockResolvedValue([]);
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

const revision = 'a'.repeat(64);
const failed = { _id: 'asset-failed', status: 'error', job_status: 'error', job_id: 'failed-attempt', workflow_stage: 'error', createdAt: '2026-11-04',
  preview_available: false, job_error: 'Duplicate lot number 1. Original photos are retained.', preview_data: { client_name: 'Dustin Hawkins' } };
const capability = { data: { data: { initialPreviewRetryEligible: true, initialPreviewRetryIneligibleReason: null, initialPreviewRetryRevision: revision } } };
const queuedReceipt = { status: 202, data: { data: { reportId: failed._id, reportType: 'asset', retry_stage: 'initial_preview', job_status: 'queued' } } };
const retryButton = () => screen.findByRole('button', { name: 'Retry Dustin Hawkins from its uploaded photos' });
function prepareFailed() {
  jest.mocked(assetService.getAssetReports).mockResolvedValue([failed as any]);
  jest.mocked(api.get).mockImplementation(async url => url.endsWith('/retry-preview') ? capability : { data: { data: [] } });
  jest.mocked(api.post).mockResolvedValue(queuedReceipt);
}

it.each(['asset', 'lotListing'])('uses the verified same-report revision for %s initial Retry and never resubmits files', async kind => {
  prepareFailed();
  if (kind === 'lotListing') {
    jest.mocked(assetService.getAssetReports).mockResolvedValue([]);
    jest.mocked(api.get).mockImplementation(async url => url.endsWith('/retry-preview') ? capability : { data: { data: url === '/lot-listing' ? [{ ...failed, contract_no: 'Dustin Hawkins' }] : [] } });
    jest.mocked(api.post).mockResolvedValue({ ...queuedReceipt, data: { data: { ...queuedReceipt.data.data, reportType: kind } } });
  }
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  expect(screen.queryByText('Review & submit')).toBeNull();
  await fireEvent.press(await retryButton());
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/${kind === 'asset' ? 'asset' : 'lot-listing'}/${failed._id}/retry-preview`,
    { baseRevision: revision }, expect.objectContaining({ timeout: 60_000, skipAuthRefreshReplay: true, signal: expect.anything() })));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(props.onOpenPreview).not.toHaveBeenCalled();
});

it.each([
  { initialPreviewRetryEligible: false, initialPreviewRetryIneligibleReason: 'Incoming reports use their existing retry action.' },
  { initialPreviewRetryEligible: true, initialPreviewRetryRevision: 'invalid' },
  { initialPreviewRetryEligible: true, initialPreviewRetryRevision: revision, initialPreviewRetryIneligibleReason: {} },
])('refuses unavailable or malformed retry capability without queueing %j', async state => {
  prepareFailed(); const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(api.get).mockImplementation(async url => url.endsWith('/retry-preview') ? { data: { data: state } } : { data: { data: [] } });
  try {
    await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
    await fireEvent.press(await retryButton());
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Unable to retry', expect.any(String)));
    expect(api.post).not.toHaveBeenCalled();
  } finally { alert.mockRestore(); }
});

it.each([
  { status: 200, data: queuedReceipt.data },
  { status: 202, data: { data: { ...queuedReceipt.data.data, reportId: 'different-report' } } },
  { status: 202, data: { data: { ...queuedReceipt.data.data, reportType: 'lotListing' } } },
  { status: 202, data: { data: { ...queuedReceipt.data.data, retry_stage: 'files' } } },
  { status: 202, data: { data: { ...queuedReceipt.data.data, job_status: 'done', preview_available: false } } },
  { status: 202, data: {} },
])('treats a malformed acceptance as uncertain and never auto-replays %j', async response => {
  prepareFailed(); const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.mocked(api.post).mockResolvedValue(response);
  try {
    await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
    await fireEvent.press(await retryButton());
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Unable to retry', expect.stringContaining('check whether processing started')));
    expect(api.post).toHaveBeenCalledTimes(1); expect(assetService.getAssetReports).toHaveBeenCalledTimes(1);
  } finally { alert.mockRestore(); }
});

it('accepts an exact completed replay only when the same report has a ready preview', async () => {
  prepareFailed();
  jest.mocked(api.post).mockResolvedValue({ ...queuedReceipt, data: { data: { ...queuedReceipt.data.data, job_status: 'done', preview_available: true } } });
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await fireEvent.press(await retryButton());
  await waitFor(() => expect(assetService.getAssetReports).toHaveBeenCalledTimes(2));
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each(['account', 'report', 'tab'])('drops held capability when its %s context changes', async changed => {
  prepareFailed(); let finish!: (value: any) => void;
  jest.mocked(api.get).mockImplementation(async url => url.endsWith('/retry-preview') ? new Promise(resolve => { finish = resolve; }) : { data: { data: [] } });
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await fireEvent.press(await retryButton());
  if (changed === 'account') invalidateAuthOperations();
  if (changed === 'report') {
    jest.mocked(assetService.getAssetReports).mockResolvedValue([{ ...failed, job_id: 'newer-attempt' } as any]);
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh previews' }));
    await waitFor(() => expect(assetService.getAssetReports).toHaveBeenCalledTimes(2));
  }
  if (changed === 'tab') await fireEvent.press(screen.getAllByText('Submitted')[1]);
  await act(async () => { finish(capability); });
  expect(api.post).not.toHaveBeenCalled();
});

it('coalesces repeated Retry taps while capability is loading', async () => {
  prepareFailed(); let finish!: (value: any) => void;
  jest.mocked(api.get).mockImplementation(async url => url.endsWith('/retry-preview') ? new Promise(resolve => { finish = resolve; }) : { data: { data: [] } });
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  const button = await retryButton(); await fireEvent.press(button); await fireEvent.press(button);
  expect(jest.mocked(api.get).mock.calls.filter(([url]) => url.endsWith('/retry-preview'))).toHaveLength(1);
  await act(async () => { finish(capability); });
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
});

it('does not apply a delayed POST response to a different signed-in session', async () => {
  prepareFailed(); let finish!: (value: any) => void;
  jest.mocked(api.post).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
    await fireEvent.press(await retryButton()); await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    invalidateAuthOperations(); await act(async () => { finish(queuedReceipt); });
    expect(assetService.getAssetReports).toHaveBeenCalledTimes(1); expect(alert).not.toHaveBeenCalled();
  } finally { alert.mockRestore(); }
});

it('aborts a held retry request when the screen closes', async () => {
  prepareFailed(); let finish!: (value: any) => void;
  jest.mocked(api.get).mockImplementation(async url => url.endsWith('/retry-preview') ? new Promise(resolve => { finish = resolve; }) : { data: { data: [] } });
  const view = await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await fireEvent.press(await retryButton());
  const signal = jest.mocked(api.get).mock.calls.find(([url]) => url.endsWith('/retry-preview'))![1]!.signal!;
  await view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => { finish(capability); }); expect(api.post).not.toHaveBeenCalled();
});

it('keeps the failed submitted-draft note', async () => {
  jest.mocked(reportDraftService.list).mockResolvedValue([{ id: 'retained-draft', type: 'asset', title: 'Kept work', createdAt: '2026-11-04', lots: [], media: [],
    submission: { status: 'failed', reportId: failed._id, reportType: 'asset', message: 'Processing stopped', sentAt: null, failedAt: null } } as any]);
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  await fireEvent.press(await screen.findByText('Drafts'));
  expect(await screen.findByTestId('draft-submission-failed')).toBeTruthy();
});

it('keeps Review & submit for a failed report whose saved preview can still be opened', async () => {
  const failed = { _id: 'asset-saved', status: 'error', job_status: 'error', workflow_stage: 'error', createdAt: '2026-11-04',
    preview_available: true, preview_data: { client_name: 'Saved Preview', lots: [{ title: 'Loader' }] } };
  jest.mocked(assetService.getAssetReports).mockResolvedValue([failed as any]);
  jest.mocked(api.get).mockResolvedValue({ data: { data: [] } });
  await render(<ThemeProvider><PreviewsScreen {...props} /></ThemeProvider>);
  expect(await screen.findByText('Review & submit')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /from its uploaded photos/ })).toBeNull();
});
