package expo.modules.capturebackup

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

object BackupCoordinator {
    private val lock = Any()
    private val identity = Regex("[a-zA-Z0-9._:-]{1,160}")
    private val allowedHeaders = setOf("x-device-key", "x-device-reinstall-id", "x-device-platform", "x-device-form-factor", "x-activity-source", "x-app-version")
    /** A disabled release revokes old authority, but never removes captured bytes or queue snapshots. */
    fun stopDisabledBuild(context: Context) = synchronized(lock) {
        if (BuildConfig.CAPTURE_BACKUP_ENABLED) return@synchronized
        BackupStore.clearAuthority(context)
        BackupStore.jobs(context).forEach { job ->
            val id = job.getString("id")
            BackupTransport.cancel(id)
            WorkManager.getInstance(context).cancelUniqueWork(workName(id))
        }
    }
    private fun requireEnabledBuild(context: Context) {
        if (!BuildConfig.CAPTURE_BACKUP_ENABLED) {
            stopDisabledBuild(context)
            error("Cloud backup is not enabled in this app release. Your device originals are unchanged.")
        }
    }
    fun configure(context: Context, value: JSONObject) = synchronized(lock) {
        requireEnabledBuild(context)
        val owner = value.getString("ownerId"); require(identity.matches(owner)) { "Invalid backup owner" }
        val base = value.getString("apiBaseUrl").trimEnd('/')
        val uri = Uri.parse(base)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null) { "Backup requires a secure API origin" }
        val policy = value.getString("networkPolicy"); require(policy in setOf("connected", "unmetered"))
        val old = BackupStore.authority(context)
        val sameOwner = old?.optString("ownerId") == owner && old.optString("apiBaseUrl") == base
        val policyChanged = sameOwner && old?.optString("networkPolicy") != policy
        val grantChanged = sameOwner && value.optString("token").isNotBlank() && value.optString("token") != old?.optString("token")
        if (old != null && !sameOwner) deactivate(context)
        val authority = if (sameOwner) old!! else JSONObject().put("generation", UUID.randomUUID().toString())
        if (policyChanged || grantChanged) authority.put("generation", UUID.randomUUID().toString())
        authority.put("ownerId", owner).put("apiBaseUrl", base).put("networkPolicy", policy)
        if (value.optString("token").isNotBlank()) {
            val token = value.getString("token")
            require(token.length in 16..8192 && !token.contains('\n') && !token.contains('\r')) { "Invalid backup grant" }
            val expiry = BackupStore.expiresAt(value.opt("expiresAt"))
            require(expiry > System.currentTimeMillis()) { "Backup authorization has expired" }
            val headers = value.optJSONObject("headers") ?: JSONObject()
            val safeHeaders = JSONObject()
            headers.keys().forEach { key ->
                val headerValue = headers.getString(key)
                require(key.lowercase() in allowedHeaders && headerValue.length <= 4096 && !headerValue.contains('\n') && !headerValue.contains('\r')) { "Unsupported backup header" }
                safeHeaders.put(key, headerValue)
            }
            authority.put("token", token).put("expiresAt", expiry).put("headers", safeHeaders)
        }
        BackupStore.saveAuthority(context, authority)
        BackupStore.jobs(context, owner).filter { !it.optBoolean("superseded") && it.optString("status") !in setOf("completed", "needs_attention") &&
            (it.optString("status") != "paused" || (it.optJSONArray("events")?.length() ?: 0) > 0) }.forEach { job ->
            if (BackupStore.hasGrant(authority)) {
                if (policyChanged || grantChanged) {
                    BackupTransport.cancel(job.getString("id"))
                    WorkManager.getInstance(context).cancelUniqueWork(workName(job.getString("id"))).result.get(30, TimeUnit.SECONDS)
                }
                BackupStore.update(context, job.getString("id")) { if (it.optString("status") == "auth_required") it.put("status", "queued").remove("message") }
                schedule(context, job.getString("id"))
            }
        }
    }
    private fun assertOwner(context: Context, owner: String): JSONObject = BackupStore.authority(context)?.takeIf { it.optString("ownerId") == owner }
        ?: error("Sign in to the backup owner account")
    fun enqueue(context: Context, source: JSONObject): Map<String, Any> = synchronized(lock) {
        requireEnabledBuild(context)
        val owner = source.getString("ownerId"); val authority = assertOwner(context, owner)
        val draft = source.getString("clientDraftId"); require(identity.matches(draft))
        require(identity.matches(source.getString("captureId")))
        val revision = source.getLong("revision"); require(revision > 0 && source.getDouble("revision") == revision.toDouble() && revision <= 9_007_199_254_740_991L)
        val media = source.getJSONArray("media"); require(media.length() in 0..6000)
        val ids = mutableSetOf<String>(); var bytes = 0L; var videos = 0; var photos = 0
        for (i in 0 until media.length()) {
            val item = media.getJSONObject(i)
            require(identity.matches(item.getString("clientFileId")) && ids.add(item.getString("clientFileId"))) { "Duplicate or invalid backup media identity" }
            val size = item.getLong("size"); val slot = item.getString("slot")
            if (slot == "video") videos++ else photos++
            require(photos <= 5000 && videos <= 1000) { "Backup exceeds the photo or video limit" }
            require(slot in setOf("main", "extra", "video") && size >= 0 && size <= if (slot == "video") 512L * 1024 * 1024 else 50L * 1024 * 1024) { "Backup original size is invalid" }
            bytes += size; require(bytes <= 20L * 1024 * 1024 * 1024)
            val uri = Uri.parse(item.getString("uri"))
            require(uri.scheme in setOf("file", "content") && !uri.path.isNullOrBlank()) { "Backup requires a local original" }
            require(item.getInt("index") >= 0 && identity.matches(item.getString("lotId")))
            require(item.getString("mimeType").matches(Regex("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")))
        }
        val id = BackupStore.id(owner, draft, revision)
        BackupStore.read(context, id)?.let { existing ->
            require(BackupStore.canonical(existing.getJSONObject("snapshot")) == BackupStore.canonical(source)) { "Backup revision already belongs to a different snapshot" }
            if (existing.optString("status") !in setOf("paused", "completed", "needs_attention")) schedule(context, id)
            return@synchronized BackupStore.summary(existing)
        }
        val previous = BackupStore.latest(context, owner, draft)
        require(previous == null || revision > previous.getLong("revision")) { "A newer backup revision is already saved" }
        val currentById = (0 until media.length()).map { media.getJSONObject(it) }.associateBy { it.getString("clientFileId") }
        val previousMedia = previous?.getJSONObject("snapshot")?.getJSONArray("media") ?: JSONArray()
        val preservesEarlierOriginals = (0 until previousMedia.length()).all { index ->
            val oldMedia = previousMedia.getJSONObject(index); val newer = currentById[oldMedia.getString("clientFileId")]
            newer != null && newer.getString("uri") == oldMedia.getString("uri") && newer.getLong("size") == oldMedia.getLong("size")
        }
        val paused = BackupStore.pauseReason(context, owner, draft) != null || previous?.optString("status") == "paused"
        val status = if (paused) "paused" else if (BackupStore.hasGrant(authority)) "queued" else "auth_required"
        val job = JSONObject().put("id", id).put("ownerId", owner).put("clientDraftId", draft).put("revision", revision)
            .put("snapshot", JSONObject(source.toString())).put("status", status).put("verifiedIds", JSONArray())
            .put("hashes", JSONObject()).put("sizes", JSONObject()).put("events", JSONArray()).put("updatedAt", BackupStore.now())
        // Carry unacknowledged observations forward with their original capture/revision and occurrence time.
        if (previous != null && preservesEarlierOriginals) job.put("events", JSONArray(previous.optJSONArray("events")?.toString() ?: "[]"))
        if (paused) job.put("pauseReason", BackupStore.pauseReason(context, owner, draft) ?: "user_pause")
        if (paused && previous == null) BackupStore.event(context, job, "backup_paused", job.getString("pauseReason"))
        BackupStore.save(context, job) // This is durable before acknowledgement to JS or scheduling.
        if (previous != null && preservesEarlierOriginals) {
            val previousId = previous.getString("id")
            BackupStore.update(context, previousId) { it.put("superseded", true).put("events", JSONArray()) }
            BackupTransport.cancel(previousId)
            WorkManager.getInstance(context).cancelUniqueWork(workName(previousId))
        }
        if (!paused && BackupStore.hasGrant(authority)) schedule(context, id)
        BackupStore.summary(job)
    }
    fun pause(context: Context, owner: String, draft: String, reason: String = "user_pause") = synchronized(lock) {
        assertOwner(context, owner)
        require(reason in setOf("user_pause", "draft_deleted"))
        BackupStore.setPause(context, owner, draft, reason)
        for (job in BackupStore.jobs(context, owner).filter { it.optString("clientDraftId") == draft && !it.optBoolean("superseded") }) {
        if (job.optString("status") == "completed" || (job.optString("status") == "paused" && job.optString("pauseReason") == reason)) continue
        val id = job.getString("id")
        BackupStore.update(context, id) {
            it.put("status", "paused").put("pauseReason", reason).put("message", if (reason == "draft_deleted") "Backup paused after draft deletion" else "Backup paused")
            BackupStore.event(context, it, "backup_paused", reason)
        }
        BackupTransport.cancel(id)
        WorkManager.getInstance(context).cancelUniqueWork(workName(id)).result.get(30, TimeUnit.SECONDS)
        // An event-only pass never transfers media while paused.
        schedule(context, id)
        }
    }
    fun resume(context: Context, owner: String, draft: String) = synchronized(lock) {
        requireEnabledBuild(context)
        val authority = assertOwner(context, owner)
        require(BackupStore.pauseReason(context, owner, draft) != "draft_deleted") { "This draft was discarded. Its backup remains paused." }
        BackupStore.setPause(context, owner, draft, null)
        for (job in BackupStore.jobs(context, owner).filter { it.optString("clientDraftId") == draft && !it.optBoolean("superseded") }) {
        if (job.optString("status") == "completed") continue
        val id = job.getString("id")
        BackupStore.update(context, id) {
            if (it.optString("status") in setOf("paused", "interrupted", "needs_attention", "auth_required", "waiting_network")) BackupStore.event(context, it, "backup_resumed", "unknown")
            it.put("status", if (BackupStore.hasGrant(authority)) "queued" else "auth_required").remove("message")
            it.remove("pauseReason")
        }
        schedule(context, id)
        }
    }
    fun list(context: Context, owner: String): List<Map<String, Any>> = synchronized(lock) {
        assertOwner(context, owner)
        BackupStore.summaries(context, owner).filter { !it.optBoolean("superseded") }.groupBy { it.getString("clientDraftId") }.values.map { revisions ->
            val latest = revisions.maxBy { it.getLong("revision") }
            val earlier = revisions.filter { it !== latest && it.optString("status") != "completed" }
            buildMap<String, Any> {
                latest.keys().forEach { key -> if (key !in setOf("id", "ownerId", "superseded", "attemptId", "storageVersion")) put(key, latest.get(key)) }
                put("retainedEarlierRevisionsPending", earlier.size)
                if (earlier.isNotEmpty()) {
                    val priorities = listOf("auth_required", "needs_attention", "paused", "interrupted", "waiting_network", "uploading", "queued")
                    put("retainedEarlierRevisionsStatus", earlier.minBy { priorities.indexOf(it.getString("status")) }.getString("status"))
                }
            }
        }
    }
    fun deactivate(context: Context) = synchronized(lock) {
        val owner = BackupStore.authority(context)?.optString("ownerId")
        BackupStore.clearAuthority(context) // Remove authority before cancelling an in-flight operation.
        BackupStore.jobs(context, owner).forEach { job ->
            val id = job.getString("id"); BackupTransport.cancel(id)
            WorkManager.getInstance(context).cancelUniqueWork(workName(id))
            if (job.optString("status") !in setOf("completed", "paused")) BackupStore.update(context, id) {
                it.put("status", "auth_required").put("message", "Open the app and sign in to continue backup")
            }
        }
    }
    fun workName(id: String) = "asset-insight-capture-backup-$id"
    fun schedule(context: Context, id: String, append: Boolean = false, initialDelayMillis: Long = 0) {
        if (!BuildConfig.CAPTURE_BACKUP_ENABLED) {
            stopDisabledBuild(context)
            return
        }
        val authority = BackupStore.authority(context) ?: return
        if (!BackupStore.hasGrant(authority)) return
        val job = BackupStore.read(context, id) ?: return
        if (job.optString("ownerId") != authority.optString("ownerId") || job.optBoolean("superseded")) return
        val network = if (authority.optString("networkPolicy") == "unmetered") NetworkType.UNMETERED else NetworkType.CONNECTED
        val request = OneTimeWorkRequestBuilder<BackupWorker>()
            .setInputData(Data.Builder().putString("id", id).build())
            .setInitialDelay(initialDelayMillis, TimeUnit.MILLISECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork(workName(id), if (append) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, request)
            .result.get(30, TimeUnit.SECONDS)
    }
}
