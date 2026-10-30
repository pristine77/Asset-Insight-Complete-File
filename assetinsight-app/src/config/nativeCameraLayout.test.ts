import fs from 'node:fs';
import path from 'node:path';
const main = path.resolve(__dirname, '../../modules/auction-camera/android/src/main');
const read = (file: string) => fs.readFileSync(path.join(main, file), 'utf8');

describe('native camera reference layout and protected capture behaviour', () => {
  it('keeps the compact portrait header and footer unchanged', () => {
    const portrait = read('res/layout/activity_camera_view.xml');
    expect(portrait).toContain('viewextensions.CameraPortraitFooterLayout');
    expect(portrait).toContain('viewextensions.CameraHeaderLayout');
    expect(portrait).not.toContain('zoomToggle');
    const header = read('java/expo/modules/auctioncamera/viewextensions/CameraHeaderLayout.kt');
    expect(header).toContain('exposureAvailable && !landscape && exposureWidth >= inlineMinimum');
    expect(header).toContain('mainRow = listOfNotNull');
    const footer = read('java/expo/modules/auctioncamera/viewextensions/CameraPortraitFooterLayout.kt');
    expect(footer).toContain('resolveSize(dp(120), heightMeasureSpec)');
  });
  it('keeps all reference landscape controls and removes the former active disclosure layout', () => {
    const xml = read('res/layout-land/activity_camera_view.xml');
    for (const id of ['linearLayoutLot', 'textViewSetViews', 'includeMainExtra', 'topBar', 'btnProMode',
      'btnFlash', 'btnFocus', 'evContainer', 'evSeekBar', 'zoomPanel', 'zoom06', 'zoom1', 'zoom2', 'zoom4', 'buttonFrontCamera']) {
      expect(xml).toContain('android:id="@+id/' + id + '"');
    }
    expect(xml).toContain('android:orientation="vertical"');
    expect(xml).not.toContain('<ScrollView');
    expect(xml).not.toContain('<GridLayout');
    const header = read('java/expo/modules/auctioncamera/viewextensions/CameraHeaderLayout.kt');
    expect(header).toContain('if (landscape) return // Reference landscape has a permanently visible exposure panel.');
  });
  it('locks the owner-approved Pristine rail geometry without reflow or scrolling', () => {
    const rail = read('java/expo/modules/auctioncamera/viewextensions/CameraActionLayout.kt');
    for (const geometry of ['R.id.galleryPreviewContainer, 34, 34, 12', 'R.id.imageViewRecordVideo, 34, 34, 12',
      'R.id.textViewBundle, 70, 55, 54', 'R.id.textViewItem, 70, 55, 115',
      'R.id.textViewPhoto, 70, 55, 176',
      'R.id.imageLeftArrow, 42, 40, 240', 'R.id.imageRightArrow, 42, 40, 240',
      'R.id.textViewDone, 90, 30, 285']) expect(rail).toContain(geometry);
    expect(rail).toContain('val x = unit(7f) + when');
    expect(rail).not.toContain('intArrayOf(R.id.textViewBundleExtra');
    const extra = read('res/layout-land/activity_camera_view.xml').split('\n').find((line) => line.includes('@+id/textViewBundleExtra'));
    expect(extra).toContain('android:visibility="gone"');
    expect(rail).not.toContain('val plans');
    expect(rail).not.toContain('fontScale');
    const viewport = read('java/expo/modules/auctioncamera/viewextensions/CameraViewportLayout.kt');
    expect(viewport).toContain('preview.top + u(16f)');
    expect(viewport).toContain('preview.top + u(56f)');
    expect(viewport).toContain('preview.top + u(86f)');
    expect(viewport).toContain('preview.width - zoom.measuredWidth');
    expect(viewport).toContain('bottomScale = minOf(1f');
  });
  it('restores the visible status bar shown in the latest landscape reference', () => {
    const activity = read('java/expo/modules/auctioncamera/ui/camera/CameraViewActivity.kt');
    const bars = activity.slice(activity.indexOf('private fun hideLandscapeSystemBars()'), activity.indexOf('override fun onSaveInstanceState'));
    expect(bars).toContain('show(WindowInsetsCompat.Type.statusBars())');
    expect(bars).toContain('hide(WindowInsetsCompat.Type.navigationBars())');
    expect(activity).toContain('binding.root.resources.configuration.orientation');
  });
  it('matches supplied component capture feedback without a loading dialog', () => {
    const activity = read('java/expo/modules/auctioncamera/ui/camera/CameraViewActivity.kt');
    expect(activity).not.toContain('processingIndicator');
    expect(activity).not.toContain('android.widget.ProgressBar');
    expect(activity).not.toContain('⏳');
    expect(activity).not.toContain('Saving photos');
    expect(activity).toContain('"alpha", 1f, 0.4f');
    expect(activity).toMatch(/duration\s*=\s*600/);
    const capture = activity.slice(activity.indexOf('private fun fireCapture('), activity.indexOf('private fun applyCaptureModeUI('));
    expect(capture).not.toContain('startThumbnailPulse');
    expect(capture).toContain('freezePreviewFrame()');
    const saved = activity.slice(activity.indexOf('engine.onCaptureSaved ='), activity.indexOf('engine.onQueuedPhotoReady ='));
    expect(saved).toContain('releaseShutter(ticket)');
    expect(saved).toContain('startThumbnailPulse()');
    expect(capture).toContain('engine.capturePhoto(ticket)');
  });

  it.each(['layout', 'layout-land'])('retains recording and Done controls in %s', (layout) => {
    const xml = read(`res/${layout}/activity_camera_view.xml`);
    for (const id of ['imageViewRecordVideo', 'textViewDone', 'galleryVideoBadge']) {
      expect(xml).toContain(`android:id="@+id/${id}"`);
    }
  });

  it('keeps the strict 720p/30fps native recording profile', () => {
    const profile = read('java/expo/modules/auctioncamera/viewextensions/ListingVideoProfile.kt');
    expect(profile).toContain('const val FRAMES_PER_SECOND = 30');
    expect(profile).toContain('QualitySelector.from(Quality.HD)');
    expect(profile).toContain('.setTargetFrameRate(frameRate)');
    expect(profile).toContain('minOf(width, height) == 720 && maxOf(width, height) == 1280');
    const engine = read('java/expo/modules/auctioncamera/viewextensions/CameraViewEngine.kt');
    expect(engine).toContain('ListingVideoProfile.buildCapture(currentRotation)');
    expect(engine).toContain('ListingVideoProfile.requireBoundProfile(videoCapture)');
  });
});
