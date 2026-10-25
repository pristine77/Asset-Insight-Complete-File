package com.assetinsight.app

import android.content.ContentResolver
import android.content.Context
import android.content.ContextWrapper
import android.app.Instrumentation
import android.content.Intent
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Range
import android.view.Surface
import androidx.camera.video.Quality
import expo.modules.auctioncamera.CaptureJournal
import expo.modules.auctioncamera.utils.CameraVideoStorage
import expo.modules.auctioncamera.viewextensions.ListingVideoProfile
import expo.modules.auctioncamera.viewextensions.LotMode
import expo.modules.auctioncamera.viewextensions.LotRepository
import expo.modules.auctioncamera.viewextensions.CameraViewEngine
import expo.modules.auctioncamera.ui.camera.CameraViewActivity
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Isolated Android profile, gallery-original and restart/handoff assertions. */
object ListingVideoAssertions {
    @JvmStatic
    fun record(instrumentation: Instrumentation): String {
        val context = instrumentation.targetContext
        val owner = "video-recording-qa-${UUID.randomUUID()}"
        val draft = UUID.randomUUID().toString()
        val identity = JSONObject().put("ownerId", owner).put("draftId", draft)
            .put("sessionId", UUID.randomUUID().toString())
        val intent = Intent(context, CameraViewActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra("lot_payload_json", JSONObject().put("captureContext", identity).toString())
        val activity = instrumentation.startActivitySync(intent) as CameraViewActivity
        val completed = CountDownLatch(1)
        var recorded: Uri? = null
        var recordingError: String? = null
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                val engineField = CameraViewActivity::class.java.getDeclaredField("engine").apply { isAccessible = true }
                val engine = engineField.get(activity) as CameraViewEngine
                val onRecorded = engine.onVideoRecorded
                val onError = engine.onRecordingError
                val onStarted = engine.onVideoRecordingStarted
                engine.onVideoRecorded = { uri ->
                    check(engine.isStopping()) { "Final video handoff released its lot lock early" }
                    val saved = onRecorded?.invoke(uri) == true
                    recorded = uri
                    completed.countDown()
                    saved
                }
                engine.onRecordingError = { message ->
                    onError?.invoke(message)
                    recordingError = message
                    completed.countDown()
                }
                engine.onVideoRecordingStarted = {
                    onStarted?.invoke()
                    val repository = LotRepository.getInstance(context)
                    val lotId = repository.getActiveBuilder()?.id
                    val nextId = activity.resources.getIdentifier("imageRightArrow", "id", context.packageName)
                    val doneId = activity.resources.getIdentifier("textViewDone", "id", context.packageName)
                    activity.findViewById<android.view.View>(nextId).performClick()
                    activity.findViewById<android.view.View>(doneId).performClick()
                    check(!activity.isFinishing && repository.getActiveBuilder()?.id == lotId) { "Recording moved or closed its lot" }
                    Handler(Looper.getMainLooper()).postDelayed({
                        engine.stopRecording()
                        activity.findViewById<android.view.View>(nextId).performClick()
                        activity.findViewById<android.view.View>(doneId).performClick()
                        check(!activity.isFinishing && repository.getActiveBuilder()?.id == lotId) { "Finalizing moved or closed its lot" }
                    }, 5000)
                }
                val buttonId = activity.resources.getIdentifier("imageViewRecordVideo", "id", context.packageName)
                check(buttonId != 0)
                activity.findViewById<android.view.View>(buttonId).performClick()
            }
            check(completed.await(30, TimeUnit.SECONDS)) { "Camera recording never completed" }
            if (recordingError == ListingVideoProfile.UNSUPPORTED_MESSAGE) return "UNAVAILABLE: emulator does not support strict 720p/30fps recording"
            check(recordingError == null) { "Recording failed: $recordingError" }
            val uri = checkNotNull(recorded) { "No completed video URI" }
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(context, uri, null)
                val videoTrack = (0 until extractor.trackCount).first {
                    extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
                }
                val format = extractor.getTrackFormat(videoTrack)
                check(ListingVideoProfile.is720p(format.getInteger(MediaFormat.KEY_WIDTH), format.getInteger(MediaFormat.KEY_HEIGHT))) { "Encoded resolution is not 720p: $format" }
                // Android's MP4 extractor derives this integer from count/duration; it is
                // not the encoder's nominal configuration or capture-framerate metadata.
                val trackFps = if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) format.getNumber(MediaFormat.KEY_FRAME_RATE)?.toDouble() else null
                val metadata = MediaMetadataRetriever()
                val captureFps = try {
                    metadata.setDataSource(context, uri)
                    metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull()
                } finally { metadata.release() }
                check(captureFps == null || captureFps in 29.9..30.1) { "Capture-framerate metadata is $captureFps fps" }
                extractor.selectTrack(videoTrack)
                var count = 0
                var first = -1L
                var last = -1L
                while (extractor.sampleTime >= 0) {
                    val time = extractor.sampleTime
                    if (first < 0) first = time
                    last = time
                    count++
                    check(count <= 900) { "Unexpected unbounded recording fixture" }
                    extractor.advance()
                }
                check(count >= 30 && last > first) { "Recording is too short to verify cadence" }
                val measuredFps = (count - 1) * 1_000_000.0 / (last - first)
                check(measuredFps in 29.0..31.0) { "Encoded frame cadence was $measuredFps fps; $format" }
                val journal = CaptureJournal.read(context, owner, draft)!!
                check(journal.getJSONArray("lots").getJSONObject(0).getJSONObject("videoFile").getString("uri") == uri.toString())
                return "PASS: actual 720p MP4 recording, $count frames, ${"%.2f".format(measuredFps)} fps (track $trackFps, capture metadata ${captureFps ?: "not exposed"}), gallery URI, lot journal and recording/finalizing navigation locks"
            } finally {
                extractor.release()
            }
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            recorded?.let { uri ->
                if (uri.scheme == "content") context.contentResolver.delete(uri, null, null)
                else uri.path?.let { File(it).delete() }
            }
            CaptureJournal.read(context, owner, draft)?.let { journal ->
                CaptureJournal.acknowledge(context, owner, draft, journal.getString("sessionId"), journal.getLong("revision"))
            }
        }
    }

    @JvmStatic
    fun run(context: Context) {
        val profile = ListingVideoProfile
        check(profile.supports(listOf(Quality.HD), setOf(Range(30, 30))))
        check(!profile.supports(listOf(Quality.FHD, Quality.UHD), setOf(Range(30, 30))))
        check(!profile.supports(listOf(Quality.HD), setOf(Range(15, 30), Range(60, 60))))
        check(!profile.supports(listOf(Quality.HD), emptySet()))
        check(profile.is720p(1280, 720) && profile.is720p(720, 1280))
        check(!profile.is720p(1920, 1080) && !profile.is720p(640, 480))
        val capture = profile.buildCapture(Surface.ROTATION_90)
        check(capture.targetFrameRate == Range(30, 30))
        check(capture.targetRotation == Surface.ROTATION_90)
        check(capture.output.targetVideoEncodingBitRate == 5_000_000)
        check(runCatching { profile.requireBoundProfile(capture) }.isFailure)

        val owner = "video-qa-${UUID.randomUUID()}"
        val draft = UUID.randomUUID().toString()
        val session = UUID.randomUUID().toString()
        val identity = JSONObject().put("ownerId", owner).put("draftId", draft).put("sessionId", session)
        val repository = LotRepository.getInstance(context)
        repository.configureCapture(JSONObject().put("captureContext", identity).toString())
        repository.startNewLot(LotMode.SINGLE_LOT)
        val output = CameraVideoStorage.createOutputFile(context)
        val sibling = CameraVideoStorage.createOutputFile(context)
        val bytes = ByteArray(65_537) { (it % 251).toByte() }
        var gallery: Uri? = null
        try {
            output.writeBytes(bytes)
            sibling.writeText("unrelated original")
            check(output.parentFile == File(context.filesDir, "camera-videos"))
            repository.setVideo(Uri.fromFile(output))
            check(repository.isCapturePersisted())
            val pending = CaptureJournal.read(context, owner, draft)!!
            val originalLot = pending.getJSONArray("lots").getJSONObject(0)
            check(originalLot.getJSONObject("videoFile").getString("uri") == Uri.fromFile(output).toString())
            check(originalLot.getJSONArray("files").length() == 0)

            // Lost gallery permission keeps the original and its durable journal unchanged.
            val denied = object : ContextWrapper(context) {
                override fun getContentResolver(): ContentResolver = throw SecurityException("fixture denied")
            }
            check(CameraVideoStorage.publish(denied, output) == Uri.fromFile(output))
            check(output.readBytes().contentEquals(bytes))

            gallery = CameraVideoStorage.publish(context, output)
            check(gallery.scheme == "content") { "Fixture gallery publication failed" }
            check(output.exists()) { "Original removed before journal handoff" }
            check(context.contentResolver.openInputStream(gallery)!!.use { it.readBytes() }.contentEquals(bytes))
            CameraVideoStorage.acknowledgeGalleryHandoff(context, output, gallery, false)
            check(output.exists()) { "Unacknowledged handoff deleted the original" }
            repository.setVideo(gallery)
            val final = CaptureJournal.read(context, owner, draft)!!
            val finalLot = final.getJSONArray("lots").getJSONObject(0)
            check(finalLot.getString("id") == originalLot.getString("id"))
            check(finalLot.getJSONObject("videoFile").getString("uri") == gallery.toString())
            check(finalLot.getJSONArray("files").length() == 0)
            CameraVideoStorage.acknowledgeGalleryHandoff(context, output, gallery, repository.isCapturePersisted())
            check(!output.exists() && sibling.exists()) { "Cleanup removed the wrong original" }
            check(context.contentResolver.openInputStream(gallery)!!.use { it.readBytes() }.contentEquals(bytes))
            check(!CaptureJournal.acknowledge(context, owner, draft, session, pending.getLong("revision")))
            check(CaptureJournal.acknowledge(context, owner, draft, session, final.getLong("revision")))
        } finally {
            gallery?.takeIf { it.scheme == "content" }?.let { context.contentResolver.delete(it, null, null) }
            output.delete()
            sibling.delete()
            repository.configureCapture(null)
        }
    }
}
