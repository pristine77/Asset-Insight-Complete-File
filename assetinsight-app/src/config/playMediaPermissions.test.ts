import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const broadMedia = ['READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO'];

describe('Play least-privilege media access', () => {
  it('blocks dependency-injected broad media access while keeping legacy camera writes', () => {
    const { expo } = JSON.parse(read('app.json'));
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    for (const name of broadMedia) {
      const permission = `android.permission.${name}`;
      expect(expo.android.permissions).not.toContain(permission);
      expect(expo.android.blockedPermissions).toContain(permission);
      const declarations = manifest.match(/<uses-permission\b[^>]*>/g) || [];
      expect(declarations.filter((line) => line.includes(`android:name="${permission}"`)))
        .toEqual([expect.stringContaining('tools:node="remove"')]);
      expect(read('modules/auction-camera/android/src/main/AndroidManifest.xml'))
        .not.toContain(permission);
    }
    const mediaPlugin = expo.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-media-library');
    expect(mediaPlugin[1].granularPermissions).toEqual([]);
    expect(manifest).toContain('android.permission.WRITE_EXTERNAL_STORAGE');
    expect(read('modules/auction-camera/android/src/main/AndroidManifest.xml'))
      .toMatch(/WRITE_EXTERNAL_STORAGE"\s+android:maxSdkVersion="28"/);
  });

  it('keeps the development overlay out of the production manifest', () => {
    expect(read('android/app/src/main/AndroidManifest.xml')).not.toContain('SYSTEM_ALERT_WINDOW');
    expect(read('android/app/src/release/AndroidManifest.xml'))
      .toMatch(/android:name="android.permission.SYSTEM_ALERT_WINDOW"\s+tools:node="remove"/);
    expect(read('android/app/src/debug/AndroidManifest.xml')).toContain('SYSTEM_ALERT_WINDOW');
  });

  it.each(['SupportScreen', 'PreviewScreen', 'CrmTasksScreen'])(
    '%s uses the platform-aware picker gate without requesting Android gallery access',
    (screen) => {
      const source = read(`src/screens/${screen}.tsx`);
      expect(source).toContain('await ensurePhotoPickerAccess()');
      expect(source).not.toContain('requestMediaLibraryPermissionsAsync');
      expect(source).toContain('ImagePicker.launchImageLibraryAsync');
    }
  );
});
