package com.assetinsight.app

import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.view.View
import android.os.SystemClock
import expo.modules.auctioncamera.CameraPayloadStore
import expo.modules.auctioncamera.CaptureMode
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.ui.camera.CameraViewActivity
import expo.modules.auctioncamera.utils.PhotoWatermarkReceipt
import expo.modules.auctioncamera.viewextensions.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

object CameraBurstAssertions {
    fun run(test: Instrumentation, phase: String) {
        val context = test.targetContext
        val restore = phase == "restore"
        val seed = phase == "seed"
        val marker = File(context.filesDir, "isolated-burst-tickets.json")
        val replay = if (restore) JSONObject(marker.readText()) else null
        val identity = replay?.getJSONObject("identity") ?: JSONObject().put("ownerId", "isolated-burst-20261023")
            .put("draftId", UUID.randomUUID().toString()).also { it.put("sessionId", it.getString("draftId")) }
        val input = JSONObject().put("captureContext", identity).put("lockedStructure", true).put("sourceLabels", JSONArray().put("Lot 77"))
            .put("lots", JSONArray().put(JSONObject().put("id", "fixed-burst-77").put("lotNumber", 1).put("mode", "single_lot").put("files", JSONArray()).put("extraFiles", JSONArray()).put("coverIndex", 0)))
            .put("activeLotIdx", 0).put("activeLotNumber", 1)
        val repository = LotRepository.getInstance(context)
        val blocker = CountDownLatch(1)
        val blocked = CountDownLatch(1)
        if (!restore) {
            PhotoWorkQueue.executor.execute { blocked.countDown(); check(blocker.await(45, TimeUnit.SECONDS)) }
            check(blocked.await(5, TimeUnit.SECONDS))
        }
        val handoff = CameraPayloadStore.prepare(context, input.toString())
        val activity = test.startActivitySync(Intent(context, CameraViewActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoff)) as CameraViewActivity
        fun onMain(work: () -> Unit) {
            var failure: Throwable? = null
            test.runOnMainSync { try { work() } catch (error: Throwable) { failure = error } }
            failure?.let { throw it }
        }
        fun waitUntil(message: String, seconds: Int = 15, condition: () -> Boolean) {
            val start = SystemClock.elapsedRealtime()
            while (SystemClock.elapsedRealtime() - start < seconds * 1000) {
                var done = false; onMain { done = condition() }
                if (done) return
                Thread.sleep(30)
            }
            error(message)
        }
        fun pending() = PendingPhotoStore.pending(context, identity)
        var ticketIds = emptyList<String>()
        var queuedSeed = false
        try {
            if (!restore) {
                waitUntil("Camera preview did not become ready") {
                    val preview = activity.findViewById<View>(R.id.previewView)
                    val state = preview.javaClass.getMethod("getPreviewStreamState").invoke(preview)
                    state.javaClass.getMethod("getValue").invoke(state)?.toString() == "STREAMING"
                }
                val capture = CameraViewActivity::class.java.getDeclaredField("captureInFlight").apply { isAccessible = true }.get(activity) as AtomicBoolean
                // A missing system sound must never prevent consecutive capture.
                onMain {
                    val sound = CameraViewActivity::class.java.getDeclaredField("sound").apply { isAccessible = true }
                    runCatching { (sound.get(activity) as? android.media.MediaActionSound)?.release() }
                    sound.set(activity, null)
                }
                repeat(3) { index ->
                    val before = SystemClock.elapsedRealtime()
                    onMain { activity.findViewById<View>(if (index == 1) R.id.textViewBundleExtra else R.id.textViewBundle).performClick() }
                    waitUntil("Shutter waited for blocked JPEG processing", 5) { !capture.get() && pending().size == index + 1 }
                    check(repository.getEffectiveLots().sumOf { it.files.size + it.extraFiles.size } == 0) { "Raw frame leaked into report" }
                    android.util.Log.i("CameraBurstQA", "RAW_READY shot=$index ms=${SystemClock.elapsedRealtime() - before} encodingBlocked=true")
                }
                val records = pending()
                check(records.size == 3 && records.all { it.raw.isFile && it.raw.length() > 0 })
                ticketIds = records.map { it.ticket.id }
                if (seed) marker.writeText(JSONObject().put("identity", identity).put("tickets", JSONArray(ticketIds)).toString())
                onMain {
                    val pulse = CameraViewActivity::class.java.getDeclaredField("pulseAnimator").apply { isAccessible = true }.get(activity) as? android.animation.ObjectAnimator
                    check(pulse?.isStarted == true) { "Supplied component thumbnail feedback did not start" }
                    activity.findViewById<View>(R.id.textViewBundle).performClick()
                    check(pending().size == 3) { "Backlog allowed a fourth frame" }
                    activity.findViewById<View>(R.id.imageRightArrow).performClick()
                    check(activity.findViewById<android.widget.TextView>(R.id.textViewLot).text.toString() == "Lot 77")
                    activity.findViewById<View>(R.id.textViewDone).performClick()
                    check(!activity.isFinishing) { "Done dropped queued frames" }
                    // In-flight processing must use its immutable original settings.
                    val engine = CameraViewActivity::class.java.getDeclaredField("engine").apply { isAccessible = true }.get(activity) as CameraViewEngine
                    engine.set12MPOutput(true)
                }
                if (seed) {
                    check(records.all { it.data.getJSONObject("options").getBoolean("highResolution") == false })
                    onMain { activity.finish() }
                    queuedSeed = true
                    return // Deliberately leave encoder blocked until host force-stops this isolated process.
                }
                blocker.countDown()
            } else {
                check(marker.isFile)
                val ids = checkNotNull(replay).getJSONArray("tickets")
                ticketIds = (0 until ids.length()).map { ids.getString(it) }
            }
            waitUntil("Queued photos did not commit and release their raw records", 25) {
                repository.getEffectiveLots().sumOf { it.files.size + it.extraFiles.size } == 3 && pending().isEmpty() && PhotoWorkQueue.activeCount() == 0
            }
            onMain {
                check(CameraViewActivity::class.java.getDeclaredField("pulseAnimator").apply { isAccessible = true }.get(activity) == null) { "Processing feedback never stopped" }
                check(activity.findViewById<View>(R.id.galleryPreview).alpha == 1f) { "Finished thumbnail stayed dimmed" }
                val row = repository.getEffectiveLots().single()
                check(row.files.size == 2 && row.extraFiles.size == 1) { "Second tap overwrote first tap's main/extra slot" }
                check(row.files[0].uri.contains(ticketIds[0]) && row.files[1].uri.contains(ticketIds[2]))
                check(row.extraFiles[0].uri.contains(ticketIds[1]))
                for (photo in row.files + row.extraFiles) {
                    val original = File(checkNotNull(Uri.parse(photo.uri).path))
                    check(original.isFile && PhotoWatermarkReceipt.has(original.readBytes()))
                    check(maxOf(photo.width, photo.height) <= 2400) { "Queued frame used later high-resolution settings" }
                }
            }
            // A previously failed accepted shot must block partial Done and be
            // explicitly retryable, not silently orphaned by clearing the journal.
            val retryTicket = CaptureTicket(CaptureMode.BUNDLE, true, SystemClock.elapsedRealtime(), 1)
            val retryOptions = JSONObject().put("format", "JPEG").put("highResolution", false)
                .put("previewWidth", 1280).put("previewHeight", 720).put("contrast", 0).put("color", 0).put("sharpness", 0).put("outputId", retryTicket.id)
            val retryFrame = PendingPhotoStore.create(context, identity, retryTicket, retryOptions)
            val savedUri = repository.getEffectiveLots().single().files.first().uri
            File(checkNotNull(Uri.parse(savedUri).path)).copyTo(retryFrame.raw)
            PendingPhotoStore.ready(retryFrame); PendingPhotoStore.failed(retryFrame)
            onMain {
                val engine = CameraViewActivity::class.java.getDeclaredField("engine").apply { isAccessible = true }.get(activity) as CameraViewEngine
                @Suppress("UNCHECKED_CAST") val attempted = CameraViewEngine::class.java.getDeclaredField("enqueuedShots").apply { isAccessible = true }.get(engine) as MutableSet<String>
                attempted.add(retryTicket.id)
                check(engine.hasPendingPhotos()) { "Failed accepted shot disappeared from pending guard" }
                val wait = CameraViewActivity::class.java.getDeclaredMethod("waitForCapture").apply { isAccessible = true }
                check(wait.invoke(activity) == true && !activity.isFinishing) { "Failed photo allowed partial Done" }
            }
            waitUntil("Explicit failed-photo retry did not save its original slot", 25) {
                repository.getEffectiveLots().single().extraFiles.size == 2 && pending().isEmpty() && PhotoWorkQueue.activeCount() == 0
            }
            // Failure recovery: preserve a bad original, settle once, and permit
            // the next job. This simulates decoder/OOM failure, not a customer photo.
            val failureIdentity = JSONObject(identity.toString()).put("ownerId", "isolated-burst-failure")
            val bad = PendingPhotoStore.create(context, failureIdentity, CaptureTicket(CaptureMode.BUNDLE, false, SystemClock.elapsedRealtime(), 1), JSONObject())
            bad.raw.writeBytes(byteArrayOf(1, 2, 3)); PendingPhotoStore.ready(bad)
            val failed = CountDownLatch(1)
            PhotoWorkQueue.enqueue(bad, work = { throw OutOfMemoryError("isolated encoder fixture") }, commit = { error("Failed encode was committed") }, finish = { check(it != null); failed.countDown() })
            check(failed.await(5, TimeUnit.SECONDS))
            check(bad.raw.isFile && bad.record.isFile)
            val next = PendingPhotoStore.create(context, failureIdentity, CaptureTicket(CaptureMode.BUNDLE, true, SystemClock.elapsedRealtime(), 1), JSONObject())
            next.raw.writeBytes(byteArrayOf(4, 5, 6)); PendingPhotoStore.ready(next)
            val resumed = CountDownLatch(1)
            PhotoWorkQueue.enqueue(next, work = { JSONObject().put("fixture", true) }, commit = { it.getBoolean("fixture") }, finish = { check(it == null); resumed.countDown() })
            check(resumed.await(5, TimeUnit.SECONDS)); check(!next.record.exists() && !next.raw.exists())
            PendingPhotoStore.acknowledge(bad) // Only this deliberately invalid synthetic fixture.
            val replayFrame = PendingPhotoStore.create(context, failureIdentity, CaptureTicket(CaptureMode.BUNDLE, false, SystemClock.elapsedRealtime(), 1), JSONObject())
            replayFrame.raw.writeBytes(byteArrayOf(7)); PendingPhotoStore.ready(replayFrame)
            val workStarted = CountDownLatch(1); val continueWork = CountDownLatch(1); val delivered = CountDownLatch(1)
            var oldDelivery = 0
            PhotoWorkQueue.enqueue(replayFrame, work = { workStarted.countDown(); check(continueWork.await(5, TimeUnit.SECONDS)); JSONObject() },
                commit = { oldDelivery++; false }, finish = {}, receiverRevision = 1)
            check(workStarted.await(5, TimeUnit.SECONDS))
            PhotoWorkQueue.enqueue(replayFrame, work = { error("Duplicate encode after recreation") }, commit = { true }, finish = { delivered.countDown() }, receiverRevision = 2)
            PhotoWorkQueue.enqueue(replayFrame, work = { error("Late old encode") }, commit = { oldDelivery++; false }, finish = {}, receiverRevision = 1)
            continueWork.countDown(); check(delivered.await(5, TimeUnit.SECONDS)); check(oldDelivery == 0)
        } finally {
            if (!queuedSeed) blocker.countDown()
            onMain { if (!activity.isFinishing) activity.finish() }
        }
    }
}
