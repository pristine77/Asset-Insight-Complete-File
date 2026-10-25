package expo.modules.reporttransfer

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.util.Log
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

object TransferCoordinator {
    private val lock = Any()
    private val identity = Regex("[a-zA-Z0-9._:-]{1,160}")
    private val allowedHeaders = setOf("x-device-key", "x-device-reinstall-id", "x-device-platform", "x-device-form-factor", "x-activity-source", "x-app-version")
    fun configure(context: Context, value: JSONObject) = synchronized(lock) {
        val owner = value.getString("ownerId"); require(identity.matches(owner))
        val base = value.getString("apiBaseUrl").trimEnd('/'); val uri = Uri.parse(base)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null) { "Report transfer requires a secure API origin" }
        val prior = TransferStore.secret(context, "owner")
        if (prior != null && (prior.optString("ownerId") != owner || prior.optString("apiBaseUrl") != base)) deactivate(context)
        val headers = value.optJSONObject("headers") ?: JSONObject()
        val safe = JSONObject()
        headers.keys().forEach { key ->
            val text = headers.getString(key)
            require(key.lowercase() in allowedHeaders && text.length <= 4096 && !text.contains('\n') && !text.contains('\r')) { "Unsupported report transfer header" }
            safe.put(key, text)
        }
        val same = prior?.optString("ownerId") == owner && prior.optString("apiBaseUrl") == base
        TransferStore.saveSecret(context, "owner", JSONObject().put("ownerId", owner).put("apiBaseUrl", base)
            .put("generation", if (same) prior!!.getString("generation") else UUID.randomUUID().toString()).put("headers", safe))
        // A removed OS job may be a Task Manager/force-stop. No callback proves its
        // cause, and the app must not recreate a UIDT job stopped by the user.
        if (Build.VERSION.SDK_INT >= 34) {
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            TransferStore.jobs(context).filter { it.getJSONObject("snapshot").optString("ownerId") == owner && !it.optBoolean("forgotten") &&
                it.getString("status") in setOf("queued", "uploading", "interrupted", "waiting_network") }.forEach { job ->
                val schedulerId = job.getInt("schedulerId")
                val absent = scheduler.getPendingJob(schedulerId) == null
                val stoppedBySystemUserControl = if (Build.VERSION.SDK_INT >= 36) scheduler.getPendingJobReasons(schedulerId).contains(JobScheduler.PENDING_JOB_REASON_USER)
                    else scheduler.getPendingJobReason(schedulerId) == JobScheduler.PENDING_JOB_REASON_USER
                if (!absent && !stoppedBySystemUserControl) return@forEach
                TransferStore.update(context, job.getString("id")) { current ->
                    if (current.getString("status") in setOf("queued", "uploading", "interrupted", "waiting_network")) {
                        current.put("status", "paused").put("finalizing", false).put("message", if (stoppedBySystemUserControl) "Android stopped this transfer. Tap Resume to continue."
                            else "This transfer stopped while the app was closed. Tap Resume to continue; the cause was not recorded.")
                        TransferStore.event(context, current, "upload_interrupted", if (stoppedBySystemUserControl) "system_stop" else "unknown")
                    }
                }
                scheduleEvents(context, job.getString("id"))
            }
        }
        requeueNonVpnJobs(context, owner)
    }
    /**
     * Jobs queued by builds before 2026-10-11 demanded a non-VPN network and never start
     * while a VPN (NordVPN, a company VPN) is on. Re-queue those with the current rule.
     * Called at configure and from list(), which the app polls every 2 s while open, so a
     * refusal at start-up is retried. schedule() leaves a running job alone.
     */
    private fun requeueNonVpnJobs(context: Context, owner: String) {
        if (Build.VERSION.SDK_INT < 34) return
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        TransferStore.jobs(context).filter { it.getJSONObject("snapshot").optString("ownerId") == owner && !it.optBoolean("forgotten") &&
            it.getString("status") in setOf("queued", "uploading", "interrupted", "waiting_network") }.forEach { job ->
            val pending = scheduler.getPendingJob(job.getInt("schedulerId")) ?: return@forEach
            if (pending.requiredNetwork?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) != true) return@forEach
            if (scheduler.getPendingJobReason(job.getInt("schedulerId")) == JobScheduler.PENDING_JOB_REASON_EXECUTING) return@forEach
            try {
                // jobs() intentionally contains compact metadata, not files.
                // Only this legacy pending job needs its immutable byte sizes;
                // normal polling and running jobs keep the metadata-only path.
                TransferStore.read(context, job.getString("id"))?.let { schedule(context, it) }
            } catch (error: Exception) {
                Log.w("ReportTransfer", "Could not re-queue ${job.getString("id")} for VPN networks; Pause and Resume re-queues it", error)
            }
        }
    }
    private fun authority(context: Context, owner: String) = TransferStore.secret(context, "owner")?.takeIf { it.optString("ownerId") == owner }
        ?: error("Sign in to the report owner account")
    private fun grant(context: Context, id: String, value: JSONObject) {
        val token = value.getString("token"); val expiresAt = TransferStore.expiry(value.opt("expiresAt"))
        require(token.length in 16..8192 && !token.contains('\n') && !token.contains('\r') && expiresAt > System.currentTimeMillis() + 30_000L) { "Report transfer authorization has expired" }
        TransferStore.saveSecret(context, id, JSONObject().put("token", token).put("expiresAt", expiresAt))
    }
    fun enqueue(context: Context, value: JSONObject): Map<String, Any> = synchronized(lock) {
        val owner = value.getString("ownerId"); val authority = authority(context, owner)
        val draft = value.getString("clientDraftId"); val session = value.getString("sessionId")
        require(identity.matches(draft) && identity.matches(session))
        require(identity.matches(value.getString("captureId")) && identity.matches(value.getString("clientSubmissionId")))
        require(value.getString("type") in setOf("asset", "lotListing"))
        val revision = value.getLong("revision"); require(revision > 0 && revision <= 9_007_199_254_740_991L && value.getDouble("revision") == revision.toDouble())
        val files = value.getJSONArray("files"); require(files.length() in 1..6000)
        val seen = mutableSetOf<String>(); var bytes = 0L; var photos = 0; var videos = 0
        for (index in 0 until files.length()) {
            val media = files.getJSONObject(index); val size = media.getLong("size")
            require(identity.matches(media.getString("fileId")) && seen.add(media.getString("fileId"))) { "Duplicate transfer file identity" }
            val type = media.getString("type"); require(type.matches(Regex("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")))
            val video = type.startsWith("video/"); if (video) videos++ else photos++
            require(size > 0 && size <= if (video) 512L * 1024 * 1024 else 50L * 1024 * 1024)
            bytes += size; require(bytes <= 20L * 1024 * 1024 * 1024 && photos <= 5000 && videos <= 1000)
            val uri = Uri.parse(media.getString("uri")); require(uri.scheme in setOf("file", "content") && !uri.path.isNullOrBlank())
            TransferTransport.requireDurableOriginal(context, media)
            require(media.getString("name").length in 1..512 && !media.getString("name").contains('\n') && !media.getString("name").contains('\r'))
        }
        val previous = TransferStore.jobs(context).filter { it.getJSONObject("snapshot").optString("ownerId") == owner && it.getJSONObject("snapshot").optString("clientDraftId") == draft }
        require(previous.none { it.getJSONObject("snapshot").getLong("revision") > revision }) { "A newer saved revision already owns this transfer" }
        val id = TransferStore.id(owner, draft, session, revision)
        val old = TransferStore.read(context, id)
        val snapshot = JSONObject(value.toString()); snapshot.remove("grant")
        val headers = authority.getJSONObject("headers")
        val appVersion = old?.getJSONObject("snapshot")?.optString("appVersion") ?: headers.keys().asSequence()
            .firstOrNull { it.equals("x-app-version", ignoreCase = true) }?.let { headers.optString(it) }.orEmpty()
        if (appVersion.matches(Regex("[a-zA-Z0-9 ._()+-]{1,80}"))) snapshot.put("appVersion", appVersion)
        if (old != null) {
            require(TransferStore.canonical(old.getJSONObject("snapshot")) == TransferStore.canonical(snapshot)) { "This queued report already has a different immutable snapshot" }
            if (old.getString("status") == "accepted") return@synchronized TransferStore.summary(old)
            grant(context, id, value.getJSONObject("grant"))
            if (old.optBoolean("forgotten")) {
                require(!old.optBoolean("completionAttempted") && previous.none { it.getString("id") != id && !it.optBoolean("forgotten") }) { "Another immutable transfer owns this draft" }
                TransferStore.update(context, id) { it.put("forgotten", false).put("status", "paused") }
            }
            if (old.getString("status") in setOf("auth_required", "paused", "needs_attention")) resume(context, owner, draft, null)
            else schedule(context, old)
            return@synchronized TransferStore.summary(TransferStore.read(context, id)!!)
        }
        require(TransferStore.jobs(context).none { it.getJSONObject("snapshot").optString("ownerId") == owner && it.getJSONObject("snapshot").optString("clientDraftId") == draft && !it.optBoolean("forgotten") }) { "This draft already has a queued transfer" }
        grant(context, id, value.getJSONObject("grant"))
        val job = JSONObject().put("id", id).put("snapshot", snapshot).put("schedulerId", TransferStore.nextSchedulerId(context))
            .put("generation", UUID.randomUUID().toString()).put("status", "queued").put("verifiedIds", JSONArray()).put("events", JSONArray())
        val priorSessionJobs = previous.filter { it.optBoolean("forgotten") && it.getJSONObject("snapshot").getString("sessionId") == session }
        val retainedEventIds = mutableSetOf<String>()
        for (prior in priorSessionJobs) {
            val pending = prior.getJSONArray("events")
            for (index in 0 until pending.length()) {
                val event = pending.getJSONObject(index)
                if (retainedEventIds.add(event.getString("eventId"))) job.getJSONArray("events").put(JSONObject(event.toString()))
            }
        }
        TransferStore.event(context, job, "upload_queued")
        TransferStore.save(context, job) // Receipt to React follows durable save AND scheduler admission.
        // New authority replaces the same-session grant. Transfer observations
        // durably first; a crash before clearing old rows merely resends UUIDs.
        priorSessionJobs.forEach { prior -> TransferStore.update(context, prior.getString("id")) { old ->
            val remaining = JSONArray(); val pending = old.getJSONArray("events")
            for (index in 0 until pending.length()) if (pending.getJSONObject(index).getString("eventId") !in retainedEventIds) remaining.put(pending.getJSONObject(index))
            old.put("events", remaining)
        } }
        try { schedule(context, job) } catch (error: Exception) {
            TransferStore.update(context, id) { it.put("status", "paused").put("message", "Report saved. Open the app and tap Resume to start the transfer.") }
            throw error
        }
        TransferStore.summary(job)
    }
    private fun owned(context: Context, owner: String, draft: String): JSONObject {
        authority(context, owner)
        val metadata = TransferStore.jobs(context).lastOrNull { !it.optBoolean("forgotten") && it.getJSONObject("snapshot").optString("ownerId") == owner && it.getJSONObject("snapshot").optString("clientDraftId") == draft }
            ?: error("The queued report is unavailable")
        return TransferStore.read(context, metadata.getString("id")) ?: error("The queued report is unavailable")
    }
    fun pause(context: Context, owner: String, draft: String) = synchronized(lock) {
        val job = owned(context, owner, draft); val id = job.getString("id")
        if (job.getString("status") in setOf("accepted", "paused")) return@synchronized
        require(!job.optBoolean("finalizing")) { "The server is accepting this report. Check its status before pausing." }
        var didPause = false
        TransferStore.update(context, id) {
            if (it.getString("status") in setOf("accepted", "paused")) return@update
            require(!it.optBoolean("finalizing")) { "The server is accepting this report. Check its status before pausing." }
            it.put("status", "paused").put("generation", UUID.randomUUID().toString()).put("message", "Upload paused. Originals are saved on this phone.")
            TransferStore.event(context, it, "upload_paused", "user_pause")
            didPause = true
        }
        if (!didPause) return@synchronized
        cancel(context, job); scheduleEvents(context, id)
        TransferNotifications.show(context, TransferStore.read(context, id)!!)
    }
    fun resume(context: Context, owner: String, draft: String, updatedGrant: JSONObject?) = synchronized(lock) {
        val job = owned(context, owner, draft); val id = job.getString("id")
        if (job.getString("status") == "accepted") return@synchronized
        if (updatedGrant != null) grant(context, id, updatedGrant)
        require((TransferStore.secret(context, id)?.optLong("expiresAt") ?: 0) > System.currentTimeMillis() + 30_000L) { "Reconnect to renew report upload authorization" }
        cancel(context, job)
        val current = TransferStore.update(context, id) {
            it.put("status", "queued").put("finalizing", false).put("generation", UUID.randomUUID().toString()).remove("message")
            TransferStore.event(context, it, "upload_resumed")
        }!!
        schedule(context, current)
        scheduleEvents(context, id)
    }
    fun forget(context: Context, owner: String, draft: String) = synchronized(lock) {
        val job = owned(context, owner, draft)
        require(job.getString("status") in setOf("paused", "auth_required", "needs_attention")) { "Pause this transfer before opening or discarding its draft" }
        require(!job.optBoolean("completionAttempted")) { "The server may already have accepted this report. Resume this same upload to confirm its status before editing." }
        TransferStore.update(context, job.getString("id")) { it.put("forgotten", true).put("generation", UUID.randomUUID().toString()) }
        cancel(context, job); scheduleEvents(context, job.getString("id"))
    }
    fun list(context: Context, owner: String): List<Map<String, Any>> = synchronized(lock) {
        authority(context, owner)
        requeueNonVpnJobs(context, owner)
        TransferStore.jobs(context).filter { !it.optBoolean("forgotten") && it.getJSONObject("snapshot").optString("ownerId") == owner }
            .sortedBy { it.getInt("schedulerId") }.map { TransferStore.summary(it) }
    }
    fun deactivate(context: Context) = synchronized(lock) {
        TransferStore.clearSecret(context, "owner") // Fence transports before cancelling scheduler callbacks.
        TransferStore.jobs(context).forEach { job ->
            val id = job.getString("id"); TransferStore.clearSecret(context, id); cancel(context, job)
            if (job.getString("status") != "accepted" && !job.optBoolean("forgotten")) TransferStore.update(context, id) {
                it.put("generation", UUID.randomUUID().toString()).put("finalizing", false).put("status", "auth_required")
                    .put("message", "Sign in to the report owner account and tap Resume.")
                TransferStore.event(context, it, "upload_interrupted", "authentication_required")
            }
            TransferNotifications.cancel(context, job)
        }
    }
    fun cancel(context: Context, job: JSONObject) {
        TransferTransport.cancel(job.getString("id"))
        (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(job.getInt("schedulerId"))
        WorkManager.getInstance(context).cancelUniqueWork("report-transfer-" + job.getString("id"))
    }
    fun schedule(context: Context, job: JSONObject) {
        if (job.getString("status") in setOf("paused", "auth_required", "needs_attention", "accepted") || job.optBoolean("forgotten")) return
        val id = job.getString("id")
        if (Build.VERSION.SDK_INT >= 34) {
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            val schedulerId = job.getInt("schedulerId")
            val pending = scheduler.getPendingJob(schedulerId)
            // Jobs queued by earlier builds demanded a non-VPN network and never start while
            // a VPN (NordVPN, a company VPN) is on. Re-queue those, unless one is running.
            val waitsForNonVpn = pending?.requiredNetwork?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) == true
            if (pending != null && (!waitsForNonVpn || scheduler.getPendingJobReason(schedulerId) == JobScheduler.PENDING_JOB_REASON_EXECUTING)) return
            val bytes = job.getJSONObject("snapshot").getJSONArray("files").let { files -> (0 until files.length()).sumOf { files.getJSONObject(it).getLong("size") } }
            // NETWORK_TYPE_ANY is the platform's "any validated internet" rule and allows VPNs,
            // as WorkManager's CONNECTED does below Android 14. A bare NetworkRequest.Builder()
            // keeps NOT_VPN, so with a VPN as the default network the upload never started
            // (phone test 2026-10-11, NordVPN: "Unsatisfied constraints: CONNECTIVITY").
            val info = JobInfo.Builder(schedulerId, ComponentName(context, TransferJobService::class.java))
                .setExtras(PersistableBundle().apply { putString("id", id) }).setPersisted(true).setUserInitiated(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setEstimatedNetworkBytes(1024L * 1024, bytes).setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build()
            check(scheduler.schedule(info) == JobScheduler.RESULT_SUCCESS) { "Open the app and tap Resume to schedule this report upload" }
        } else {
            val work = OneTimeWorkRequestBuilder<TransferWorker>().setInputData(Data.Builder().putString("id", id).build())
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("report-transfer-$id", ExistingWorkPolicy.KEEP, work).result.get(30, TimeUnit.SECONDS)
        }
    }
    fun scheduleEvents(context: Context, id: String) {
        val work = OneTimeWorkRequestBuilder<TransferEventWorker>().setInputData(Data.Builder().putString("id", id).build())
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork("report-transfer-events-$id", ExistingWorkPolicy.KEEP, work)
    }
}
