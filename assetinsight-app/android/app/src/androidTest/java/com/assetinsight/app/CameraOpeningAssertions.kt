package com.assetinsight.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import expo.modules.auctioncamera.CameraActivityRegistry
import expo.modules.auctioncamera.CameraPayloadStore
import expo.modules.auctioncamera.CaptureJournal
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.ui.camera.CameraViewActivity
import expo.modules.auctioncamera.viewextensions.LotRepository
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Synthetic, app-private metadata fixture. Run only in the isolated test emulator. */
object CameraOpeningAssertions {
    private const val OWNER = "isolated-camera-opening-20261023"
    private const val DRAFT = "inspection-30-lots-324-photos"
    fun run(instrumentation: Instrumentation, restoreAfterDeath: Boolean) {
        val context = instrumentation.targetContext
        val repository = LotRepository.getInstance(context)
        val file = File(context.filesDir, "isolated-camera-opening-fixture.jpg")
        if (!restoreAfterDeath) {
            val bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
            file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it)) }; bitmap.recycle()
        } else check(file.isFile) { "Process restart lost the fixture original" }
        val root = JSONObject().put("captureContext", JSONObject().put("ownerId", OWNER).put("draftId", DRAFT).put("sessionId", DRAFT))
            .put("activeLotIdx", 29).put("activeLotNumber", 30).put("lots", JSONArray().apply {
                repeat(30) { index -> put(JSONObject().put("id", "row-$index").put("mode", "single_lot").put("lotNumber", index + 1)
                    .put("coverIndex", 0).put("extraFiles", JSONArray()).put("files", JSONArray().apply {
                        repeat(if (index < 24) 11 else 10) { photo -> put(JSONObject().put("uri", Uri.fromFile(file).toString())
                            .put("name", "$index-$photo.jpg").put("mediaId", "$index-$photo").put("width", 100).put("height", 100).put("type", "image/jpeg")) }
                    })) }
            })
        fun assertMedia() {
            val rows = repository.getEffectiveLots()
            check(rows.size == 30) { "Camera reopen lost inspection rows" }
            check(rows.sumOf { it.files.size + it.extraFiles.size } == 324) { "Camera reopen lost inspection references" }
            check(rows.map { it.id } == (0 until 30).map { "row-$it" })
            check(file.isFile)
        }
        if (restoreAfterDeath) {
            val saved = checkNotNull(CaptureJournal.read(context, OWNER, DRAFT)) { "Process restart lost the pending capture journal" }
            check(saved.getJSONArray("lots").length() == 30)
        }
        repeat(if (restoreAfterDeath) 2 else 5) { cycle ->
            val handoff = CameraPayloadStore.prepare(context, root.toString())
            val before = SystemClock.elapsedRealtime()
            val activity = instrumentation.startActivitySync(Intent(context, CameraViewActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoff)) as CameraViewActivity
            instrumentation.waitForIdleSync()
            check(SystemClock.elapsedRealtime() - before < 15_000) { "Camera startup exceeded recovery deadline" }
            try {
                instrumentation.runOnMainSync {
                    check(CameraActivityRegistry.contains(handoff))
                    check(CameraActivityRegistry.hasActiveCamera())
                    check(activity.findViewById<android.view.View>(R.id.textViewDone).isShown)
                    assertMedia()
                    // Save an exact return receipt, then deliberately omit an
                    // activity-result callback, like an interrupted RN handoff.
                    CameraPayloadStore.resultIntent(context, activity.intent, repository.exportCapture())
                    activity.finish()
                }
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync { check(!CameraActivityRegistry.contains(handoff)) }
                val receipt = JSONObject(CameraPayloadStore.result(context, Intent().putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoff), handoff))
                check(receipt.getJSONArray("lots").length() == 30)
                CameraPayloadStore.discard(context, handoff)
                checkNotNull(CaptureJournal.read(context, OWNER, DRAFT)) { "Transport cleanup acknowledged the recovery journal" }
                android.util.Log.i("CameraOpeningQA", "PASS cycle=$cycle restoreAfterDeath=$restoreAfterDeath lots=30 photos=324 ms=${SystemClock.elapsedRealtime() - before}")
            } finally { instrumentation.runOnMainSync { if (!activity.isFinishing) activity.finish() } }
        }
        // Deliberately keep this uniquely scoped fixture and unacknowledged
        // journal for a separate force-stop/relaunch verification invocation.
    }
}
