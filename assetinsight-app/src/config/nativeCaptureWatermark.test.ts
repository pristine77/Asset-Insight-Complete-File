import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_IMAGE_WATERMARK,
  restoreImageWatermarkPreference,
} from '../utils/watermarkPreference';

const projectRoot = path.resolve(__dirname, '../..');
const engine = fs.readFileSync(
  path.join(
    projectRoot,
    'modules/auction-camera/android/src/main/java/expo/modules/auctioncamera/viewextensions/CameraViewEngine.kt'
  ),
  'utf8'
);

function engineSection(start: string, end: string): string {
  const startIndex = engine.indexOf(start);
  const endIndex = engine.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return engine
    .slice(startIndex, endIndex)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('native capture watermark ownership', () => {
  it('always stamps camera photos once, separately from upload preferences', () => {
    expect(engine.match(/CameraPhotoWatermark\.stamp\(context, bitmap\)/g)).toHaveLength(1);
    expect(engine).not.toContain('watermark_images');
    expect(engine).not.toContain('watermarkImages');
  });

  it.each([
    ['private fun captureToFile(', 'private fun captureBokeh('],
    ['private fun captureBokeh(', 'private fun captureNight('],
    ['private fun captureNight(', 'fun startRecording()'],
  ])('publishes only fully processed camera photos for %s', (start, end) => {
    const capture = engineSection(start, end);
    expect(capture).toContain('imageCapture.takePicture(');
    expect(capture).toContain('publishCapturedFile(tempFile');
    expect(capture).not.toContain('onPhotoCaptured?.invoke(tempUri)');
    expect(capture).not.toContain('onNightModeUriReady?.invoke(');
  });

  it('preserves the capture output, EXIF, gallery handoff, and photo replacement order', () => {
    const processing = engineSection(
      'private fun processCapturedFile(',
      'private fun applyBitmapEffects('
    );
    const expectedSteps = [
      'CameraPhotoWatermark.stamp(context, bitmap)',
      'outputFile.outputStream()',
      'copyExifAttributes(originalExif, newExif)',
      'PhotoWatermarkReceipt.add(outputFile.readBytes())',
      'saveToUserGallery(outputFile, mimeType)',
      'return ProcessedCapture(',
    ];
    let previousIndex = -1;
    for (const step of expectedSteps) {
      const index = processing.indexOf(step);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it.each(['AssetFormSheet.tsx', 'LotListingFormSheet.tsx'])(
    '%s sends the user-selected watermark opt-in to the backend',
    (filename) => {
      const form = fs.readFileSync(
        path.join(projectRoot, 'src/components/forms', filename),
        'utf8'
      );
      expect(DEFAULT_IMAGE_WATERMARK).toBe(false);
      expect(restoreImageWatermarkPreference(false)).toBe(false);
      expect(restoreImageWatermarkPreference(true)).toBe(true);
      expect(form).toContain('useState(continuation?.watermarkImages ?? DEFAULT_IMAGE_WATERMARK)');
      expect(form).toContain('setWatermarkImages((prev) => !prev)');
      expect(form).toContain('watermark_images: watermarkImages');
      expect(form).toContain('For imported, unwatermarked photos only.');
    }
  );

  it('protects edited stamped photos and both the native Done and fallback capture handoff', () => {
    const nativeRoot = path.join(projectRoot, 'modules/auction-camera/android/src/main/java/expo/modules/auctioncamera');
    const edit = fs.readFileSync(path.join(nativeRoot, 'viewextensions/ImageEditDialog.kt'), 'utf8');
    expect(edit).toContain('PhotoWatermarkReceipt.has(');
    expect(edit).toContain('if (alreadyStamped)');
    expect(edit).not.toContain('CameraPhotoWatermark.stamp(');
    const activity = fs.readFileSync(path.join(nativeRoot, 'ui/camera/CameraViewActivity.kt'), 'utf8');
    expect(activity).toContain('if (captureInFlight.get() || processingCount > 0)');
    const fallback = fs.readFileSync(path.join(projectRoot, 'src/components/camera/CameraScreen.tsx'), 'utf8');
    expect(fallback.indexOf('await stampCameraPhoto(rawUri)')).toBeLessThan(fallback.indexOf('updateLotsWithCapturedPhoto(photo,'));
    expect(fallback).toContain('if (captureInFlight.current) return;');
    expect(fallback).toContain('captureInFlight.current = false;');
    for (const handler of ['handlePrevLot', 'handleNextLot']) {
      expect(fallback.slice(fallback.indexOf(`const ${handler} =`))).toMatch(/captureInFlight\.current[\s\S]*?Please wait for the photo/);
    }
  });
});
