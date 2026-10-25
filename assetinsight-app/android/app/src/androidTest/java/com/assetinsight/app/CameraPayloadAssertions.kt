package com.assetinsight.app

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Parcel
import expo.modules.auctioncamera.AuctionCameraModule
import expo.modules.auctioncamera.CameraPayloadStore
import expo.modules.auctioncamera.CameraLaunchGate
import expo.modules.auctioncamera.CaptureJournal
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Metadata-only fixtures, isolated from every real user's files and journals. */
object CameraPayloadAssertions {
    private fun parcelSize(intent: Intent): Int {
        val parcel = Parcel.obtain()
        return try {
            intent.writeToParcel(parcel, 0)
            parcel.dataSize()
        } finally { parcel.recycle() }
    }

    private fun expectFailure(block: () -> Unit) {
        var rejected = false
        try { block() } catch (_: Exception) { rejected = true }
        check(rejected) { "Invalid camera handoff was accepted" }
    }

    @JvmStatic fun run(appContext: Context) {
        launchConcurrency()
        val directory = File(appContext.cacheDir, "camera-handoff-qa-${UUID.randomUUID()}")
        check(directory.mkdirs())
        val context = object : ContextWrapper(appContext) {
            override fun getFilesDir(): File = directory
        }
        for ((lotCount, totalPhotos) in listOf(19 to 254, 25 to 5000)) {
            val owner = "qa-owner-${UUID.randomUUID()}"
            val draft = UUID.randomUUID().toString()
            val identity = JSONObject().put("ownerId", owner).put("draftId", draft).put("sessionId", UUID.randomUUID().toString())
            val lots = JSONArray()
            var photoCount = 0
            repeat(lotCount) { lotIndex ->
                val files = JSONArray()
                val thisLotCount = totalPhotos / lotCount + if (lotIndex < totalPhotos % lotCount) 1 else 0
                repeat(thisLotCount) { photoIndex ->
                    files.put(JSONObject().put("mediaId", UUID.randomUUID().toString())
                        .put("uri", "content://media/external/images/media/${100000 + photoCount++}")
                        .put("type", "image/jpeg").put("name", "lot-${lotIndex + 1}-bundle-${photoIndex + 1}.jpg")
                        .put("captureOrigin", "camera").put("size", 5123456).put("width", 4032).put("height", 3024))
                }
                lots.put(JSONObject().put("id", "lot-${UUID.randomUUID()}")
                    .put("lotNumber", lotIndex + 1).put("mode", "bundle").put("coverIndex", 0).put("files", files))
            }
            val initial = JSONObject().put("captureContext", identity).put("lots", lots).toString()
            val handoff = CameraPayloadStore.prepare(context, initial)
            val launch = Intent().putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoff)
            check(parcelSize(launch) < 512) { "Large initial draft leaked into Binder" }
            check(!launch.hasExtra(AuctionCameraModule.EXTRA_LOT_PAYLOAD_JSON))
            check(CameraPayloadStore.input(context, launch) == initial) { "Initial lot/photo order changed" }
            // The launch receipt must remain reusable after Activity recreation.
            check(CameraPayloadStore.input(context, launch) == initial)
            CaptureJournal.save(context, identity, JSONObject().put("activeLotNumber", 1), JSONArray())
            val journal = CaptureJournal.save(context, identity,
                JSONObject().put("activeLotNumber", lotCount).put("completedLots", lots), lots)
            val completed = journal.toString()
            if (totalPhotos == 5000) {
                val oldResult = Intent().putExtra(AuctionCameraModule.EXTRA_LOT_PAYLOAD_JSON, completed)
                check(parcelSize(oldResult) > 1024 * 1024) { "Fixture does not reproduce the old Binder-size hazard" }
            }
            val result = CameraPayloadStore.resultIntent(context, launch, completed)
            check(parcelSize(result) < 512) { "Large Done result leaked into Binder" }
            check(CameraPayloadStore.result(context, result, handoff) == completed) { "Result lost photo order/activity" }
            expectFailure { CameraPayloadStore.result(context, result, UUID.randomUUID().toString()) }
            expectFailure { CameraPayloadStore.input(context, Intent().putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, "../../draft")) }
            expectFailure { CameraPayloadStore.result(context, null, handoff) }
            CameraPayloadStore.discard(context, handoff)
            expectFailure { CameraPayloadStore.result(context, result, handoff) }
            val pending = CaptureJournal.read(context, owner, draft)
            check(pending != null && pending.toString() == completed) { "Transport cleanup consumed the durable capture journal" }
            check(pending.getJSONArray("lots").length() == lotCount)
            var recoveredPhotos = 0
            repeat(lotCount) { recoveredPhotos += pending.getJSONArray("lots").getJSONObject(it).getJSONArray("files").length() }
            check(recoveredPhotos == totalPhotos) { "Handoff lost originals" }
            check(CaptureJournal.acknowledge(context, owner, draft, identity.getString("sessionId"), journal.getLong("revision")))
        }
        // If private handoff storage is unavailable, refuse launch/Done explicitly.
        val blockedDirectory = File(directory, "blocked").apply { mkdirs() }
        File(blockedDirectory, "camera-handoffs").writeText("fixture obstruction")
        val blockedContext = object : ContextWrapper(appContext) {
            override fun getFilesDir(): File = blockedDirectory
        }
        expectFailure { CameraPayloadStore.prepare(blockedContext, "[]") }
    }

    private fun launchConcurrency() {
        val missing = expo.modules.auctioncamera.CameraLaunchWatch(100)
        check(!missing.expired(20_099, false))
        check(missing.expired(20_100, false))
        val inspection = expo.modules.auctioncamera.CameraLaunchWatch(0)
        check(!inspection.expired(500, true))
        check(!inspection.expired(86_400_000, true)) { "Long inspection was timed out" }
        check(!inspection.expired(86_401_000, false)) { "Rotation gap abandoned the camera" }
        check(!inspection.expired(86_401_100, true))
        check(inspection.expired(86_403_100, false)) { "Missing result callback left an infinite opening state" }
        val gate = CameraLaunchGate<String>()
        val workers = Executors.newFixedThreadPool(8)
        try {
            val ready = CountDownLatch(8)
            val start = CountDownLatch(1)
            val attempts = (0 until 8).map { index ->
                workers.submit<CameraLaunchGate.Claim<String>?> {
                    ready.countDown()
                    check(start.await(5, TimeUnit.SECONDS))
                    gate.claim("receiver-$index")
                }
            }
            check(ready.await(5, TimeUnit.SECONDS))
            start.countDown()
            val claims = attempts.mapNotNull { it.get(5, TimeUnit.SECONDS) }
            check(claims.size == 1) { "Concurrent opens replaced a pending camera promise" }
            val first = claims.single()
            val detached = gate.detach()
            check(detached === first)
            // Emulate a new launch while the old activity result is still reading
            // its payload. The detached receiver/token must stay paired.
            val next = gate.claim("next-receiver") ?: error("Next camera could not open")
            check(detached.receiver == first.receiver && detached.handoffId == first.handoffId)
            check(detached.handoffId != next.handoffId)
            check(!gate.release(first)) { "Old launch failure cleared the new camera claim" }
            check(gate.detach() === next) { "Old result consumed the new handoff identity" }
            check(gate.detach() == null)
            val failed = gate.claim("failed-before-activity") ?: error("Launch claim unavailable")
            check(gate.release(failed))
            val retry = checkNotNull(gate.claim("retry-after-failure"))
            check(retry.requestCode != failed.requestCode) { "Late Android result could consume a newer promise" }
            check(gate.release(retry))
            val cancelledId = java.util.UUID.randomUUID().toString()
            gate.cancelBeforeStart(cancelledId)
            check(gate.claim("late-async-bridge-call", cancelledId) == null) { "Cancelled camera opened late" }
            check(gate.claim("fresh-after-cancel") != null)
        } finally { workers.shutdownNow() }
    }
}
