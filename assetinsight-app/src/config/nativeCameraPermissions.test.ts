import fs from 'node:fs';
import path from 'node:path';

const nativeRoot = path.resolve(
  __dirname,
  '../../modules/auction-camera/android/src/main/java/expo/modules/auctioncamera'
);
const activity = fs.readFileSync(path.join(nativeRoot, 'ui/camera/CameraViewActivity.kt'), 'utf8');
const engine = fs.readFileSync(path.join(nativeRoot, 'viewextensions/CameraViewEngine.kt'), 'utf8');

function activitySection(start: string, end: string): string {
  const startIndex = activity.indexOf(start);
  const endIndex = activity.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return activity.slice(startIndex, endIndex);
}

describe('native camera permission contract', () => {
  it('requests optional video audio but requires only camera and legacy photo storage', () => {
    const requested = activitySection(
      'private val requestedPerms',
      'private fun hasCapturePermissions'
    );
    expect(requested).toContain('Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO');
    expect(requested).toContain('Build.VERSION.SDK_INT <= Build.VERSION_CODES.P');
    expect(requested).toContain('add(Manifest.permission.WRITE_EXTERNAL_STORAGE)');
    expect(requested).toContain(
      'get() = requestedPerms.filterNot { it == Manifest.permission.RECORD_AUDIO }'
    );
    const permissions = activitySection(
      'private fun hasCapturePermissions',
      'private fun getCurrentDisplayRotationSafe'
    );
    expect(permissions).toContain('captureRequiredPerms.all');
    expect(permissions).toContain('checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED');
  });

  it('opens photo preview even when the optional microphone prompt is needed', () => {
    const creation = activitySection('override fun onCreate', 'private fun setupEdgeToEdge');
    expect(creation).toContain('if (hasCapturePermissions()) startCamera()');
    expect(creation).toContain('requestPermissions(requestedPerms, 1001)');
    expect(creation).not.toContain('requestedPerms.all');
  });

  it('rechecks actual grants and closes an uninitialized preview when permission is cancelled or denied', () => {
    const callback = activitySection(
      'override fun onRequestPermissionsResult',
      'private fun observeViewModel'
    );
    expect(callback).toContain('if (rc != 1001) return');
    expect(callback).toContain('if (results.isEmpty())');
    expect(callback).toContain('if (!::engine.isInitialized || !hasCapturePermissions())');
    expect(callback).toContain('if (hasCapturePermissions())');
    expect(callback).toContain('finish()');
    expect(callback).not.toContain('results.all');
  });

  it('does not recreate the engine after an optional permission callback', () => {
    const startup = activitySection(
      'private fun startCamera()',
      'override fun onConfigurationChanged'
    );
    expect(startup).toContain(
      'if (::engine.isInitialized || !hasCapturePermissions() || isFinishing || isDestroyed) return'
    );
    expect(startup.indexOf('::engine.isInitialized')).toBeLessThan(
      startup.indexOf('engine = CameraViewEngine')
    );
  });

  it('keeps denial and rotation lifecycle paths safe before engine initialization', () => {
    const pause = activitySection('override fun onPause()', 'override fun onDestroy()');
    expect(pause.indexOf('if (!::engine.isInitialized) return')).toBeLessThan(
      pause.indexOf('engine.pause()')
    );
    const destroy = activitySection(
      'override fun onDestroy()',
      'override fun onRequestPermissionsResult'
    );
    expect(destroy).toContain('if (::engine.isInitialized) engine.shutdown()');
    const restore = activitySection(
      'private fun restoreUiState()',
      'private fun applyPreviewLayerFilter'
    );
    expect(restore).toContain('val proAllowed = ::engine.isInitialized && !engine.isFrontCamera()');
    const exposure = activitySection('private fun syncEVSeekBar', 'private fun updateEVLabel');
    expect(exposure).toContain('if (!::engine.isInitialized || isUserDraggingEV) return');
  });

  it('enables video audio only when microphone permission is granted', () => {
    expect(engine).toMatch(
      /checkSelfPermission\(\s*context, Manifest\.permission\.RECORD_AUDIO\s*\) == PackageManager\.PERMISSION_GRANTED\s*\) withAudioEnabled\(\)/
    );
  });
});
