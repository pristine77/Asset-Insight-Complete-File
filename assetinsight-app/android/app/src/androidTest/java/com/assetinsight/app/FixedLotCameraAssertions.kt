package com.assetinsight.app

import android.app.Application
import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.view.KeyEvent
import android.widget.TextView
import expo.modules.auctioncamera.CameraPayloadStore
import expo.modules.auctioncamera.CaptureJournal
import expo.modules.auctioncamera.CaptureMode
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.ui.camera.CameraViewActivity
import expo.modules.auctioncamera.viewextensions.CameraViewModel
import expo.modules.auctioncamera.viewextensions.CameraViewEngine
import expo.modules.auctioncamera.viewextensions.LotMode
import expo.modules.auctioncamera.viewextensions.LotRepository
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Exercises native code/controls with isolated fixture identities, never a customer account. */
object FixedLotCameraAssertions {
    private fun onMain(instrumentation: Instrumentation, block: () -> Unit) {
        var failure: Throwable? = null
        instrumentation.runOnMainSync { try { block() } catch (error: Throwable) { failure = error } }
        failure?.let { throw it }
    }

    private fun payload(): JSONObject = JSONObject()
        .put("lockedStructure", true).put("activeLotNumber", 1)
        .put("sourceLabels", JSONArray(listOf("Lot 157-A", "Lot 2500", "Lot 99")))
        .put("captureContext", JSONObject().put("ownerId", "fixed-camera-qa-${UUID.randomUUID()}")
            .put("draftId", UUID.randomUUID().toString()).put("sessionId", UUID.randomUUID().toString()))
        .put("lots", JSONArray().also { rows ->
            for ((index, mode) in listOf("single_lot", "per_item", "per_photo").withIndex()) {
                rows.put(JSONObject().put("id", "fixed-${index + 1}").put("lotNumber", index + 1)
                    .put("mode", mode).put("files", JSONArray()).put("extraFiles", JSONArray()).put("coverIndex", 0))
            }
        })

    private fun reject(block: () -> Unit) {
        var rejected = false
        try { block() } catch (_: Exception) { rejected = true }
        check(rejected) { "A fixed-lot boundary accepted an unsafe mutation" }
    }

    private fun assertRows(repository: LotRepository) {
        val rows = repository.getEffectiveLots()
        check(rows.map { it.id } == listOf("fixed-1", "fixed-2", "fixed-3"))
        check(rows.map { it.lotNumber } == listOf(1, 2, 3))
        check(rows.map { it.mode } == listOf(LotMode.SINGLE_LOT, LotMode.PER_ITEM, LotMode.PER_PHOTO))
    }

