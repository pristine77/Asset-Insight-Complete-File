package com.assetinsight.app;

import android.app.Instrumentation;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Bundle;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;
import expo.modules.auctioncamera.utils.CameraPhotoWatermark;
import expo.modules.auctioncamera.utils.PhotoWatermarkReceipt;

/** Offline native-pixel/receipt smoke test. No login, API calls or report writes. */
public class PhotoWatermarkInstrumentation extends Instrumentation {
    private boolean videoOnly;
    private boolean recordVideo;
    private boolean cameraHandoffOnly;
    private boolean uploadOnly;
    private boolean cameraLayoutOnly;
    private boolean singleLineCameraOnly;
    private boolean fixedCameraOnly;
    private boolean mozJpegOnly;
    private boolean cameraOpeningOnly;
    private boolean restoreAfterDeath;
    private String cameraBurstPhase;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        videoOnly = arguments != null && "true".equals(arguments.getString("videoOnly"));
        recordVideo = arguments != null && "true".equals(arguments.getString("recordVideo"));
        cameraHandoffOnly = arguments != null && "true".equals(arguments.getString("cameraHandoffOnly"));
        uploadOnly = arguments != null && "true".equals(arguments.getString("uploadOnly"));
        cameraLayoutOnly = arguments != null && "true".equals(arguments.getString("cameraLayoutOnly"));
        singleLineCameraOnly = arguments != null && "true".equals(arguments.getString("singleLineCameraOnly"));
        fixedCameraOnly = arguments != null && "true".equals(arguments.getString("fixedCameraOnly"));
        mozJpegOnly = arguments != null && "true".equals(arguments.getString("mozJpegOnly"));
        cameraOpeningOnly = arguments != null && "true".equals(arguments.getString("cameraOpeningOnly"));
        restoreAfterDeath = arguments != null && "true".equals(arguments.getString("restoreAfterDeath"));
        cameraBurstPhase = arguments != null ? arguments.getString("cameraBurstPhase") : null;
        start();
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (singleLineCameraOnly) {
                CameraLayoutAssertions.run(this);
                CameraSingleLineAssertions.INSTANCE.run(this);
                result.putString("stream", "PASS: physical Samsung one-line camera header, EV disclosure and capture auto-hide, three sandbox photos, hardware shutter, rotation and Done.");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (cameraBurstPhase != null) {
                CameraBurstAssertions.INSTANCE.run(this, cameraBurstPhase);
                result.putString("stream", "PASS: bounded three-shot capture while JPEG processing is blocked, durable raw recovery, exact ordered main/extra routing, snapshot settings, no raw report handoff, watermark receipts, Done/Next guards and failure recovery; phase=" + cameraBurstPhase);
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (cameraOpeningOnly) {
                CameraPayloadAssertions.run(getTargetContext());
                CameraOpeningAssertions.INSTANCE.run(this, restoreAfterDeath);
                if (restoreAfterDeath) CameraBridgeOpeningAssertions.INSTANCE.run(this);
                result.putString("stream", "PASS: startup/return deadlines, late-cancel fencing, request identities, repeated 30-lot/324-photo opens, exact missing-callback receipt recovery and durable pending journal; process-restart recovery=" + restoreAfterDeath);
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (mozJpegOnly) {
                MozJpegCameraAssertions.run(this);
                result.putString("stream", "PASS: MozJPEG JNI, progressive JPEG/ICC, colour channels, encoder error recovery, concurrent encodes, standard sizing, EXIF rotation/crop, watermark receipts and retained high-resolution output.");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (fixedCameraOnly) {
                FixedLotCameraAssertions.run(this);
                ListingVideoAssertions.run(getTargetContext());
                CameraLayoutAssertions.run(this);
                result.putString("stream", "PASS: native fixed-lot controls, stable identities/modes/order, scoped photo/video deletion with empty rows, bounded navigation, pending journal validation/recreation and unchanged 720p controls.");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (cameraLayoutOnly) {
                CameraLayoutAssertions.run(this);
                ListingVideoAssertions.run(getTargetContext());
                result.putString("stream", "PASS: one-line compact header at 100/130/200% font, EV disclosure, no clipping/overlap, 48dp action targets, viewport resize and strict HD/30fps video policy.");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (uploadOnly) {
                ContentUriUploaderAssertions.run(getTargetContext());
                result.putString("stream", "PASS: native MediaStore HTTPS byte/length/progress integrity, four-worker bound, prompt queued/active cancellation, stalled writes/receipt deadline, one settlement and worker recovery.");
                finish(Activity.RESULT_OK, result);
                return;
            }
            CameraPayloadAssertions.run(getTargetContext());
            if (cameraHandoffOnly) {
                result.putString("stream", "PASS: 19-lot/254-photo and 5,000-photo metadata handoffs, sub-512-byte activity Intents, exact ordered round trips, recreation, missing/mismatched receipt rejection, storage failure and durable-journal preservation.");
                finish(Activity.RESULT_OK, result);
                return;
            }
            ListingVideoAssertions.run(getTargetContext());
            if (videoOnly) {
                String recording = recordVideo ? ListingVideoAssertions.record(this) : "Actual camera capture not requested.";
                result.putString("stream", "PASS: strict HD/30fps/5Mbps profile, unsupported capability policy, durable video/gallery references, denied-gallery fallback and revision-bound journal cleanup. " + recording);
                finish(Activity.RESULT_OK, result);
                return;
            }
            CaptureJournalAssertions.run(getTargetContext());
            ContentUriUploaderAssertions.run(getTargetContext());
            File directory = new File(getTargetContext().getExternalFilesDir(null), "watermark-qa");
            directory.mkdirs();
            for (String type : new String[]{"jpeg", "webp"}) {
                Bitmap source = Bitmap.createBitmap(1000, 800, Bitmap.Config.ARGB_8888);
                source.eraseColor(Color.LTGRAY);
                Bitmap stamped = CameraPhotoWatermark.INSTANCE.stamp(getTargetContext(), source);
                check(stamped.getPixel(50, 50) == Color.LTGRAY, "Stamp changed pixels outside the logo region");
                int changed = 0;
                for (int y = 500; y < 780; y++) for (int x = 700; x < 990; x++) {
                    if (stamped.getPixel(x, y) != Color.LTGRAY) changed++;
                }
                check(changed > 300, "No visible camera logo");
                ByteArrayOutputStream stream = new ByteArrayOutputStream();
                stamped.compress(type.equals("jpeg") ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.WEBP, 90, stream);
                stamped.recycle();
                byte[] original = stream.toByteArray();
                byte[] marked = PhotoWatermarkReceipt.INSTANCE.add(original);
                check(PhotoWatermarkReceipt.INSTANCE.has(marked), "Receipt did not verify");
                check(Arrays.equals(marked, PhotoWatermarkReceipt.INSTANCE.add(marked)), "Receipt applied twice");
                Bitmap decoded = BitmapFactory.decodeByteArray(marked, 0, marked.length);
                check(decoded != null && decoded.getWidth() == 1000 && decoded.getHeight() == 800, "Native decoder rejected marked photo");
                decoded.recycle();
                Files.write(new File(directory, "camera." + type).toPath(), marked);
                Files.write(new File(directory, "encoded-without-receipt." + type).toPath(), original);
            }
            result.putString("stream", "PASS: native ContentURI HTTPS exact bytes/length/progress, active and queued cancellation, four-worker bound, capture journal revisions, JPEG/WebP logo pixels, receipt idempotency and Android decoding. Fixtures: " + directory);
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            android.util.Log.e("AssetInsightCameraTest", "Native instrumentation check failed", error);
            result.putString("stream", "FAIL: " + android.util.Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
