import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../modules/capture-backup/android');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
const kotlin = (name: string) => read(`src/main/java/expo/modules/capturebackup/${name}.kt`);

describe('native capture backup release gate', () => {
  it('compiles enabled only for the exact true environment setting, otherwise defaults off', () => {
    expect(read('build.gradle')).toContain("buildConfigField 'boolean', 'CAPTURE_BACKUP_ENABLED', (System.getenv('EXPO_PUBLIC_CAPTURE_BACKUP_ENABLED') == 'true').toString()");
    expect(read('build.gradle')).toContain('buildFeatures { buildConfig true }');
  });

  it('blocks persisted workers before processing identities, authority or network requests', () => {
    const worker = kotlin('BackupWorker');
    const doWork = worker.slice(worker.indexOf('override fun doWork'), worker.indexOf('override fun onStopped'));
    expect(doWork.indexOf('if (!BuildConfig.CAPTURE_BACKUP_ENABLED)')).toBeLessThan(doWork.indexOf('inputData.getString'));
    expect(doWork).toContain('BackupCoordinator.stopDisabledBuild(applicationContext)');
    expect(doWork).toContain('return Result.success()');
    const engine = worker.slice(worker.indexOf('fun run(context:'));
    expect(engine.indexOf('if (!BuildConfig.CAPTURE_BACKUP_ENABLED)')).toBeLessThan(engine.indexOf('BackupStore.read'));
  });

  it('guards all native authorization/start entry points and both outbound transports', () => {
    const coordinator = kotlin('BackupCoordinator');
    for (const entry of ['configure', 'enqueue', 'resume']) {
      expect(coordinator).toMatch(new RegExp(`fun ${entry}\\([^\\n]+\\n\\s+requireEnabledBuild\\(context\\)`));
    }
    const schedule = coordinator.slice(coordinator.indexOf('fun schedule('));
    expect(schedule.indexOf('if (!BuildConfig.CAPTURE_BACKUP_ENABLED)')).toBeLessThan(schedule.indexOf('BackupStore.authority'));
    expect(kotlin('BackupTransport').match(/check\(BuildConfig\.CAPTURE_BACKUP_ENABLED\)/g)).toHaveLength(2);
  });

  it('revokes authority and cancels work without deleting retained originals or job metadata', () => {
    const coordinator = kotlin('BackupCoordinator');
    const stop = coordinator.slice(coordinator.indexOf('fun stopDisabledBuild'), coordinator.indexOf('private fun requireEnabledBuild'));
    expect(stop).toContain('BackupStore.clearAuthority(context)');
    expect(stop).toContain('cancelUniqueWork');
    expect(stop).not.toMatch(/BackupStore\.(?:save|update)|delete|remove/);
  });
});
