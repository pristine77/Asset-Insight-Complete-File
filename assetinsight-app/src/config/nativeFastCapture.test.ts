import fs from 'fs';
import path from 'path';
const root = path.resolve(__dirname, '../../modules/auction-camera/android/src/main/java/expo/modules/auctioncamera');
const engine = fs.readFileSync(path.join(root, 'viewextensions/CameraViewEngine.kt'), 'utf8');
const activity = fs.readFileSync(path.join(root, 'ui/camera/CameraViewActivity.kt'), 'utf8');
const pending = fs.readFileSync(path.join(root, 'viewextensions/PendingPhotoStore.kt'), 'utf8');

it('unlocks only after private frame fsync and durable metadata, never publishing a raw URI', () => {
  const publish = engine.slice(engine.indexOf('private fun publishCapturedFile('), engine.indexOf('private fun processCapturedFile('));
  expect(publish.indexOf('it.fd.sync()')).toBeLessThan(publish.indexOf('onCaptureSaved?.invoke'));
  expect(publish.indexOf('PendingPhotoStore.ready(frame)')).toBeLessThan(publish.indexOf('onCaptureSaved?.invoke'));
  expect(publish).toContain('onCaptureSaved?.invoke(frame.ticket); queueFrame(frame)');
  expect(engine).toContain('keepInput = true');
  expect(pending).toContain('receiver.commit(result)');
  expect(pending).toContain('PendingPhotoStore.acknowledge(frame)');
});
it('bounds capture backlog, serializes encodes and keeps each tap owner, lot, slot and settings', () => {
  expect(activity).toContain('PhotoWorkQueue.activeCount() >= 3');
  const controls = activity.slice(activity.indexOf('private fun onCaptureModeButtonTapped('), activity.indexOf('private fun fireCapture('));
  expect(controls.indexOf('if (captureInFlight.get()) return')).toBeLessThan(controls.indexOf('viewModel.setCaptureMode(mode)'));
  expect(engine).not.toContain('newFixedThreadPool(3)');
  expect(pending).toContain('Executors.newSingleThreadExecutor()');
  expect(activity).toContain('ticketMode = ticket.mode, ticketExtra = ticket.isExtra');
  expect(activity).toContain('captureGeneration == viewModel.repository.captureGeneration');
  expect(activity).toContain('saved + queuedShots.values.count');
  for (const field of ['format', 'highResolution', 'previewWidth', 'previewHeight', 'contrast', 'color', 'sharpness', 'crop']) {
    expect(engine).toContain(`"${field}"`);
  }
  expect(pending).toContain('listOf("ownerId", "draftId", "sessionId")');
  expect(pending).toContain('data.optInt("pid") == android.os.Process.myPid()');
  expect(engine).toContain('fun hasPendingPhotos() = captureIdentity?.let { PendingPhotoStore.pending(context, it, includeFailed = true).isNotEmpty() }');
  expect(engine).toContain('frame.data.has("result") || frame.data.optBoolean("failed")');
});
it('keeps standard quality bounds, performs at most two MozJPEG passes and preserves the high-resolution path', () => {
  const jpeg = engine.slice(engine.indexOf('// Preserve the high-resolution encoder'), engine.indexOf('ImageFormatStore.Format.WEBP -> {', engine.indexOf('// Preserve the high-resolution encoder')));
  expect(jpeg.match(/MozJpegEncoder\.encode\(/g)).toHaveLength(2);
  expect(jpeg).not.toContain('mozJpegQuality -= 4');
  expect(jpeg).toContain('if (use12MPOutput) null else');
  expect(engine).toContain('coerceIn(40, quality - 1)');
  expect(engine).toContain('STANDARD_PHOTO_MAX_SIDE = 2400');
  expect(engine).toContain('STANDARD_PHOTO_MAX_JPEG_BYTES = 200 * 1024');
  expect(activity).toContain('runCatching { sound?.play(MediaActionSound.SHUTTER_CLICK) }');
  expect(activity).toContain('MediaActionSound().apply { load(MediaActionSound.SHUTTER_CLICK) }');
  expect(activity).not.toContain('MediaActionSound.START_VIDEO_RECORDING');
  expect(activity).not.toContain('ToneGenerator');
});
