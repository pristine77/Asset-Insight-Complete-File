/**
 * Android standard capture uses the supplied 2400 px / 200 KiB MozJPEG policy.
 * iOS/JS retains 3000 px / JPEG 95; high-resolution Android remains 6000 px.
 * Targets are not hard caps. There is no Kotlin test runner here, so the
 * native source is pinned here, as nativeCaptureWatermark.test.ts does.
 */
import fs from 'node:fs';
import path from 'node:path';

const engine = fs
  .readFileSync(
    path.join(
      path.resolve(__dirname, '../..'),
      'modules/auction-camera/android/src/main/java/expo/modules/auctioncamera/viewextensions/CameraViewEngine.kt'
    ),
    'utf8'
  )
  .replace(/\r\n/g, '\n');

/** Code only: line comments removed, so a comment cannot satisfy a check. */
const code = engine
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n');

function section(start: string, end: string): string {
  const startIndex = code.indexOf(start);
  const endIndex = code.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return code.slice(startIndex, endIndex);
}

describe('Android standard photo size', () => {
  it('uses the optimized Android dimensions and per-format encoding targets', () => {
    expect(code).toContain('internal const val STANDARD_PHOTO_MAX_SIDE = 2400');
    expect(code).toContain('internal const val STANDARD_PHOTO_MAX_JPEG_BYTES = 200 * 1024');
    expect(code).toContain('internal const val STANDARD_PHOTO_MAX_OTHER_BYTES = 300 * 1024');
    expect(code).not.toContain('STANDARD_PHOTO_MAX_WIDTH');
    expect(code).not.toContain('STANDARD_PHOTO_MAX_HEIGHT');
  });

  it('fits inside the box with the same arithmetic as the JS camera', () => {
    const fit = section('internal fun fitInsideBox(', 'class CameraViewEngine(');
    expect(fit).toContain('if (width <= 0 || height <= 0) return Pair(width, height)');
    expect(fit).toContain('val scale = minOf(1.0, boxWidth.toDouble() / width, boxHeight.toDouble() / height)');
    expect(fit).toContain('if (scale >= 1.0) return Pair(width, height)');
    expect(fit).toContain('Math.round(width * scale).toInt().coerceAtLeast(1)');
    expect(fit).toContain('Math.round(height * scale).toInt().coerceAtLeast(1)');
  });

  it('applies the box and the target to every captured photo, and keeps the 12 MP option', () => {
    const processing = section('private fun processCapturedFile(', 'private fun applyBitmapEffects(');
    expect(processing).toContain(
      'fitInsideBox(bitmap.width, bitmap.height, STANDARD_PHOTO_MAX_SIDE, STANDARD_PHOTO_MAX_SIDE)'
    );
    expect(processing).toContain('fitInsideBox(bitmap.width, bitmap.height, 6000, 6000)');
    expect(processing).toContain('fmt == ImageFormatStore.Format.JPEG -> STANDARD_PHOTO_MAX_JPEG_BYTES');
    expect(processing).toContain('else -> STANDARD_PHOTO_MAX_OTHER_BYTES');
    expect(processing).toContain('use12MPOutput -> 1 * 1024 * 1024');
    expect(processing).toContain('var mozJpeg = if (use12MPOutput) null else');
    expect(processing).toContain('MozJpegEncoder.encode(bitmap, mozJpegQuality)');
    expect(processing).toContain('mozJpeg.size > TARGET_SIZE_BYTES && mozJpegQuality > 40');
    // Retain the original Android fallback and high-resolution quality ladder.
    expect(processing).toContain('var currentQuality = 95');
    expect(processing).toContain('while (stream.size() > TARGET_SIZE_BYTES && currentQuality > 50)');
    expect(processing).toContain('currentQuality -= 10');
    // Resized before the watermark is drawn, so the logo is sized to the final photo.
    expect(processing.indexOf('STANDARD_PHOTO_MAX_SIDE)')).toBeLessThan(
      processing.indexOf('CameraPhotoWatermark.stamp(context, bitmap)')
    );
  });
});
