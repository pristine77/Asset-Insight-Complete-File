package expo.modules.capturebackup

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

/** Bounded batches checkpoint before yielding. No foreground service or React runtime is required. */
class BackupWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        if (!BuildConfig.CAPTURE_BACKUP_ENABLED) {
            BackupCoordinator.stopDisabledBuild(applicationContext)
            return Result.success()
        }
        val id = inputData.getString("id") ?: return Result.failure()
        return when (BackupEngine.run(applicationContext, id, attemptId = this.id.toString()) { isStopped }) {
            BackupEngine.Outcome.DONE -> Result.success()
            BackupEngine.Outcome.MORE -> {
                BackupCoordinator.schedule(applicationContext, id, append = true)
                Result.success()
            }
            BackupEngine.Outcome.RETRY -> Result.retry()
        }
    }
    override fun onStopped() {
        if (!BuildConfig.CAPTURE_BACKUP_ENABLED) return
        val id = inputData.getString("id") ?: return
        if (BackupStore.gate(applicationContext, id)?.optString("attemptId") != this.id.toString()) return
        BackupTransport.cancel(id)
        val reason = when {
            stopReason == WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY -> "network_unavailable"
            stopReason > 0 && stopReason != WorkInfo.STOP_REASON_CANCELLED_BY_APP -> "system_interruption"
            else -> "unknown"
        }
        BackupEngine.interrupted(applicationContext, id, reason, this.id.toString())
    }
}

