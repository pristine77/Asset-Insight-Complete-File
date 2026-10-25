import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/** Installed binary is authoritative; Expo config is only a development fallback. */
export function getAppVersionLabel(): string | undefined {
  const version = Application.nativeApplicationVersion || Constants.expoConfig?.version;
  const build = Application.nativeBuildVersion || (Platform.OS === 'android' ? Constants.expoConfig?.android?.versionCode : Constants.expoConfig?.ios?.buildNumber);
  if (!version) return undefined;
  return `${version}${build ? ` (build ${build})` : ''}`.slice(0, 80);
}