    @JvmStatic fun run(instrumentation: Instrumentation) {
        val context = instrumentation.targetContext
        val repository = LotRepository.getInstance(context)
        val file = File(context.cacheDir, "fixed-camera-qa-${UUID.randomUUID()}.jpg")
        val bitmap = Bitmap.createBitmap(12, 10, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GRAY) }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        bitmap.recycle()
        val uri = Uri.fromFile(file)
        val video = Uri.parse("file://${context.cacheDir}/fixed-camera-fixture.mp4")
        val input = payload()
        val owner = input.getJSONObject("captureContext").getString("ownerId")
        val draft = input.getJSONObject("captureContext").getString("draftId")
        try {
            onMain(instrumentation) {
                repository.clearLotsOnly()
                val vm = CameraViewModel(context.applicationContext as Application)
                repository.configureCapture(input.toString())
                vm.loadFromPayload(input.toString())
                assertRows(repository)
                check(vm.activeLotLabel.value == "Lot 157-A")
                vm.goToPrevLot()
                check(vm.currentLotNumber.value == 1)
                check(!vm.requestCapture(CaptureMode.ITEM))
                vm.setCaptureMode(CaptureMode.PHOTO)
                vm.handleNewLotFromLock(CaptureMode.ITEM)
                vm.handleNewLotFromMismatch(CaptureMode.PHOTO)
                check(vm.captureMode.value == CaptureMode.BUNDLE)
                check(vm.requestCapture(CaptureMode.BUNDLE))
                vm.onPhotoCaptured(uri)
                repository.prepareLotForEditing(1)
                vm.setInitialLotNumber(1)
                check(vm.mainCount.value == 1 && repository.getEffectiveLots().sumOf { it.files.size } == 1)
                vm.onVideoRecorded(video)
                check(repository.getEffectiveLots()[0].videoFile?.uri == video.toString())
                vm.goToNextLot()
                check(vm.activeLotLabel.value == "Lot 2500" && vm.captureMode.value == CaptureMode.ITEM)
                check(vm.requestCapture(CaptureMode.ITEM))
                vm.onPhotoCaptured(uri) // A shared original must remain scoped to this row.
                vm.deleteMedia(uri, 1)
                check(repository.getEffectiveLots()[0].files.isEmpty())
                check(repository.getEffectiveLots()[1].files.size == 1)
                vm.deleteMedia(video, 1)
                check(repository.getEffectiveLots()[0].videoFile == null)
                check(repository.getEffectiveLots().size == 3) // Last media never removes the imported row.
                vm.confirmNextLot()
                check(vm.currentLotNumber.value == 3 && vm.captureMode.value == CaptureMode.PHOTO)
                vm.goToNextLot(); vm.confirmNextLot()
                check(vm.currentLotNumber.value == 3)
                assertRows(repository)
                reject { repository.startNewLot(LotMode.SINGLE_LOT) }
                reject { repository.prepareLotForEditing(4) }
                reject { repository.updateExistingLotMode(3, LotMode.PER_ITEM) }
                reject { repository.finaliseCurrentLot(2) }
                reject { repository.clearAllSync() }
                check(file.exists())
                val changed = JSONObject(input.toString())
                changed.getJSONArray("lots").getJSONObject(1).put("id", "wrong-id")
                reject { repository.replaceData(changed.toString()) }
                assertRows(repository)
                repository.saveSessionWithActiveSync(3)
                val before = checkNotNull(CaptureJournal.read(context, owner, draft))
                check(before.getJSONObject("session").getBoolean("lockedStructure"))
                check(before.getJSONObject("session").getJSONArray("sourceLabels").getString(1) == "Lot 2500")
                // Recreation/reopen restores fixed state, media and selected position.
                repository.configureCapture(input.toString())
                check(vm.restoreSessionIfAvailable())
                check(vm.currentLotNumber.value == 3)
                assertRows(repository)
                check(repository.getEffectiveLots()[1].files.size == 1)
                val unlocked = JSONObject(input.toString()).put("lockedStructure", false)
                reject { repository.configureCapture(unlocked.toString()) }
                reject { repository.configureCapture(changed.toString()) }
                val duplicate = JSONObject(input.toString())
                duplicate.getJSONArray("lots").getJSONObject(1).put("id", "fixed-1")
                reject { repository.configureCapture(duplicate.toString()) }
                check(CaptureJournal.read(context, owner, draft).toString() == before.toString())
                // A fixed manifest cannot validate a tampered completed-row order or mode.
                val damagedSession = JSONObject(before.getJSONObject("session").toString())
                damagedSession.getJSONArray("completedLots").getJSONObject(0).put("mode", "per_photo")
                CaptureJournal.save(context, input.getJSONObject("captureContext"), damagedSession, before.getJSONArray("lots"))
                repository.configureCapture(input.toString())
                reject { repository.restoreSessionFromCache() }
                check(CaptureJournal.read(context, owner, draft)!!.getJSONObject("session").toString() == damagedSession.toString())
                repository.clearLotsOnly()
                // A pre-fix/unlocked pending journal must not overwrite a new fixed structure.
                val old = payload()
                val identity = old.getJSONObject("captureContext")
                CaptureJournal.save(context, identity, JSONObject().put("activeLotNumber", 1), old.getJSONArray("lots"))
                reject { repository.configureCapture(old.toString()) }
                val limited = payload()
                val row = limited.getJSONArray("lots").getJSONObject(0)
                val photo = JSONObject().put("uri", uri.toString()).put("name", "fixture.jpg")
                    .put("width", 12).put("height", 10).put("megapixels", 0.0)
                repeat(198) { row.getJSONArray("files").put(JSONObject(photo.toString())) }
                row.getJSONArray("extraFiles").put(photo)
                repository.configureCapture(limited.toString())
                vm.loadFromPayload(limited.toString())
                check(vm.requestCapture(CaptureMode.BUNDLE, true))
                vm.onPhotoCaptured(uri)
                check(repository.getEffectiveLots()[0].let { it.files.size + it.extraFiles.size } == 200)
                check(!vm.requestCapture(CaptureMode.BUNDLE) && !vm.requestCapture(CaptureMode.BUNDLE, true))
                reject { repository.addPrimaryPhoto(uri) }
                reject { repository.addExtraPhoto(uri) }
                vm.onVideoRecorded(video)
                check(repository.getEffectiveLots()[0].videoFile != null)
                repository.clearLotsOnly()
            }
            controls(instrumentation)
        } finally {
            onMain(instrumentation) { repository.clearLotsOnly() }
            check(file.delete()) // Only the uniquely named fixture created above.
        }
    }

    private fun controls(instrumentation: Instrumentation) {
        val context = instrumentation.targetContext
        val repository = LotRepository.getInstance(context)
        val input = payload()
        val handoff = CameraPayloadStore.prepare(context, input.toString())
        val intent = Intent(context, CameraViewActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoff)
        val activity = instrumentation.startActivitySync(intent) as CameraViewActivity
        fun assertNoPhotoLoadingUi() {
            fun containsProgress(view: View): Boolean = view is android.widget.ProgressBar ||
                (view is ViewGroup && (0 until view.childCount).any { containsProgress(view.getChildAt(it)) })
            check(!containsProgress(activity.findViewById(R.id.galleryPreviewContainer))) { "Photo capture added a loading spinner" }
            val count = activity.findViewById<TextView>(R.id.galleryCount)
            check(!count.text.contains("⏳") && !count.text.contains("Saving", ignoreCase = true))
        }
        try {
            instrumentation.waitForIdleSync()
            // An early shutter before CameraX binds must produce an actionable
            // error callback rather than leave the native busy state locked.
            var coldCaptureError: String? = null
            lateinit var coldEngine: CameraViewEngine
            onMain(instrumentation) {
                coldEngine = CameraViewEngine(activity, activity)
                coldEngine.onRecordingError = { coldCaptureError = it }
                coldEngine.capturePhoto()
            }
            instrumentation.waitForIdleSync()
            check(coldCaptureError?.contains("still starting") == true) { "Cold-camera request did not report readiness failure" }
            onMain(instrumentation) { coldEngine.shutdown() }
            onMain(instrumentation) {
                check(!activity.isFinishing)
                fun view(id: Int): View = activity.findViewById(id)
                fun label(): String = activity.findViewById<TextView>(R.id.textViewLot).text.toString()
                check(label() == "Lot 157-A")
                check(view(R.id.textViewBundle).isEnabled && !view(R.id.textViewItem).isEnabled)
                check(!view(R.id.imageLeftArrow).isEnabled && view(R.id.imageRightArrow).isEnabled)
                view(R.id.textViewItem).performClick() // Guard the handler as well as disabled appearance.
                assertRows(repository)
                view(R.id.imageRightArrow).performClick()
                check(label() == "Lot 2500" && view(R.id.textViewItem).isEnabled && !view(R.id.textViewBundle).isEnabled)
                view(R.id.imageRightArrow).performClick()
                check(label() == "Lot 99" && !view(R.id.imageRightArrow).isEnabled)
                view(R.id.imageRightArrow).performClick()
                check(label() == "Lot 99")
                view(R.id.imageLeftArrow).performClick()
                check(label() == "Lot 2500")
                check(view(R.id.imageViewRecordVideo).visibility == View.VISIBLE)
                assertRows(repository)
            }
            for ((orientation, label) in listOf(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT to "portrait", ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE to "landscape")) {
                onMain(instrumentation) {
                    val capture = CameraViewActivity::class.java.getDeclaredField("captureInFlight").apply { isAccessible = true }
                        .get(activity) as java.util.concurrent.atomic.AtomicBoolean
                    val processing = CameraViewActivity::class.java.getDeclaredField("processingCount").apply { isAccessible = true }
                    capture.set(true)
                    processing.setInt(activity, 2)
                    assertNoPhotoLoadingUi()
                    activity.requestedOrientation = orientation
                }
                instrumentation.waitForIdleSync()
                Thread.sleep(3200)
                onMain(instrumentation) {
                    val expected = if (label == "portrait") Configuration.ORIENTATION_PORTRAIT else Configuration.ORIENTATION_LANDSCAPE
                    check(activity.findViewById<View>(R.id.main).resources.configuration.orientation == expected) { "Camera did not reach $label orientation" }
                    check(activity.findViewById<TextView>(R.id.textViewLot).text.toString() == "Lot 2500")
                    check(activity.findViewById<View>(R.id.textViewItem).isEnabled)
                    check(!activity.findViewById<View>(R.id.textViewBundle).isEnabled)
                    val modeField = CameraViewActivity::class.java.getDeclaredField("currentCaptureMode").apply { isAccessible = true }
                    check(modeField.get(activity) == CaptureMode.ITEM) { "Repeat video capture lost the fixed lot's selected mode" }
                    assertNoPhotoLoadingUi()
                    if (label == "landscape") {
                        val panel = activity.findViewById<ViewGroup>(R.id.bottomPanel)
                        check(panel.indexOfChild(activity.findViewById(R.id.textViewBundle)) < panel.indexOfChild(activity.findViewById(R.id.textViewItem)))
                        check(panel.indexOfChild(activity.findViewById(R.id.textViewItem)) < panel.indexOfChild(activity.findViewById(R.id.textViewPhoto)))
                    }
                    val capture = CameraViewActivity::class.java.getDeclaredField("captureInFlight").apply { isAccessible = true }
                        .get(activity) as java.util.concurrent.atomic.AtomicBoolean
                    capture.set(false)
                    CameraViewActivity::class.java.getDeclaredField("processingCount").apply { isAccessible = true }.setInt(activity, 0)
                    CameraViewActivity::class.java.getDeclaredMethod("stopThumbnailPulse").apply { isAccessible = true }.invoke(activity)
                    assertNoPhotoLoadingUi()
                    check(activity.findViewById<View>(R.id.galleryCount).visibility == View.GONE) { "Empty lot showed a photo-count badge after $label rotation" }
                    assertRows(repository)
                }
                instrumentation.waitForIdleSync()
                Thread.sleep(350) // Let the restored controls render before visual inspection.
                val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
                File(context.getExternalFilesDir(null), "fixed-native-camera-$label.png").outputStream().use {
                    check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, it))
                }
                screenshot.recycle()
            }
            onMain(instrumentation) {
                val capture = CameraViewActivity::class.java.getDeclaredField("captureInFlight").apply { isAccessible = true }
                    .get(activity) as java.util.concurrent.atomic.AtomicBoolean
                capture.set(true)
                CameraViewActivity::class.java.getDeclaredMethod("onExtensionChipTapped", String::class.java)
                    .apply { isAccessible = true }.invoke(activity, "normal")
                check(capture.get()) { "A mode tap unlocked an unfinished photo" }
                assertNoPhotoLoadingUi()
                capture.set(false)
            }
            // Real hardware-shutter dispatch must capture into the imported Item lot,
            // not attempt Bundle mode or invent a new lot. Wait for durable processing.
            onMain(instrumentation) {
                activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP))
                assertNoPhotoLoadingUi()
            }
            var settled = false
            repeat(100) {
                if (!settled) {
                    Thread.sleep(200)
                    onMain(instrumentation) {
                        val pending = CameraViewActivity::class.java.getDeclaredField("captureInFlight").apply { isAccessible = true }
                            .get(activity) as java.util.concurrent.atomic.AtomicBoolean
                        val processing = CameraViewActivity::class.java.getDeclaredField("processingCount").apply { isAccessible = true }.getInt(activity)
                        settled = repository.getEffectiveLots()[1].files.isNotEmpty() && !pending.get() && processing == 0
                    }
                }
            }
            check(settled) { "Volume-up did not complete a native photo in the imported Item lot" }
            onMain(instrumentation) {
                check(repository.getEffectiveLots()[0].files.isEmpty())
                check(repository.getEffectiveLots()[1].files.size == 1)
                check(repository.getEffectiveLots()[2].files.isEmpty())
                activity.findViewById<View>(R.id.textViewDone).performClick()
                check(activity.isFinishing)
                val result = CameraPayloadStore.result(context, Intent().putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoff), handoff)
                val rows = JSONObject(result).getJSONArray("lots")
                check(rows.length() == 3 && rows.getJSONObject(0).getString("id") == "fixed-1")
                check(rows.getJSONObject(2).getString("mode") == "per_photo")
                check(rows.getJSONObject(1).getJSONArray("files").length() == 1)
            }
        } finally {
            onMain(instrumentation) { activity.finish() }
            CameraPayloadStore.discard(context, handoff)
        }
    }
}
