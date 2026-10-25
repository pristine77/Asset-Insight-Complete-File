import * as FileSystem from 'expo-file-system/legacy';
import { downloadApprovedReportFile } from './reportDownloadTransport';

jest.mock('expo-file-system/legacy', () => ({ downloadAsync: jest.fn().mockResolvedValue({ status: 200, uri: 'file:///report.pdf' }) }));
jest.mock('../config/api', () => ({ API_BASE_URL: 'https://api.example.test/api' }));
jest.mock('./deviceAccessStorage', () => ({ getMemoryAccessToken: () => 'access-token', getOrCreateDeviceKey: async () => 'device-key' }));
jest.mock('./deviceReinstallIdentity', () => ({ getAndroidReinstallId: async () => 'reinstall-id' }));

beforeEach(() => jest.clearAllMocks());

it('downloads only through the protected report endpoint with device context', async () => {
  const id = 'a'.repeat(24);
  await downloadApprovedReportFile(id, 'file:///report.pdf');
  expect(FileSystem.downloadAsync).toHaveBeenCalledWith(`https://api.example.test/api/reports/${id}/download`, 'file:///report.pdf', {
    headers: expect.objectContaining({ Authorization: 'Bearer access-token', 'X-Device-Key': 'device-key', 'X-Device-Reinstall-Id': 'reinstall-id', 'X-Device-Platform': expect.stringMatching(/^(ios|android)$/), 'X-Device-Form-Factor': expect.stringMatching(/^(tablet|mobile)$/) }),
  });
});

it('never sends credentials to a supplied public/legacy storage URL', async () => {
  await expect(downloadApprovedReportFile('https://assetinsight.pro/report.pdf', 'file:///report.pdf')).rejects.toThrow('Invalid report file');
  expect(FileSystem.downloadAsync).not.toHaveBeenCalled();
});
