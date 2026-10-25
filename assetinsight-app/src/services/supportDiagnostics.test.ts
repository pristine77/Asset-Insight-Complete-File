import { collectSupportDiagnostics } from './supportDiagnostics';

jest.mock('expo-application', () => ({
  nativeApplicationVersion: '2.4.0',
  nativeBuildVersion: '240',
}));

jest.mock('expo-device', () => ({
  manufacturer: 'Example',
  modelName: 'Phone Pro',
  modelId: 'P100',
  osVersion: '18.1',
}));

describe('support diagnostics privacy boundary', () => {
  it('returns only the backend allowlist and bounds user-provided error text', () => {
    const diagnostics = collectSupportDiagnostics({
      route: 'asset/photo-upload',
      errorCode: ` UPLOAD_FAILED\n${'X'.repeat(200)}`,
      errorMessage: 'Upload stopped',
      stack: 'Error: Upload stopped\n at uploadPhoto',
    });

    expect(diagnostics).toMatchObject({
      appVersion: '2.4.0',
      buildNumber: '240',
      osVersion: '18.1',
      deviceModel: 'Example Phone Pro',
      route: 'asset/photo-upload',
      errorMessage: 'Upload stopped',
    });
    expect(diagnostics.errorCode?.length).toBeLessThanOrEqual(120);
    expect(Object.keys(diagnostics).sort()).toEqual(
      [
        'appVersion',
        'buildNumber',
        'deviceModel',
        'errorCode',
        'errorMessage',
        'occurredAt',
        'osVersion',
        'platform',
        'route',
        'screen',
        'stack',
      ].sort()
    );
    expect(JSON.stringify(diagnostics)).not.toMatch(/token|location|installation/i);
  });
});
