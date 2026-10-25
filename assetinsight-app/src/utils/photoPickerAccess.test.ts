import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { ensurePhotoPickerAccess } from './photoPickerAccess';

jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn() }));

const originalOS = Platform.OS;
afterEach(() => { Platform.OS = originalOS; jest.clearAllMocks(); });

it('opens the Android system picker without requesting broad or legacy gallery access', async () => {
  Platform.OS = 'android';
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockRejectedValue(new Error('Permission absent'));
  await expect(ensurePhotoPickerAccess()).resolves.toBe(true);
  expect(ImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
});

it.each([true, false])('preserves the iOS permission result: %s', async (granted) => {
  Platform.OS = 'ios';
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({ granted } as ImagePicker.MediaLibraryPermissionResponse);
  await expect(ensurePhotoPickerAccess()).resolves.toBe(granted);
  expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalledTimes(1);
});

it('does not hide an iOS permission request failure', async () => {
  Platform.OS = 'ios';
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockRejectedValue(new Error('Permission unavailable'));
  await expect(ensurePhotoPickerAccess()).rejects.toThrow('Permission unavailable');
});