/** Also exercised directly by isolated Android instrumentation; production uses only BackupWorker. */
object BackupEngine {
    enum class Outcome { DONE, MORE, RETRY }
    private fun hasNetwork(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }
    fun interrupted(context: Context, id: String, reason: String, attemptId: String? = null) {
        BackupStore.update(context, id) { job ->
            if ((attemptId == null || job.optString("attemptId") == attemptId) && !job.optBoolean("superseded") && job.optString("status") !in setOf("paused", "completed", "auth_required", "needs_attention", "interrupted", "waiting_network")) {
                job.put("status", if (reason == "network_unavailable") "waiting_network" else "interrupted")
                    .put("message", if (reason == "network_unavailable") "Waiting for a connection" else "Backup will continue when Android allows")
                BackupStore.event(context, job, "backup_interrupted", reason)
            }
        }
    }
    fun run(context: Context, id: String, attemptId: String = UUID.randomUUID().toString(), stopped: () -> Boolean = { false }): Outcome {
        if (!BuildConfig.CAPTURE_BACKUP_ENABLED) {
            BackupCoordinator.stopDisabledBuild(context)
            return Outcome.DONE
        }
        if (stopped()) return Outcome.DONE
        var job = BackupStore.read(context, id) ?: return Outcome.DONE
        if (job.optBoolean("superseded") || job.optString("status") in setOf("completed", "needs_attention")) return Outcome.DONE
        val authority = BackupStore.authority(context)
        if (authority == null || authority.optString("ownerId") != job.optString("ownerId") || !BackupStore.hasGrant(authority)) {
            BackupStore.update(context, id) { current ->
                if (current.optString("status") != "paused") {
                    if (current.optString("status") != "auth_required") BackupStore.event(context, current, "backup_interrupted", "authentication_required")
                    current.put("status", "auth_required").put("message", "Open the app while connected to authorize backup")
                }
            }
            return Outcome.DONE
        }
        BackupStore.update(context, id) { it.put("attemptId", attemptId) }
        fun updateCurrent(operation: (JSONObject) -> Unit): JSONObject? = BackupStore.update(context, id) { current ->
            if (current.optString("attemptId") == attemptId) operation(current)
        }
        val generation = authority.getString("generation")
        val deadline = System.nanoTime() + 4L * 60 * 1_000_000_000
        var lastGateCheck = 0L
        fun assertCurrent(allowPaused: Boolean = false, force: Boolean = false) {
            if (stopped()) throw BackupStopped()
            val now = System.nanoTime()
            // Do not parse a 5,000-file journal for every 64 KiB. Pause also cancels active HTTP immediately.
            if (!force && now - lastGateCheck < 100_000_000L) return
            lastGateCheck = now
            val currentAuthority = BackupStore.authority(context)
            val current = BackupStore.gate(context, id)
            if (currentAuthority?.optString("generation") != generation || currentAuthority.optString("ownerId") != job.optString("ownerId") ||
                current == null || current.optString("attemptId") != attemptId || current.optBoolean("superseded") || (!allowPaused && current.optString("status") == "paused")) throw BackupStopped()
            if (!BackupStore.hasGrant(currentAuthority)) throw BackupHttpFailure(401)
        }
        fun request(path: String, body: JSONObject?, allowPaused: Boolean = false): JSONObject {
            assertCurrent(allowPaused, force = true)
            val currentAuthority = BackupStore.authority(context) ?: throw BackupStopped()
            return BackupTransport.request(id, currentAuthority, path, body) { assertCurrent(allowPaused, force = true) }
        }
        fun receipt(value: JSONObject) {
            val snapshot = job.getJSONObject("snapshot")
            if (value.optString("id").isBlank() || value.optString("ownerId") != snapshot.getString("ownerId") ||
                value.optString("clientDraftId") != snapshot.getString("clientDraftId") || value.optString("captureId") != snapshot.getString("captureId") ||
                value.optString("type") != snapshot.getString("type") || value.optLong("revision") != snapshot.getLong("revision") ||
                value.optInt("total", -1) != snapshot.getJSONArray("media").length() || value.optInt("verified", -1) !in 0..snapshot.getJSONArray("media").length()) {
                throw IOException("The backup receipt did not match this saved draft")
            }
        }
        try {
            val paused = job.optString("status") == "paused"
            if (!paused) {
                updateCurrent { current ->
                    when (current.optString("status")) {
                        "uploading" -> { // The previous process did not checkpoint its exit.
                            BackupStore.event(context, current, "backup_interrupted", "unknown")
                            BackupStore.event(context, current, "backup_resumed", "unknown")
                        }
                        "interrupted", "waiting_network" -> BackupStore.event(context, current, "backup_resumed", "unknown")
                    }
                    if (!current.optBoolean("started")) { BackupStore.event(context, current, "backup_started", "unknown"); current.put("started", true) }
                    current.put("status", "uploading").remove("message")
                }
            }
            job = BackupStore.read(context, id) ?: return Outcome.DONE
            val snapshot = job.getJSONObject("snapshot"); val media = snapshot.getJSONArray("media")
            val events = job.optJSONArray("events") ?: JSONArray()
            for (index in 0 until events.length()) {
                if (System.nanoTime() >= deadline) {
                    if (!paused) updateCurrent { it.put("status", "queued") }
                    return Outcome.MORE
                }
                val event = events.getJSONObject(index)
                val acknowledged = request("/events", event, allowPaused = true)
                require(acknowledged.optBoolean("accepted") && acknowledged.optString("eventId") == event.getString("eventId")) { "Backup activity acknowledgement did not match" }
                updateCurrent { current ->
                    val pending = current.getJSONArray("events"); val remaining = JSONArray()
                    for (position in 0 until pending.length()) if (pending.getJSONObject(position).getString("eventId") != event.getString("eventId")) remaining.put(pending.getJSONObject(position))
                    current.put("events", remaining)
                }
            }
            if (paused) return Outcome.DONE
            var planId = job.optString("planId")
            if (planId.isBlank()) {
                for (index in 0 until media.length()) {
                    assertCurrent()
                    val item = media.getJSONObject(index); val fileId = item.getString("clientFileId")
                    if (!job.getJSONObject("hashes").has(fileId)) {
                        val inspected = BackupTransport.inspect(context, item) { assertCurrent() }
                        job = updateCurrent {
                            it.getJSONObject("hashes").put(fileId, inspected.first)
                            it.getJSONObject("sizes").put(fileId, inspected.second)
                        } ?: return Outcome.DONE
                        if (System.nanoTime() >= deadline) {
                            updateCurrent { it.put("status", "queued") }
                            return Outcome.MORE
                        }
                    }
                }
                val payload = JSONObject(snapshot.toString()); payload.remove("ownerId")
                val cloudMedia = payload.getJSONArray("media")
                for (index in 0 until cloudMedia.length()) {
                    val item = cloudMedia.getJSONObject(index); item.remove("uri")
                    item.put("sha256", job.getJSONObject("hashes").getString(item.getString("clientFileId")))
                    item.put("size", job.getJSONObject("sizes").getLong(item.getString("clientFileId")))
                }
                require((0 until cloudMedia.length()).sumOf { cloudMedia.getJSONObject(it).getLong("size") } <= 20L * 1024 * 1024 * 1024) { "Backup exceeds the supported total original size" }
                // Reject unexpected local paths in fields; they are never sent to the API.
                BackupStore.assertNoLocalReferences(payload)
                val created = request("/plans", payload); receipt(created); planId = created.getString("id")
                updateCurrent { it.put("planId", planId) }
            }
            assertCurrent()
            // Always reconcile the immutable plan before sending bytes after interruption.
            val remote = request("/plans/$planId/status", null); receipt(remote)
            if (remote.optString("status") == "complete" && remote.getInt("verified") == media.length()) {
                updateCurrent { it.put("status", "completed").put("verifiedIds", JSONArray((0 until media.length()).map { i -> media.getJSONObject(i).getString("clientFileId") })).remove("message") }
                return Outcome.DONE
            }
            job = BackupStore.read(context, id) ?: return Outcome.DONE
            val verified = job.getJSONArray("verifiedIds"); val verifiedSet = (0 until verified.length()).map { verified.getString(it) }.toMutableSet()
            while (System.nanoTime() < deadline) {
            val pending = (0 until media.length()).map { index -> JSONObject(media.getJSONObject(index).toString()).also { it.put("size", job.getJSONObject("sizes").getLong(it.getString("clientFileId"))) } }
                .filter { it.getString("clientFileId") !in verifiedSet }.take(2)
            val fileIds = JSONArray(pending.map { it.getString("clientFileId") })
            if (pending.isNotEmpty()) {
                val targets = request("/plans/$planId/targets", JSONObject().put("fileIds", fileIds)).getJSONArray("targets")
                require(targets.length() == pending.size) { "Backup storage targets were incomplete" }
                val byId = (0 until targets.length()).map { targets.getJSONObject(it) }.associateBy { it.getString("clientFileId") }
                require(byId.size == pending.size && pending.all { byId.containsKey(it.getString("clientFileId")) })
                for (item in pending) {
                    assertCurrent(); val fileId = item.getString("clientFileId"); val target = byId.getValue(fileId)
                    if (!target.optBoolean("alreadyUploaded")) BackupTransport.put(context, id, item, target, job.getJSONObject("hashes").getString(fileId)) { assertCurrent() }
                    else if (BackupTransport.digest(context, item) { assertCurrent() } != job.getJSONObject("hashes").getString(fileId)) throw BackupOriginalUnavailable()
                    val confirmed = request("/plans/$planId/confirm", JSONObject().put("fileIds", JSONArray().put(fileId))); receipt(confirmed)
                    verifiedSet.add(fileId)
                    updateCurrent { it.put("verifiedIds", JSONArray(verifiedSet.toList())) }
                    if (confirmed.optString("status") == "complete" && confirmed.getInt("verified") == media.length()) {
                        updateCurrent { it.put("status", "completed").put("verifiedIds", JSONArray((0 until media.length()).map { i -> media.getJSONObject(i).getString("clientFileId") })).remove("message") }
                        return Outcome.DONE
                    }
                }
            } else {
                // Retry completion with an actual immutable original: the API deliberately
                // rejects empty confirmation lists. Empty plans complete during registration.
                if (media.length() == 0) throw IOException("Empty backup registration has not finalized")
                val confirmed = request("/plans/$planId/confirm", JSONObject().put("fileIds", JSONArray().put(media.getJSONObject(media.length() - 1).getString("clientFileId")))); receipt(confirmed)
                if (confirmed.optString("status") == "complete" && confirmed.getInt("verified") == media.length()) {
                    updateCurrent { it.put("status", "completed").remove("message") }; return Outcome.DONE
                }
                throw IOException("Final backup verification is still pending")
            }
            }
            updateCurrent { it.put("status", "queued") }
            return Outcome.MORE
        } catch (_: BackupStopped) { return Outcome.DONE }
          catch (_: BackupOriginalUnavailable) {
            updateCurrent { if (it.optString("status") != "paused") it.put("status", "needs_attention").put("message", "An original is missing or changed. Review the saved draft; originals were not removed.") }
            return Outcome.DONE
        } catch (error: Exception) {
            val current = BackupStore.read(context, id) ?: return Outcome.DONE
            if (current.optString("attemptId") != attemptId || current.optBoolean("superseded") || stopped()) return Outcome.DONE
            if (current.optString("status") == "paused") {
                // A paused media job can still retry its metadata-only activity outbox.
                return if (error is IOException && (error !is BackupHttpFailure || error.status in setOf(408, 429) || error.status >= 500)) Outcome.RETRY else Outcome.DONE
            }
            if (error is BackupHttpFailure && error.grantRequest && error.status in setOf(401, 403)) {
                updateCurrent {
                    it.put("status", "auth_required").put("message", "Open the app while connected to renew backup authorization")
                    BackupStore.event(context, it, "backup_interrupted", "authentication_required")
                }; return Outcome.DONE
            }
            if (error is BackupHttpFailure && !error.grantRequest && error.status in setOf(401, 403)) {
                interrupted(context, id, "unknown", attemptId) // An expired presigned URL is refreshed by the same-plan retry.
                return Outcome.RETRY
            }
            if (error is IllegalArgumentException || error is org.json.JSONException || (error is BackupHttpFailure && error.status in 400..499 && error.status !in setOf(408, 429))) {
                updateCurrent { it.put("status", "needs_attention").put("message", "Backup needs review. Open the saved draft and retry; originals were not removed.") }
                return Outcome.DONE
            }
            interrupted(context, id, if (hasNetwork(context)) "unknown" else "network_unavailable", attemptId)
            return Outcome.RETRY
        }
    }
}
