import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

/** Android's system picker grants access only to selected files, without a gallery permission. */
export async function ensurePhotoPickerAccess(): Promise<boolean> {
  if (Platform.OS === 'android') return true;
  // Preserve the existing iOS library permission/limited-library behavior.
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  return permission.granted;
}
