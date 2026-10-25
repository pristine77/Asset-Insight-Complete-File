import * as FileSystem from 'expo-file-system/legacy';
import { Dimensions, Platform } from 'react-native';
import { API_BASE_URL } from '../config/api';
import { getMemoryAccessToken, getOrCreateDeviceKey } from './deviceAccessStorage';
import { getAndroidReinstallId } from './deviceReinstallIdentity';

/** Only a record id is accepted: bearer/device headers cannot be sent to arbitrary hosts. */
export async function downloadApprovedReportFile(fileId: string, destination: string) {
  if (!/^[a-f\d]{24}$/i.test(fileId)) throw new Error('Invalid report file identifier.');
  const token = getMemoryAccessToken();
  if (!token) throw new Error('Please sign in again before downloading.');
  const [deviceKey, reinstallId] = await Promise.all([getOrCreateDeviceKey(), getAndroidReinstallId()]);
  const screen = Dimensions.get('screen');
  return FileSystem.downloadAsync(`${API_BASE_URL}/reports/${fileId}/download`, destination, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(deviceKey ? { 'X-Device-Key': deviceKey } : {}),
      ...(reinstallId ? { 'X-Device-Reinstall-Id': reinstallId } : {}),
      'X-Device-Platform': Platform.OS === 'ios' ? 'ios' : 'android',
      'X-Device-Form-Factor': Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'mobile',
    },
  });
}
