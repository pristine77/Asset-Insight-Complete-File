import eas from '../../eas.json';
import packageJson from '../../package.json';
import { DEFAULT_API_BASE_URL } from './api';

describe('production APK build configuration', () => {
  it('inherits production settings without replacing the Play Store bundle profile', () => {
    expect(eas.build['production-apk'].extends).toBe('production');
    expect(eas.build['production-apk'].environment).toBe('production');
    expect(eas.build['production-apk'].developmentClient).toBe(false);
    expect(eas.build['production-apk'].android).toEqual({
      buildType: 'apk',
      credentialsSource: 'remote',
    });
    expect(eas.build.production).not.toHaveProperty('android.buildType', 'apk');
    expect(packageJson.scripts['android-build']).toContain('--profile production');
    expect(packageJson.scripts['android-build:apk']).toContain('--profile production-apk');
  });

  it('uses the production API and ignores machine-local dotenv overrides', () => {
    expect(eas.build['production-apk'].env.EXPO_PUBLIC_API_BASE_URL).toBe(DEFAULT_API_BASE_URL);
    expect(eas.build['production-apk'].env.EXPO_NO_DOTENV).toBe('1');
  });
});
