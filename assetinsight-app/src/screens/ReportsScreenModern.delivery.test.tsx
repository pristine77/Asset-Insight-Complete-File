import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ReportsScreen from './ReportsScreenModern';
import api from '../services/api';
import { assetService } from '../services/assetService';
import auctioneerDeliveryService, { type AuctioneerDeliverySummary } from '../services/auctioneerDeliveryService';
import { invalidateAuthOperations } from '../services/authSessionOperation';

let mockOwner = 'owner';
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { _id: mockOwner } }) }));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: jest.requireActual('react-native').View }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///test/' }));
jest.mock('../services/reportDownloadTransport', () => ({ downloadApprovedReportFile: jest.fn() }));
jest.mock('../components/AssetMergeSheet', () => () => null);
jest.mock('../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { text: '#111', surface: '#fff', accent: '#c00' }, toggleTheme: jest.fn() }) }));
jest.mock('../services/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../services/assetService', () => ({ assetService: { getAssetReports: jest.fn() } }));
jest.mock('../services/salvageService', () => ({ __esModule: true, default: { list: jest.fn(async () => []) } }));
jest.mock('../services/auctioneerDeliveryService', () => ({
  ...jest.requireActual('../services/auctioneerDeliveryService'),
  __esModule: true,
  default: { getDeliveries: jest.fn() },
}));
jest.mock('../components/auction/AuctioneerDeliveryAction', () => {
  const Text = jest.requireActual('react-native').Text;
  return ({ delivery }: { delivery: AuctioneerDeliverySummary }) =>
    <Text testID={`send-${delivery.reportId}-${delivery.reportModel}`}>{delivery.workItemId}: {delivery.state}</Text>;
});

const asset = (id = 'asset') => ({
  _id: id, status: 'approved', createdAt: '2026-10-18T12:00:00Z',
  preview_data: { contract_no: 'same-contract', client_name: id, lots: [{ lot_id: '1', title: 'Test lot' }] },
});
const lot = (id = 'listing') => ({
  ...asset(id), contract_no: 'same-contract',
});
const delivery = (id = 'asset', model = 'AssetReport', work = 'work') => ({
  workItemId: work, reportId: id, reportModel: model,
  reportType: model === 'AssetReport' ? 'asset' : 'lotListing',
  contractId: 'contract', state: 'ready', canSend: true,
}) as AuctioneerDeliverySummary;
const props = { onOpenDrawer: jest.fn(), onBack: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'owner';
  jest.mocked(assetService.getAssetReports).mockResolvedValue([asset()] as any);
  jest.mocked(api.get).mockImplementation(async (path) => ({ data: { data: path === '/lot-listing' ? [lot()] : [] } }));
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockResolvedValue([delivery(), delivery('listing', 'LotListing', 'listing-work')]);
});

it('attaches Send to exact linked Asset and Lot Listing reports, never to an ordinary report with the same contract', async () => {
  jest.mocked(assetService.getAssetReports).mockResolvedValue([asset(), asset('ordinary')] as any);
  await render(<ReportsScreen {...props} />);
  expect(screen.getByTestId('send-asset-AssetReport')).toBeTruthy();
  expect(screen.getByTestId('send-listing-LotListing')).toBeTruthy();
  expect(screen.queryByTestId('send-ordinary-AssetReport')).toBeNull();
  expect(screen.getAllByText('Merge same-contract Asset reports')).toHaveLength(2);
});

it('does not attach a delivery for another report model or contradictory reportType', async () => {
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockResolvedValue([
    delivery('asset', 'LotListing'), { ...delivery('listing', 'LotListing'), reportType: 'asset' },
  ]);
  await render(<ReportsScreen {...props} />);
  expect(screen.queryByTestId('send-asset-LotListing')).toBeNull();
  expect(screen.queryByTestId('send-listing-LotListing')).toBeNull();
});

it('refuses ambiguous work items instead of guessing by contract or first match', async () => {
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockResolvedValue([delivery(), delivery('asset', 'AssetReport', 'second')]);
  await render(<ReportsScreen {...props} />);
  expect(screen.queryByTestId('send-asset-AssetReport')).toBeNull();
  expect(screen.getByText(/conflicting auction delivery links/)).toBeTruthy();
});

it('loads reports even if the delivery endpoint fails, with explicit retry and no raw errors', async () => {
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockRejectedValueOnce(new Error('status code 409 http://127.0.0.1'));
  await render(<ReportsScreen {...props} />);
  expect(screen.getByText('Asset - same-contract')).toBeTruthy();
  expect(screen.getByText('Auction delivery status could not be checked. Your reports are unchanged.')).toBeTruthy();
  expect(screen.queryByText(/status code|127\.0/)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry auction delivery status' }));
  expect(screen.getByTestId('send-asset-AssetReport')).toBeTruthy();
});

it('clears the previous account list and ignores its late responses', async () => {
  let finish!: (value: any) => void;
  jest.mocked(assetService.getAssetReports).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await render(<ReportsScreen {...props} />);
  invalidateAuthOperations();
  mockOwner = 'other';
  jest.mocked(assetService.getAssetReports).mockResolvedValueOnce([asset('new-owner')] as any);
  jest.mocked(auctioneerDeliveryService.getDeliveries).mockResolvedValueOnce([]);
  await screen.rerender(<ReportsScreen {...props} />);
  await act(async () => finish([asset('old-owner')]));
  await waitFor(() => expect(screen.getByText('new-owner')).toBeTruthy());
  expect(screen.queryByText('old-owner')).toBeNull();
  expect(screen.queryByTestId('send-asset-AssetReport')).toBeNull();
});

it('keeps normal preview navigation and released download actions', async () => {
  jest.mocked(assetService.getAssetReports).mockResolvedValue([
    { ...asset(), preview_files: { excel: 'https://example.test/file.xlsx' } },
  ] as any);
  jest.mocked(api.get).mockImplementation(async (path) => ({ data: { data: path === '/lot-listing' ? [{ ...lot(), status: 'preview' }] : [] } }));
  const open = jest.fn();
  await render(<ReportsScreen {...props} onOpenPreview={open} />);
  expect(screen.getByText('Excel')).toBeTruthy();
  await fireEvent.press(screen.getByText('Preview & submit'));
  expect(open).toHaveBeenCalledWith('listing', 'LotListing');
});
