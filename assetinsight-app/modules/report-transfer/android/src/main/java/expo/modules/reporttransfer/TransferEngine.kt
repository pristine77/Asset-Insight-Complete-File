package expo.modules.reporttransfer

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

object TransferEngine {
    enum class Outcome { DONE, RETRY }
    // Single report transfer at a time across UIDT and legacy WorkManager paths.
    private val slot = Semaphore(1, true)
    private val eventSlot = Semaphore(1, true)
    fun interrupted(context: Context, id: String, reason: String, attemptId: String? = null, userStopped: Boolean = false) {
        TransferStore.update(context, id) {
            if ((attemptId == null || it.optString("attemptId") == attemptId) && !it.optBoolean("forgotten") && it.getString("status") !in setOf("paused", "accepted", "auth_required", "needs_attention")) {
                it.put("status", if (userStopped) "paused" else if (reason == "network_unavailable") "waiting_network" else "interrupted").put("finalizing", false)
                    .put("message", if (userStopped) "Android stopped this transfer. Open the app and tap Resume." else if (reason == "network_unavailable") "Waiting for a connection" else "Android will retry this transfer when allowed")
                TransferStore.event(context, it, "upload_interrupted", reason)
            }
        }?.let { TransferNotifications.show(context, it) }
    }
    private fun network(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }
    fun events(context: Context, id: String, stopped: () -> Boolean = { false }): Outcome {
        if (!eventSlot.tryAcquire()) return Outcome.RETRY
        try {
            val job = TransferStore.read(context, id) ?: return Outcome.DONE
            val authority = TransferStore.secret(context, "owner") ?: return Outcome.DONE
            if (authority.optString("ownerId") != job.getJSONObject("snapshot").getString("ownerId")) return Outcome.DONE
            val ownerGeneration = authority.getString("generation")
            val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(3)
            fun gate() { if (stopped() || TransferStore.secret(context, "owner")?.optString("generation") != ownerGeneration) throw TransferStopped() }
            while (System.nanoTime() < deadline) {
                val current = TransferStore.read(context, id) ?: return Outcome.DONE
                val pending = current.getJSONArray("events"); if (pending.length() == 0) return Outcome.DONE
                val event = pending.getJSONObject(0)
                val receipt = TransferTransport.json(context, current, "events", event, ::gate)
                val acknowledgements = receipt.optJSONArray("acknowledgements") ?: throw IOException("Missing activity acknowledgement")
                require((0 until acknowledgements.length()).any { acknowledgements.getJSONObject(it).optString("eventId") == event.getString("eventId") }) { "Activity acknowledgement did not match" }
                TransferStore.update(context, id) { latest ->
                    val next = JSONArray(); val old = latest.getJSONArray("events")
                    for (i in 0 until old.length()) if (old.getJSONObject(i).getString("eventId") != event.getString("eventId")) next.put(old.getJSONObject(i))
                    latest.put("events", next)
                }
            }
            return Outcome.RETRY
        } catch (_: TransferStopped) { return Outcome.DONE }
          catch (error: TransferHttpFailure) { return if (error.status in setOf(401, 403, 404, 410)) Outcome.DONE else Outcome.RETRY }
          catch (_: Exception) { return Outcome.RETRY }
        finally { eventSlot.release() }
    }
    fun run(context: Context, id: String, attemptId: String = UUID.randomUUID().toString(), stopped: () -> Boolean = { false }): Outcome {
        var acquired = false
        try {
            while (!slot.tryAcquire(200, TimeUnit.MILLISECONDS)) { if (stopped()) return Outcome.DONE }
            acquired = true
            var job = TransferStore.read(context, id) ?: return Outcome.DONE
            if (stopped() || job.optBoolean("forgotten") || job.getString("status") in setOf("paused", "accepted", "auth_required", "needs_attention")) return Outcome.DONE
            val authority = TransferStore.secret(context, "owner") ?: return Outcome.DONE
            if (authority.optString("ownerId") != job.getJSONObject("snapshot").getString("ownerId")) return Outcome.DONE
            val ownerGeneration = authority.getString("generation"); val generation = job.getString("generation")
            job = TransferStore.update(context, id) {
                if (it.getString("status") == "uploading") TransferStore.event(context, it, "upload_interrupted", "unknown")
                if (it.getString("status") in setOf("uploading", "interrupted", "waiting_network")) TransferStore.event(context, it, "upload_resumed")
                it.put("status", "uploading").put("attemptId", attemptId).put("finalizing", false).remove("message")
            }!!
            TransferNotifications.show(context, job)
            var lastCheck = 0L
            fun assertCurrent(force: Boolean = false) {
                if (stopped()) throw TransferStopped()
                val now = System.nanoTime(); if (!force && now - lastCheck < 100_000_000L) return
                lastCheck = now
                val owner = TransferStore.secret(context, "owner"); val gate = TransferStore.gate(context, id)
                if (owner?.optString("generation") != ownerGeneration || gate?.optString("generation") != generation || gate.optString("attemptId") != attemptId || gate.optString("status") != "uploading") throw TransferStopped()
            }
            fun update(mutate: (JSONObject) -> Unit): JSONObject {
                assertCurrent(true)
                return TransferStore.update(context, id) { if (it.optString("attemptId") == attemptId && it.optString("generation") == generation) mutate(it) } ?: throw TransferStopped()
            }
            fun request(path: String, body: JSONObject?): JSONObject {
                assertCurrent(true); return TransferTransport.json(context, job, path, body) { assertCurrent() }
            }
            fun checkedStatus(): JSONObject {
                val receipt = request("status", null)
                for (field in listOf("sessionId", "ownerId", "type")) require(receipt.optString(field) == job.getJSONObject("snapshot").getString(field)) {
                    "Report status identity did not match this transfer"
                }
                // Preparing is recoverable only with positive same-session evidence.
                // Unconfirmed acceptance and removed reports must never be completed again.
                val repairableFailure = receipt.optString("status") == "failed" && receipt.opt("canResumeUploads") == true
                if (receipt.optString("code").isNotBlank() || receipt.optString("status") == "unavailable" ||
                    (!receipt.optBoolean("accepted") && receipt.optString("status") !in setOf("ready", "preparing") && !repairableFailure)) {
                    throw TransferHttpFailure(409, receipt.optString("code", "REPORT_UNAVAILABLE"))
                }
                return receipt
            }
            fun accepted(receipt: JSONObject): Boolean {
                if (!receipt.optBoolean("accepted")) return false
                if (job.optBoolean("historicalAcceptance")) receipt.put("reusedAcceptance", true)
                require(receipt.optString("sessionId") == job.getJSONObject("snapshot").getString("sessionId") && receipt.optBoolean("reportAvailable") && receipt.optString("reportId").isNotBlank() && receipt.optString("jobId").isNotBlank()) { "Accepted report receipt did not match this transfer" }
                for (field in listOf("type", "ownerId")) require(receipt.optString(field) == job.getJSONObject("snapshot").getString(field)) { "Accepted report owner/type did not match" }
                job = update {
                    it.put("receipt", receipt).put("finalizing", false)
                    if (receipt.optBoolean("reusedAcceptance")) it.put("status", "needs_attention").put("message", "An earlier report was accepted. Review Previews; this draft and its originals are retained.")
                    else it.put("status", "accepted").remove("message")
                }
                TransferNotifications.show(context, job); TransferCoordinator.scheduleEvents(context, id); return true
            }
            // Events are best effort: failure must not block a user's authorized byte transfer.
            if (events(context, id, stopped) == Outcome.RETRY) TransferCoordinator.scheduleEvents(context, id)
            val status = checkedStatus()
            if (accepted(status)) return Outcome.DONE
            val files = job.getJSONObject("snapshot").getJSONArray("files")
            // Completed media can precede durable queue publication. The backend's
            // preparing receipt authorizes only idempotent completion of this session;
            // file verification is locked at that point and must not strand recovery.
            mediaLoop@ for (index in 0 until if (status.optString("status") == "preparing") 0 else files.length()) {
                assertCurrent(true)
                val media = files.getJSONObject(index); val fileId = media.getString("fileId")
                // Hash before admission/each retry so a modified original cannot be silently skipped.
                val digest = TransferTransport.inspect(context, media) { assertCurrent() }
                val hashes = (TransferStore.read(context, id)!!.optJSONObject("hashes") ?: JSONObject())
                if (hashes.has(fileId) && hashes.getString(fileId) != digest) throw TransferOriginalUnavailable()
                job = update { if (!it.has("hashes")) it.put("hashes", JSONObject()); it.getJSONObject("hashes").put(fileId, digest) }
                val verified = try {
                    val receipt = request("files/$fileId/verify", JSONObject())
                    require(receipt.optString("fileId") == fileId && receipt.optBoolean("verified") && receipt.optLong("size") == media.getLong("size")) { "File verification did not match" }
                    true
                } catch (error: TransferHttpFailure) {
                    if (error.status == 409 && error.code in setOf("UPLOAD_NOT_VERIFIED", "UPLOAD_FILE_SIZE_MISMATCH")) false
                    else if (error.status == 409 && error.code == "UPLOAD_SESSION_LOCKED") {
                        val fresh = checkedStatus()
                        if (accepted(fresh)) return Outcome.DONE
                        if (fresh.optString("status") == "preparing") break@mediaLoop
                        // Another same-session file mutation can win the verify CAS
                        // while the session is still ready. Back off and reconcile
                        // next attempt; do not immediately resend original bytes.
                        if (fresh.optString("status") == "ready") throw IOException("File verification changed; retry this same report session")
                        throw error
                    }
                    else throw error
                }
                if (!verified) {
                    val receipt = TransferTransport.upload(context, job, media, digest) { assertCurrent() }
                    require(receipt.optString("fileId") == fileId && receipt.optLong("size") == media.getLong("size") && receipt.optString("key").isNotBlank()) { "Uploaded file receipt did not match" }
                }
                job = update {
                    val prior = it.getJSONArray("verifiedIds"); if ((0 until prior.length()).none { position -> prior.getString(position) == fileId }) prior.put(fileId)
                }
                TransferNotifications.show(context, job)
            }
            job = update { it.put("finalizing", true).put("completionAttempted", true) }
            TransferNotifications.show(context, job)
            try {
                val receipt = request("complete", JSONObject())
                for (field in listOf("sessionId", "ownerId", "type")) require(receipt.optString(field) == job.getJSONObject("snapshot").getString(field)) {
                    "Completion receipt identity did not match this report"
                }
                // Legacy complete responses vary. The exact status endpoint is the authoritative
                // session/report-availability receipt even after a lost completion response.
                if (receipt.optBoolean("reusedAcceptance")) {
                    job = update { it.put("historicalAcceptance", true) }
                    val checked = checkedStatus().put("reusedAcceptance", true)
                    if (accepted(checked)) return Outcome.DONE
                }
                if (accepted(checkedStatus())) return Outcome.DONE
                throw IOException("The server is still confirming the report")
            } catch (error: IOException) {
                if (error is TransferStopped) throw error
                if (accepted(checkedStatus())) return Outcome.DONE
                throw error
            }
        } catch (_: TransferStopped) { return Outcome.DONE }
          catch (_: InterruptedException) { Thread.currentThread().interrupt(); return Outcome.DONE }
          catch (error: Exception) {
            val current = TransferStore.read(context, id) ?: return Outcome.DONE
            if (stopped() || current.optString("attemptId") != attemptId || current.getString("status") in setOf("paused", "accepted") || current.optBoolean("forgotten")) return Outcome.DONE
            when {
                error is TransferHttpFailure && error.status in setOf(401, 403) -> TransferStore.update(context, id) {
                    it.put("status", "auth_required").put("finalizing", false).put("message", "Open the app while connected to renew report upload authorization.")
                    TransferStore.event(context, it, "upload_interrupted", "authentication_required")
                }
                error is TransferOriginalUnavailable || error is IllegalArgumentException || error is org.json.JSONException || (error is TransferHttpFailure && error.status in 400..499 && error.status !in setOf(408, 429) && error.code != "UPLOAD_SESSION_COMPLETION_STALE") -> TransferStore.update(context, id) {
                    it.put("status", "needs_attention").put("finalizing", false).put("message", if (error is TransferOriginalUnavailable) error.message else "This upload needs review. Open its saved draft; originals remain on this phone.")
                    TransferStore.event(context, it, "upload_failed", "unknown")
                }
                else -> {
                    interrupted(context, id, if (network(context)) "unknown" else "network_unavailable", attemptId)
                    TransferCoordinator.scheduleEvents(context, id); return Outcome.RETRY
                }
            }
            TransferStore.read(context, id)?.let { TransferNotifications.show(context, it) }
            TransferCoordinator.scheduleEvents(context, id)
            return Outcome.DONE
        } finally { if (acquired) slot.release() }
    }
}
