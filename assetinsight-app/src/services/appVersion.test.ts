import { getAppVersionLabel } from './appVersion';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
jest.mock('expo-application', () => ({ __esModule: true, nativeApplicationVersion: '1.0.1', nativeBuildVersion: '73' }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '0.9.0', android: { versionCode: 3 } } } }));
it('reports the installed version and remote build code, not the bundled config fallback', () => {
  expect(getAppVersionLabel()).toBe('1.0.1 (build 73)');
});
it('uses Expo version only when running without installed native metadata', () => {
  (Application as any).nativeApplicationVersion = null;
  (Application as any).nativeBuildVersion = null;
  expect(getAppVersionLabel()).toContain(Constants.expoConfig!.version);
});
