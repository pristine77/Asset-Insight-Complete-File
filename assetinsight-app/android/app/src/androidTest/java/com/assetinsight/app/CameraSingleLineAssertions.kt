package com.assetinsight.app

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Rect
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.widget.SeekBar
import android.widget.TextView
import expo.modules.auctioncamera.CameraPayloadStore
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.ui.camera.CameraViewActivity
import expo.modules.auctioncamera.viewextensions.CameraHeaderLayout
import expo.modules.auctioncamera.viewextensions.LotRepository
import expo.modules.auctioncamera.viewextensions.PhotoWorkQueue
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Physical-device checks must run only in the separately installed, offline QA package. */
object CameraSingleLineAssertions {
    fun run(test: Instrumentation) {
        val context = test.targetContext
        check(context.packageName.endsWith(".cameraheaderqa20261024")) { "Refusing device interaction outside the isolated QA app" }
        val identity = JSONObject().put("ownerId", "isolated-single-line-20261024")
            .put("draftId", UUID.randomUUID().toString()).also { it.put("sessionId", it.getString("draftId")) }
        val input = JSONObject().put("captureContext", identity).put("lockedStructure", true).put("sourceLabels", JSONArray().put("Lot 77"))
            .put("lots", JSONArray().put(JSONObject().put("id", "single-line-77").put("lotNumber", 1).put("mode", "single_lot")
                .put("files", JSONArray()).put("extraFiles", JSONArray()).put("coverIndex", 0)))
            .put("activeLotIdx", 0).put("activeLotNumber", 1)
        val handoff = CameraPayloadStore.prepare(context, input.toString())
        val activity = test.startActivitySync(Intent(context, CameraViewActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoff)) as CameraViewActivity
        fun onMain(work: () -> Unit) {
            var failure: Throwable? = null
            test.runOnMainSync { try { work() } catch (error: Throwable) { failure = error } }
            failure?.let { throw it }
        }
        fun waitUntil(message: String, seconds: Int = 20, condition: () -> Boolean) {
            val start = SystemClock.elapsedRealtime()
            while (SystemClock.elapsedRealtime() - start < seconds * 1000) {
                var done = false; onMain { done = condition() }
                if (done) return
                Thread.sleep(40)
            }
            error(message)
        }
        fun screenshot(name: String) {
            test.waitForIdleSync()
            // Copy only this QA window, excluding the owner's unrelated floating overlays.
            waitUntil("QA window lost focus before screenshot", 5) {
                activity.window.decorView.isAttachedToWindow && activity.window.decorView.hasWindowFocus() && !activity.isFinishing
            }
            Thread.sleep(800)
            lateinit var image: Bitmap
            val copied = CountDownLatch(1)
            var result = -1
            onMain {
                image = Bitmap.createBitmap(activity.window.decorView.width, activity.window.decorView.height, Bitmap.Config.ARGB_8888)
                android.view.PixelCopy.request(activity.window, image, { result = it; copied.countDown() }, Handler(Looper.getMainLooper()))
            }
            check(copied.await(5, TimeUnit.SECONDS) && result == android.view.PixelCopy.SUCCESS)
            File(context.getExternalFilesDir(null), "single-line-$name.png").outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            image.recycle()
        }
        fun assertStrip() {
            val header = activity.findViewById<CameraHeaderLayout>(R.id.cameraHeader)
            val density = activity.resources.displayMetrics.density
            val isLandscape = header.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
            if (isLandscape) {
                CameraLandscapeReferenceAssertions.assertLayout(activity.findViewById(R.id.main), "physical Samsung")
                android.util.Log.i("CameraSingleLineQA", "REFERENCE landscape preview, stacked lot/mode/counts, PRO/flash/focus, bottom EV/lenses/rotate and single-column rail PASS")
                return
            }
            check(!header.isExposureExpanded && header.height <= (if (isLandscape) 72 else 40) * density + 1)
            val ids = listOf(R.id.btnProMode, R.id.galleryPreviewContainer,
                if (header.isExposureInline) R.id.evContainer else R.id.evToggle, R.id.headerLotSummary, R.id.topBar)
            val views = ids.map { activity.findViewById<View>(it) }.filter { it.visibility == View.VISIBLE }
            if (!isLandscape) {
                check(views.zipWithNext().all { (a, b) -> a.right <= b.left }) { "Physical-device header order/overlap" }
                check(views.all { kotlin.math.abs((it.top + it.bottom) / 2 - header.height / 2) <= 2 * density }) { "Physical-device header wrapped" }
            }
            check(views.all { it.left >= 0 && it.right <= header.width }) { "Physical-device header clipped" }
            val preview = activity.findViewById<View>(R.id.previewView)
            val rect = Rect(0, 0, header.width, header.height)
            (header.parent as android.view.ViewGroup).offsetDescendantRectToMyCoords(header, rect)
            val footer = activity.findViewById<android.view.ViewGroup>(R.id.bottomPanel)
            if (footer.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE) {
                check(preview.top == rect.top) { "Landscape preview still reserves a black top strip" }
                check(android.graphics.Color.alpha((header.background as android.graphics.drawable.ColorDrawable).color) == 0)
                check(header.elevation > preview.elevation)
                val railBounds = Rect(0, 0, footer.width, footer.height).also { (footer.parent as android.view.ViewGroup).offsetDescendantRectToMyCoords(footer, it) }
                check(preview.right <= railBounds.left) { "Landscape controls moved below preview" }
                check(footer !is expo.modules.auctioncamera.viewextensions.CameraPortraitFooterLayout)
                for (id in listOf(R.id.btnProMode, R.id.galleryPreviewContainer, R.id.evToggle, R.id.buttonFrontCamera, R.id.btnFlash, R.id.btnFocus)) {
                    val tool = activity.findViewById<View>(id)
                    val bounds = Rect(0, 0, tool.width, tool.height).also { (header.parent as android.view.ViewGroup).offsetDescendantRectToMyCoords(tool, it) }
                    check(bounds.left >= railBounds.left && bounds.right <= railBounds.right && bounds.bottom <= railBounds.top) { "Sidebar tool escaped upper empty rail: $id" }
                }
                val summary = activity.findViewById<android.widget.LinearLayout>(R.id.headerLotSummary)
                check(summary.orientation == android.widget.LinearLayout.HORIZONTAL)
                val cells = (0 until summary.childCount).map { summary.getChildAt(it) }.filter { it.visibility == View.VISIBLE }
                check(cells.zipWithNext().all { (a,b) -> a.right <= b.left && kotlin.math.abs((a.top + a.bottom) - (b.top + b.bottom)) <= 2 * density }) { "Lot/count summary wrapped" }
                android.util.Log.i("CameraSingleLineQA", "LANDSCAPE right-side rail restored widthDp=${footer.width / density}")
            } else {
            check(preview.top >= rect.bottom) { "Portrait preview covered header" }
            check(kotlin.math.abs(footer.height / density - 120f) < 1f) { "Physical footer grew above reference height" }
            val footerBounds = Rect(0, 0, footer.width, footer.height).also { (footer.parent as android.view.ViewGroup).offsetDescendantRectToMyCoords(footer, it) }
            check(preview.bottom == footerBounds.top)
            for (row in listOf(listOf(R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto),
                listOf(R.id.imageLeftArrow, R.id.imageRightArrow, R.id.textViewBundleExtra, R.id.textViewDone))) {
                val viewsInRow = row.map { activity.findViewById<View>(it) }
                check(viewsInRow.all { it.top == viewsInRow.first().top && kotlin.math.abs(it.height / density - 40f) < 1f })
                check(viewsInRow.zipWithNext().all { (a,b) -> a.right < b.left })
            }
            android.util.Log.i("CameraSingleLineQA", "FOOTER widthDp=${footer.width / density} heightDp=${footer.height / density} rows=32/40/40")
            }
            android.util.Log.i("CameraSingleLineQA", "STRIP widthDp=${header.width / density} heightDp=${header.height / density} inlineEV=${header.isExposureInline}")
        }
        try {
            onMain { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            waitUntil("Physical camera preview did not stream") {
                val preview = activity.findViewById<View>(R.id.previewView)
                val state = preview.javaClass.getMethod("getPreviewStreamState").invoke(preview)
                state.javaClass.getMethod("getValue").invoke(state)?.toString() == "STREAMING"
            }
            onMain { assertStrip() }; screenshot("portrait")
            val header = activity.findViewById<CameraHeaderLayout>(R.id.cameraHeader)
            onMain {
                // Exercise narrow-device EV fallback without changing phone display/font settings.
                header.layoutParams = header.layoutParams.apply { width = (280 * activity.resources.displayMetrics.density).toInt() }
                activity.findViewById<View>(R.id.btnProMode).visibility = View.VISIBLE
                activity.findViewById<View>(R.id.evLabel).visibility = View.VISIBLE
                activity.findViewById<View>(R.id.evSeekBar).visibility = View.VISIBLE
            }
            waitUntil("Narrow EV fallback not offered") { !header.isExposureInline && activity.findViewById<View>(R.id.evToggle).width > 0 }
            onMain { assertStrip(); activity.findViewById<View>(R.id.evToggle).performClick() }
            waitUntil("EV panel did not expand") { header.isExposureExpanded && activity.findViewById<View>(R.id.evContainer).height > 0 }
            screenshot("ev-expanded")
            var previousEV = ""
            onMain {
                previousEV = activity.findViewById<TextView>(R.id.evLabel).text.toString()
                val seek = activity.findViewById<SeekBar>(R.id.evSeekBar)
                val before = seek.progress
                val time = SystemClock.uptimeMillis()
                for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                    val event = MotionEvent.obtain(time, time + 20, action, seek.width * 0.7f, seek.height / 2f, 0)
                    check(seek.dispatchTouchEvent(event)); event.recycle()
                }
                check(seek.progress != before) { "Expanded EV slider did not accept touch" }
            }
            waitUntil("Camera did not acknowledge touch-adjusted EV") { activity.findViewById<TextView>(R.id.evLabel).text.toString() != previousEV }
            val capture = CameraViewActivity::class.java.getDeclaredField("captureInFlight").apply { isAccessible = true }.get(activity) as AtomicBoolean
            for (id in listOf(R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto, R.id.textViewBundleExtra, R.id.imageViewRecordVideo)) {
                onMain {
                    header.setExposureExpanded(true)
                    capture.set(true) // Reject capture safely while checking each real click handler.
                    activity.findViewById<View>(id).performClick()
                    capture.set(false)
                    check(!header.isExposureExpanded) { "Capture handler did not hide EV: $id" }
                }
            }
            val repository = LotRepository.getInstance(context)
            repeat(3) { shot ->
                val before = SystemClock.elapsedRealtime()
                onMain {
                    if (shot == 0) header.setExposureExpanded(true)
                    if (shot == 2) {
                        activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP))
                        activity.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_VOLUME_UP))
                    } else activity.findViewById<View>(if (shot == 1) R.id.textViewBundleExtra else R.id.textViewBundle).performClick()
                    check(!header.isExposureExpanded) { "Accepted capture did not hide EV" }
                    if (shot == 0) header.layoutParams = header.layoutParams.apply { width = 0 }
                }
                waitUntil("Real Samsung photo did not save") { repository.getEffectiveLots().sumOf { it.files.size + it.extraFiles.size } == shot + 1 && PhotoWorkQueue.activeCount() == 0 }
                android.util.Log.i("CameraSingleLineQA", "PHOTO shot=$shot savedMs=${SystemClock.elapsedRealtime() - before}")
                onMain { assertStrip() }
            }
            onMain { check(repository.getEffectiveLots().single().let { it.files.size == 2 && it.extraFiles.size == 1 }) }
            screenshot("captured")
            onMain { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            waitUntil("Landscape rotation did not settle") {
                val rail = activity.findViewById<View>(R.id.bottomPanel)
                rail.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE &&
                    rail !is expo.modules.auctioncamera.viewextensions.CameraPortraitFooterLayout &&
                    activity.findViewById<View>(R.id.previewView).width > 500 * activity.resources.displayMetrics.density
            }
            onMain { assertStrip() }; screenshot("landscape")
            waitUntil("Landscape reference preview did not stream") {
                val preview = activity.findViewById<View>(R.id.previewView)
                val state = preview.javaClass.getMethod("getPreviewStreamState").invoke(preview)
                state.javaClass.getMethod("getValue").invoke(state)?.toString() == "STREAMING"
            }
            onMain { CameraLandscapeReferenceAssertions.assertLayout(activity.findViewById(R.id.main), "live Samsung landscape") }
            onMain { activity.findViewById<View>(R.id.zoom2).performClick() }
            waitUntil("Reference 2x lens did not reach camera") {
                val engine = CameraViewActivity::class.java.getDeclaredField("engine").apply { isAccessible = true }.get(activity) as expo.modules.auctioncamera.viewextensions.CameraViewEngine
                val ratio = engine.getCamera()?.cameraInfo?.zoomState?.value?.zoomRatio ?: 0f
                kotlin.math.abs(ratio - 2f) < 0.1f && activity.findViewById<View>(R.id.zoomPanel).visibility == View.VISIBLE
            }
            screenshot("landscape-2x")
            onMain { activity.findViewById<View>(R.id.zoom1).performClick() }
            waitUntil("Reference 1x lens did not reach camera") {
                val engine = CameraViewActivity::class.java.getDeclaredField("engine").apply { isAccessible = true }.get(activity) as expo.modules.auctioncamera.viewextensions.CameraViewEngine
                kotlin.math.abs((engine.getCamera()?.cameraInfo?.zoomState?.value?.zoomRatio ?: 0f) - 1f) < 0.1f
            }
            waitUntil("Reference status bar not restored") {
                val insets = androidx.core.view.ViewCompat.getRootWindowInsets(activity.window.decorView)
                insets != null && insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.statusBars()) &&
                    !insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.navigationBars())
            }
            onMain { activity.findViewById<View>(R.id.textViewBundle).performClick() }
            waitUntil("Reference landscape capture failed") { repository.getEffectiveLots().sumOf { it.files.size + it.extraFiles.size } == 4 && PhotoWorkQueue.activeCount() == 0 }
            waitUntil("Reference preview did not resume after capture") {
                val preview = activity.findViewById<View>(R.id.previewView)
                val state = preview.javaClass.getMethod("getPreviewStreamState").invoke(preview)
                state.javaClass.getMethod("getValue").invoke(state)?.toString() == "STREAMING"
            }
            onMain {
                check(activity.findViewById<View>(R.id.evContainer).visibility == View.VISIBLE)
                check(activity.findViewById<View>(R.id.zoomPanel).visibility == View.VISIBLE)
                CameraLandscapeReferenceAssertions.assertLayout(activity.findViewById(R.id.main), "after reference capture")
            }
            screenshot("landscape-reference")
            onMain { activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            waitUntil("Portrait bars/layout were not restored") {
                val footer = activity.findViewById<View>(R.id.bottomPanel)
                val insets = androidx.core.view.ViewCompat.getRootWindowInsets(activity.window.decorView)
                footer is expo.modules.auctioncamera.viewextensions.CameraPortraitFooterLayout &&
                    footer.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT &&
                    insets?.isVisible(androidx.core.view.WindowInsetsCompat.Type.statusBars()) == true
            }
            onMain { assertStrip() }; screenshot("portrait-restored")
            onMain { activity.findViewById<View>(R.id.textViewDone).performClick() }
            waitUntil("Done did not return after completed photos") { activity.isFinishing || activity.isDestroyed }
            android.util.Log.i("CameraSingleLineQA", "PASS: Samsung exact landscape reference geometry, visible EV and lenses, 2x/1x camera acknowledgement, status-bar and portrait restoration, four main/extra/hardware/landscape photos and Done")
        } finally {
            onMain { if (!activity.isFinishing && !activity.isDestroyed) activity.finish() }
        }
    }
}
