import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '../..');

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

describe('Google Play production compatibility', () => {
  it('blocks external package installation even when a native dependency requests it', () => {
    const appConfig = readJson('app.json');
    const manifest = fs.readFileSync(
      path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );

    expect(appConfig.expo.android.permissions).not.toContain(
      'android.permission.REQUEST_INSTALL_PACKAGES'
    );
    expect(appConfig.expo.android.blockedPermissions).toContain(
      'android.permission.REQUEST_INSTALL_PACKAGES'
    );
    const installPermissionDeclarations = (manifest.match(/<uses-permission\b[^>]*>/g) || [])
      .filter((declaration) =>
        declaration.includes('android:name="android.permission.REQUEST_INSTALL_PACKAGES"')
      );
    expect(installPermissionDeclarations).toHaveLength(1);
    expect(installPermissionDeclarations[0]).toContain('tools:node="remove"');
  });

  it('uses remotely managed, auto-incrementing production build versions', () => {
    const easConfig = readJson('eas.json');

    expect(easConfig.cli.appVersionSource).toBe('remote');
    expect(easConfig.build.production.autoIncrement).toBe(true);
  });

  it('pins the Play AAB and sideload APK to production without loading local dotenv fixtures', () => {
    const { build } = readJson('eas.json');
    expect(build.production.environment).toBe('production');
    expect(build.production.developmentClient).toBe(false);
    expect(build.production.env).toEqual({
      EXPO_NO_DOTENV: '1',
      EXPO_PUBLIC_API_BASE_URL: 'https://api.assetinsightvaluator.com/api',
      EXPO_PUBLIC_CAPTURE_BACKUP_ENABLED: 'false',
    });
    expect(build.production.android).toMatchObject({ buildType: 'app-bundle', credentialsSource: 'remote' });
    expect(build['production-apk'].extends).toBe('production');
    expect(build['production-apk'].android).toMatchObject({ buildType: 'apk', credentialsSource: 'remote' });
    expect(build['production-apk'].env).toEqual(build.production.env);
  });

  it('keeps the 1.0.3 marketing version consistent without resetting the remote Android counter', () => {
    const appConfig = readJson('app.json');
    const packageJson = readJson('package.json');
    const lock = readJson('package-lock.json');
    const gradle = fs.readFileSync(path.join(projectRoot, 'android/app/build.gradle'), 'utf8');
    expect(appConfig.expo.version).toBe('1.0.3');
    expect(packageJson.version).toBe(appConfig.expo.version);
    expect(lock.version).toBe(appConfig.expo.version);
    expect(lock.packages[''].version).toBe(appConfig.expo.version);
    expect(gradle).toContain(`versionName "${appConfig.expo.version}"`);
    expect(gradle).toContain(`versionCode ${appConfig.expo.android.versionCode}`);
    expect(appConfig.expo.android.versionCode).toBeGreaterThan(3);
    expect(readJson('eas.json').cli.appVersionSource).toBe('remote');
  });

  it('does not ship the custom APK installer dependency', () => {
    const packageJson = readJson('package.json');
    const appSource = fs.readFileSync(path.join(projectRoot, 'App.tsx'), 'utf8');

    expect(packageJson.dependencies).not.toHaveProperty('expo-intent-launcher');
    expect(appSource).not.toContain('AppUpdatePrompt');
    expect(fs.existsSync(path.join(projectRoot, 'src/components/AppUpdatePrompt.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'src/services/appVersionService.ts'))).toBe(false);
  });
});
