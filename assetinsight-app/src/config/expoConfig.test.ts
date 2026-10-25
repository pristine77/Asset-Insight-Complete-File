import fs from 'node:fs';
import path from 'node:path';
import resolveExpoConfig from '../../app.config';
import appJson from '../../app.json';

const appConfig = appJson.expo;

describe('dynamic Expo configuration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves normalized app.json settings when Google services exists', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveExpoConfig({ config: appConfig });
    expect(result).toEqual({ ...appConfig, plugins: [...appConfig.plugins, 'expo-sqlite'] });
    expect(result).not.toHaveProperty('expo');
    expect(result).not.toBe(appConfig);
    expect(result.android).not.toBe(appConfig.android);
  });

  it('only omits the missing Google services file and does not mutate app.json', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const result = resolveExpoConfig({ config: appConfig });
    const expectedAndroid: Partial<typeof appConfig.android> = { ...appConfig.android };
    delete expectedAndroid.googleServicesFile;
    expect(result).toEqual({ ...appConfig, android: expectedAndroid, plugins: [...appConfig.plugins, 'expo-sqlite'] });
    expect(appConfig.android.googleServicesFile).toBe('./google-services.json');
  });

  it('honors the incoming configuration and its configured Google services path', () => {
    const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const config = {
      ...appConfig,
      name: 'Local test configuration',
      android: { ...appConfig.android, googleServicesFile: './config/google-services.json' },
    };
    expect(resolveExpoConfig({ config })).toEqual({ ...config, plugins: [...config.plugins, 'expo-sqlite'] });
    expect(exists).toHaveBeenCalledWith(
      path.resolve(__dirname, '../../config/google-services.json')
    );
  });

  it('does not invent a Google services file when none is configured', () => {
    const exists = jest.spyOn(fs, 'existsSync');
    const config = { name: 'Test', slug: 'test', android: { package: 'com.example.test' } };
    expect(resolveExpoConfig({ config })).toEqual({ ...config, plugins: ['expo-sqlite'] });
    expect(exists).not.toHaveBeenCalled();
  });

  it('preserves the owner and project link supplied by a new EAS setup', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const config = {
      ...appConfig,
      owner: 'test-app-owner',
      extra: { eas: { projectId: '00000000-0000-4000-8000-000000000001' } },
    };
    const result = resolveExpoConfig({ config });
    expect(result.owner).toBe(config.owner);
    expect(result.extra).toEqual(config.extra);
    expect(result.android.package).toBe('com.assetinsight.app');
    expect(result.ios.bundleIdentifier).toBe('com.assetinsight.app');
  });
});
