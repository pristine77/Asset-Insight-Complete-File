package expo.modules.reporttransfer

import android.app.Activity
import android.app.Instrumentation
import android.app.job.JobScheduler
import android.app.job.JobInfo
import android.content.ComponentName
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.util.Base64
import android.widget.TextView
import okhttp3.OkHttpClient
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class TransferFixtureActivity : Activity() {
    override fun onCreate(state: Bundle?) { super.onCreate(state); setContentView(TextView(this).apply { text = "Isolated report transfer fixture — no production connection" }) }
}

/** Self-contained test package. Never opens the customer application or uses its storage. */
class TransferInstrumentation : Instrumentation() {
    private var phase: String? = null
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); phase = arguments?.getString("persistencePhase"); start() }
    override fun onStart() {
        val result = Bundle()
        try {
            val activity = startActivitySync(Intent(targetContext, TransferFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            Thread.sleep(200)
            if (phase == "notification") {
                val (ssl, client) = testTls()
                TransferTransport::class.java.getDeclaredField("client").apply { isAccessible = true }.set(TransferTransport, client)
                actualService(targetContext, ssl, ByteArray(256 * 1024) { (it % 251).toByte() }, showNotification = true)
            } else if (phase?.startsWith("crash-") == true) crashPersistence(targetContext, phase!!) else if (phase != null) persistence(targetContext, phase!!) else assertions(targetContext)
            runOnMainSync { activity.finish() }
            result.putString("stream", "PASS: " + (phase?.let { if (it == "notification") "accepted transfer notification visual fixture" else "actual UIDT/Keystore/original persistence phase $it" }
                ?: "streamed HTTPS bytes, lost responses, preparing/locked/stale/repairable-failed recovery, cleanup/unavailable/unconfirmed guards, exact receipts, pause/owner fences, unknown interruptions, 101 archived x 5000-reference compact queue, immutable revisions, actual " +
                (if (Build.VERSION.SDK_INT >= 34) "UIDT" else "WorkManager foreground") + " service acceptance and no original deletion"))
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) { result.putString("stream", "FAIL: " + error.stackTraceToString()); finish(Activity.RESULT_CANCELED, result) }
    }
    private class IsolatedContext(base: Context, private val root: File) : ContextWrapper(base) {
        override fun getNoBackupFilesDir() = root.also { it.mkdirs() }
        override fun getApplicationContext(): Context = this
    }
    private fun configure(context: Context, base: String = "https://127.0.0.1:9/api", owner: String = "fixture-owner") = TransferCoordinator.configure(context,
        JSONObject().put("ownerId", owner).put("apiBaseUrl", base).put("headers", JSONObject().put("X-Device-Key", "fixture-device-proof").put("X-App-Version", "1.0.3 (28)")))
    private fun plan(original: File, draft: String = "fixture-draft", count: Int = 1) = JSONObject()
        .put("ownerId", "fixture-owner").put("clientDraftId", draft).put("captureId", "capture-$draft").put("clientSubmissionId", "submission-$draft")
        .put("revision", 1).put("type", "asset").put("sessionId", "session-$draft").put("title", "Fixture only")
        .put("grant", JSONObject().put("token", "fixture-report-transfer-grant").put("expiresAt", System.currentTimeMillis() + TimeUnit.DAYS.toMillis(7)))
        .put("files", JSONArray((0 until count).map { JSONObject().put("fileId", "images-$it").put("name", "fixture.jpg")
            .put("type", "image/jpeg").put("size", original.length()).put("uri", original.toURI().toString()) }))
    private fun expectFailure(work: () -> Unit) { check(runCatching(work).isFailure) }
    private fun testTls(): Pair<SSLContext, OkHttpClient> {
        val store = KeyStore.getInstance("PKCS12").apply { load(ByteArrayInputStream(Base64.decode(FIXTURE_P12, Base64.DEFAULT)), "fixture-test".toCharArray()) }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, "fixture-test".toCharArray()) }
        val trusts = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        val ssl = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trusts.trustManagers, null) }
        val trust = trusts.trustManagers.filterIsInstance<X509TrustManager>().single()
        return ssl to OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust).followRedirects(false)
            .retryOnConnectionFailure(false).callTimeout(10, TimeUnit.SECONDS).build()
    }
    private fun forceFixture(context: Context, id: String) {
        val schedulerId = if (Build.VERSION.SDK_INT >= 34) TransferStore.read(context, id)!!.getInt("schedulerId") else {
            val workId = WorkManager.getInstance(context).getWorkInfosForUniqueWork("report-transfer-$id").get(30, TimeUnit.SECONDS).last { !it.state.isFinished }.id.toString()
            val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            var info = scheduler.allPendingJobs.firstOrNull { it.extras.getString("EXTRA_WORK_SPEC_ID") == workId }
            while (info == null && System.nanoTime() < deadline) { Thread.sleep(50); info = scheduler.allPendingJobs.firstOrNull { it.extras.getString("EXTRA_WORK_SPEC_ID") == workId } }
            info?.id ?: error("WorkManager fallback system job was not scheduled")
        }
        uiAutomation.executeShellCommand("cmd jobscheduler run -f ${context.packageName} $schedulerId").use { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
        }
    }
    private fun crashPersistence(context: Context, phase: String) {
        val bytes = ByteArray(256 * 1024) { (it % 251).toByte() }
        val original = File(context.filesDir, "crash-uidt-fixture.jpg")
        val remoteBytes = File(context.filesDir, "crash-uidt-remote-receipt.bin")
        val id = TransferStore.id("fixture-owner", "crash", "session-crash")
        val clientField = TransferTransport::class.java.getDeclaredField("client").apply { isAccessible = true }
        val prior = clientField.get(TransferTransport); val (ssl, client) = testTls(); clientField.set(TransferTransport, client)
        try {
            if (phase == "crash-prepare") {
                check(!original.exists() && !remoteBytes.exists()) { "Crash fixture already exists" }
                original.writeBytes(bytes)
                Loopback(ssl, bytes, false, false, port = 19847, persistedBytes = remoteBytes, holdUpload = true).use { server ->
                    configure(context, server.url + "/api"); TransferCoordinator.enqueue(context, plan(original, "crash")); forceFixture(context, id)
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                    while (!remoteBytes.exists() && System.nanoTime() < deadline) Thread.sleep(50)
                    check(remoteBytes.readBytes().contentEquals(bytes)) { "Actual service did not stream before the kill" }
                    check(TransferStore.read(context, id)!!.getString("status") == "uploading")
                    // Kill only this isolated library-test process without graceful callbacks.
                    android.os.Process.killProcess(android.os.Process.myPid())
                    error("Expected process termination")
                }
            } else {
                check(phase == "crash-resume")
                check(original.readBytes().contentEquals(bytes) && remoteBytes.readBytes().contentEquals(bytes))
                check(TransferStore.read(context, id)!!.getString("status") == "uploading")
                check(TransferStore.secret(context, id)?.getString("token") == "fixture-report-transfer-grant")
                Loopback(ssl, bytes, false, true, port = 19847, persistedBytes = remoteBytes).use { server ->
                    forceFixture(context, id)
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (TransferStore.read(context, id)?.optString("status") != "accepted" && System.nanoTime() < deadline) Thread.sleep(50)
                    check(TransferStore.read(context, id)?.optString("status") == "accepted") { "UIDT did not recover the killed process" }
                    check(server.uploads == 0 && server.completions == 1) { "Process restart resent verified original bytes" }
                    check(server.actions.contains("upload_interrupted:unknown")) { "The absent stop callback was not reported as unknown" }
                    check(original.readBytes().contentEquals(bytes))
                }
                TransferCoordinator.deactivate(context)
                File(context.noBackupFilesDir, "report-transfer-v1").deleteRecursively(); original.delete(); remoteBytes.delete()
            }
        } finally { clientField.set(TransferTransport, prior) }
    }
    private fun persistence(context: Context, phase: String) {
        val marker = File(context.filesDir, "report-transfer-persistence-fixture.marker")
        val original = File(context.filesDir, "report-transfer-persistence-fixture.jpg")
        val bytes = ByteArray(4096) { (it % 251).toByte() }
        val id = TransferStore.id("fixture-owner", "persistence", "session-persistence")
        if (phase == "prepare") {
            check(!marker.exists()) { "Persistence fixture already exists; verify or cleanup it first" }
            marker.writeText("isolated-report-transfer-test"); original.writeBytes(bytes)
            configure(context); TransferCoordinator.enqueue(context, plan(original, "persistence"))
        }
        check(marker.readText() == "isolated-report-transfer-test")
        val job = TransferStore.read(context, id) ?: error("Durable report journal missing")
        val scheduled = (context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).getPendingJob(job.getInt("schedulerId"))
        check(scheduled != null && scheduled.isPersisted && scheduled.isUserInitiated) { "Persisted UIDT job missing" }
        check(TransferStore.secret(context, id)?.optString("token") == "fixture-report-transfer-grant")
        check(original.readBytes().contentEquals(bytes))
        if (phase == "cleanup") {
            TransferCoordinator.deactivate(context)
            check(original.readBytes().contentEquals(bytes))
            // Exact files created by this library test; customer application has another package/data directory.
            File(context.noBackupFilesDir, "report-transfer-v1").deleteRecursively(); original.delete(); marker.delete()
        }
    }
    private fun assertions(base: Context) {
        val root = File(base.noBackupFilesDir, "transfer-fixture-" + UUID.randomUUID()).also { it.mkdirs() }
        val context = IsolatedContext(base, root)
        val original = File(root, "original.jpg"); val bytes = ByteArray(256 * 1024) { (it % 251).toByte() }; original.writeBytes(bytes)
        val clientField = TransferTransport::class.java.getDeclaredField("client").apply { isAccessible = true }
        val savedClient = clientField.get(TransferTransport)
        val (ssl, client) = testTls(); clientField.set(TransferTransport, client)
        try {
            configure(context)
            val source = plan(original); val id = TransferStore.id("fixture-owner", "fixture-draft", "session-fixture-draft")
            TransferCoordinator.enqueue(context, source)
            if (Build.VERSION.SDK_INT >= 34) {
                val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
                val job = TransferStore.read(context, id)!!
                val schedulerId = job.getInt("schedulerId")
                val scheduled = checkNotNull(scheduler.getPendingJob(schedulerId))
                check(scheduled.requiredNetwork?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) == false) {
                    "A newly submitted job must allow VPN internet"
                }
                // Reproduce an earlier build's queued NOT_VPN constraint. The
                // normal read/configure path must repair only that queued job.
                val legacy = JobInfo.Builder(schedulerId, ComponentName(context, TransferJobService::class.java))
                    .setExtras(scheduled.extras).setPersisted(true).setUserInitiated(true)
                    .setRequiredNetwork(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build())
                    .setEstimatedNetworkBytes(1024L * 1024, original.length()).build()
                check(scheduler.schedule(legacy) == JobScheduler.RESULT_SUCCESS)
                check(scheduler.getPendingJob(schedulerId)!!.requiredNetwork!!.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN))
                TransferCoordinator.list(context, "fixture-owner")
                check(scheduler.getPendingJob(schedulerId)!!.requiredNetwork!!.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) == false) {
                    "Previously queued jobs must not stay blocked behind NOT_VPN"
                }
                check(TransferStore.read(context, id)!!.getJSONObject("snapshot").toString() == job.getJSONObject("snapshot").toString())
            }
            TransferCoordinator.cancel(context, TransferStore.read(context, id)!!)
            val reloaded = IsolatedContext(base, root)
            check(TransferCoordinator.list(reloaded, "fixture-owner").single()["totalFiles"] == 1)
            check(!File(root, "report-transfer-v1/secret-$id.json").readText().contains("fixture-report-transfer-grant"))
            expectFailure { TransferCoordinator.enqueue(context, JSONObject(source.toString()).put("title", "Changed snapshot")) }
            val cacheOriginal = File(base.cacheDir, "unsafe-transfer-fixture.jpg").also { it.writeBytes(bytes) }
            try { expectFailure { TransferCoordinator.enqueue(context, plan(cacheOriginal, "unsafe")) } } finally { cacheOriginal.delete() }
            TransferCoordinator.pause(context, "fixture-owner", "fixture-draft")
            TransferCoordinator.list(context, "fixture-owner")
            if (Build.VERSION.SDK_INT >= 34) {
                val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
                check(scheduler.getPendingJob(TransferStore.read(context, id)!!.getInt("schedulerId")) == null) {
                    "Polling must not requeue an explicitly paused transfer"
                }
            }
            check(TransferEngine.run(context, id) == TransferEngine.Outcome.DONE)
            check(TransferStore.read(context, id)!!.getString("status") == "paused")
            TransferCoordinator.resume(context, "fixture-owner", "fixture-draft", null)
            TransferCoordinator.cancel(context, TransferStore.read(context, id)!!)
            Loopback(ssl, bytes, dropUpload = true, dropComplete = true).use { server ->
                val owner = TransferStore.secret(context, "owner")!!; owner.put("apiBaseUrl", server.url + "/api"); TransferStore.saveSecret(context, "owner", owner)
                check(TransferEngine.run(context, id) == TransferEngine.Outcome.RETRY)
                check(server.uploads == 1 && server.received.contentEquals(bytes))
                // Abrupt process loss leaves uploading with no stop callback. Its next
                // attempt must report unknown, never infer an explicit user pause.
                TransferStore.update(context, id) { it.put("status", "uploading") }
                check(TransferEngine.run(reloaded, id) == TransferEngine.Outcome.DONE)
                val accepted = TransferStore.read(reloaded, id)!!
                check(accepted.getString("status") == "accepted")
                check(accepted.getJSONObject("receipt").getString("sessionId") == "session-fixture-draft")
                check(server.uploads == 1 && server.completions == 1) { "Lost receipts replayed bytes or completion" }
                check(server.actions.contains("upload_interrupted:unknown"))
                check(!server.actions.contains("upload_paused:unknown"))
                expectFailure { TransferCoordinator.forget(context, "fixture-owner", "fixture-draft") }
                check(server.errors.isEmpty()) { server.errors.joinToString() }
            }
            Loopback(ssl, bytes, dropUpload = false, dropComplete = false, reusedAcceptance = true, statusDropsAfterComplete = 2).use { server ->
                val owner = TransferStore.secret(context, "owner")!!; owner.put("apiBaseUrl", server.url + "/api"); TransferStore.saveSecret(context, "owner", owner)
                val reuseId = TransferStore.id("fixture-owner", "reused", "session-reused")
                TransferCoordinator.enqueue(context, plan(original, "reused")); TransferCoordinator.cancel(context, TransferStore.read(context, reuseId)!!)
                check(TransferEngine.run(context, reuseId) == TransferEngine.Outcome.RETRY)
                check(TransferStore.read(context, reuseId)!!.getBoolean("historicalAcceptance"))
                check(TransferEngine.run(reloaded, reuseId) == TransferEngine.Outcome.DONE)
                val reused = TransferStore.read(context, reuseId)!!
                check(reused.getString("status") == "needs_attention" && reused.getJSONObject("receipt").getBoolean("reusedAcceptance"))
                expectFailure { TransferCoordinator.forget(context, "fixture-owner", "reused") }
                check(original.readBytes().contentEquals(bytes))
            }
            for ((draft, mode) in listOf("preparing" to "preparing", "locked-race" to "race", "locked-ready" to "ready-race", "unconfirmed" to "unconfirmed", "unavailable" to "unavailable", "stale-complete" to "stale", "repairable-failed" to "failed", "cleanup-failed" to "cleanup")) {
                Loopback(ssl, bytes, dropUpload = false, dropComplete = false, recovery = mode).use { server ->
                    val owner = TransferStore.secret(context, "owner")!!; owner.put("apiBaseUrl", server.url + "/api"); TransferStore.saveSecret(context, "owner", owner)
                    val recoveryId = TransferStore.id("fixture-owner", draft, "session-$draft")
                    TransferCoordinator.enqueue(context, plan(original, draft)); TransferCoordinator.cancel(context, TransferStore.read(context, recoveryId)!!)
                    if (mode == "failed") TransferStore.update(context, recoveryId) {
                        // Simulate the earlier complete response discovering a lost
                        // object after native verification. UI checkpoints are never
                        // authority to skip a fresh server verification on Resume.
                        it.put("completionAttempted", true).put("status", "needs_attention")
                        it.getJSONArray("verifiedIds").put("images-0")
                    }
                    if (mode == "failed") {
                        expectFailure { TransferCoordinator.forget(context, "fixture-owner", draft) }
                        TransferCoordinator.resume(context, "fixture-owner", draft, null)
                        TransferCoordinator.cancel(context, TransferStore.read(context, recoveryId)!!)
                    }
                    val first = TransferEngine.run(context, recoveryId)
                    if (mode in setOf("stale", "ready-race")) {
                        check(first == TransferEngine.Outcome.RETRY)
                        check(TransferEngine.run(context, recoveryId) == TransferEngine.Outcome.DONE)
                    } else check(first == TransferEngine.Outcome.DONE)
                    val blocked = mode in setOf("unconfirmed", "unavailable", "cleanup")
                    check(TransferStore.read(context, recoveryId)!!.getString("status") == if (blocked) "needs_attention" else "accepted")
                    check(server.uploads == (if (mode == "failed") 1 else 0) && server.completions == if (blocked) 0 else 1) { "Recovery resent media or skipped completion: $mode" }
                    check(server.verifications == if (mode in setOf("race", "ready-race", "failed")) 1 else 0) { "Preparing media were verified again: $mode" }
                    check(original.readBytes().contentEquals(bytes))
                }
            }
            val many = plan(original, "many", 5000); TransferCoordinator.enqueue(context, many)
            val manyId = TransferStore.id("fixture-owner", "many", "session-many")
            TransferCoordinator.cancel(context, TransferStore.read(context, manyId)!!)
            check(TransferStore.read(context, manyId)!!.getJSONObject("snapshot").getJSONArray("files").length() == 5000)
            TransferCoordinator.pause(context, "fixture-owner", "many")
            TransferStore.update(context, manyId) { it.put("completionAttempted", true) }
            expectFailure { TransferCoordinator.forget(context, "fixture-owner", "many") }
            TransferStore.update(context, manyId) { it.put("completionAttempted", false) }
            TransferCoordinator.forget(context, "fixture-owner", "many")
            check(TransferCoordinator.list(context, "fixture-owner").none { it["clientDraftId"] == "many" })
            val editable = plan(original, "editable")
            val editId = TransferStore.id("fixture-owner", "editable", "session-editable")
            TransferCoordinator.enqueue(context, editable); TransferCoordinator.cancel(context, TransferStore.read(context, editId)!!)
            TransferCoordinator.pause(context, "fixture-owner", "editable"); TransferCoordinator.forget(context, "fixture-owner", "editable")
            TransferCoordinator.enqueue(context, editable) // Identical explicit handback can revive the same frozen revision.
            TransferCoordinator.cancel(context, TransferStore.read(context, editId)!!)
            check(!TransferStore.read(context, editId)!!.optBoolean("forgotten"))
            TransferCoordinator.pause(context, "fixture-owner", "editable"); TransferCoordinator.forget(context, "fixture-owner", "editable")
            val lastSequence = TransferStore.read(context, editId)!!.getLong("eventSequence")
            val retainedEvent = TransferStore.read(context, editId)!!.getJSONArray("events").getJSONObject(0).getString("eventId")
            val nextRevision = JSONObject(editable.toString()).put("revision", 2)
            TransferCoordinator.enqueue(context, nextRevision)
            val revisedId = TransferStore.id("fixture-owner", "editable", "session-editable", 2)
            TransferCoordinator.cancel(context, TransferStore.read(context, revisedId)!!)
            check(TransferStore.read(context, revisedId)!!.getLong("eventSequence") > lastSequence)
            check(TransferStore.read(context, revisedId)!!.getJSONArray("events").let { events -> (0 until events.length()).any { events.getJSONObject(it).getString("eventId") == retainedEvent } })
            check(TransferStore.read(context, editId)!!.getJSONArray("events").length() == 0)
            check(TransferStore.read(context, editId)!!.optBoolean("forgotten"))
            expectFailure { TransferCoordinator.enqueue(context, editable) } // Late earlier revisions cannot replace newer intent.
            configure(context, owner = "other-owner")
            expectFailure { TransferCoordinator.list(context, "fixture-owner") }
            check(TransferStore.secret(context, manyId) == null)
            check(original.readBytes().contentEquals(bytes))
            archivedQueueProjection(base, original)
            actualService(base, ssl, bytes)
        } finally {
            clientField.set(TransferTransport, savedClient)
            TransferCoordinator.deactivate(context)
            check(original.readBytes().contentEquals(bytes))
            root.deleteRecursively() // Only the UUID test directory created above.
        }
    }
    private fun archivedQueueProjection(base: Context, original: File) {
        val root = File(base.noBackupFilesDir, "transfer-archive-fixture-" + UUID.randomUUID()).also { it.mkdirs() }
        val context = IsolatedContext(base, root)
        try {
            configure(context)
            val source = plan(original, "archived", 5000).apply { remove("grant") }
            for (index in 0 until 101) {
                val snapshot = JSONObject(source.toString()).put("clientDraftId", "archive-$index").put("sessionId", "archive-session-$index")
                val id = TransferStore.id("fixture-owner", "archive-$index", "archive-session-$index")
                TransferStore.save(context, JSONObject().put("id", id).put("snapshot", snapshot).put("schedulerId", index)
                    .put("generation", "fixture").put("status", "accepted").put("verifiedIds", JSONArray()).put("events", JSONArray()))
            }
            val cacheField = TransferStore::class.java.getDeclaredField("snapshots").apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST") val cache = cacheField.get(TransferStore) as MutableMap<String, JSONObject>
            synchronized(TransferStore.lock) { cache.clear() }
            repeat(3) {
                val jobs = TransferStore.jobs(context)
                check(jobs.size == 101 && jobs.all { job -> !job.getJSONObject("snapshot").has("files") && !job.has("hashes") && !job.has("verifiedIds") })
                check(TransferCoordinator.list(context, "fixture-owner").all { it["totalFiles"] == 5000 })
                synchronized(TransferStore.lock) { check(cache.isEmpty()) { "Queue polling loaded archived immutable manifests" } }
            }
            val saved = File(root, "report-transfer-v1").listFiles().orEmpty()
            check(saved.count { it.name.startsWith("snapshot-") } == 101) { "Historical snapshots were pruned" }
            check(saved.filter { it.name.matches(Regex("[a-f0-9]{64}\\.json")) }.all { it.length() < 4096 }) { "Queue metadata grew with media manifests" }
        } finally { root.deleteRecursively() } // Only the exact isolated fixture directory created above.
    }
    private fun actualService(context: Context, ssl: SSLContext, bytes: ByteArray, showNotification: Boolean = false) {
        val original = File(context.filesDir, "actual-uidt-fixture.jpg").also { it.writeBytes(bytes) }
        try {
            Loopback(ssl, bytes, dropUpload = false, dropComplete = false).use { server ->
                configure(context, server.url + "/api")
                val id = TransferStore.id("fixture-owner", "actual", "session-actual")
                TransferCoordinator.enqueue(context, plan(original, "actual"))
                // The emulator remains offline. Android's documented scheduler test
                // override executes only this fixture job against loopback HTTPS.
                forceFixture(context, id)
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (TransferStore.read(context, id)?.optString("status") != "accepted" && System.nanoTime() < deadline) Thread.sleep(100)
                check(TransferStore.read(context, id)?.optString("status") == "accepted") { "Actual UIDT service did not accept: " + TransferStore.read(context, id)?.optString("message") }
                check(server.uploads == 1 && server.completions == 1 && server.received.contentEquals(bytes))
                check(original.readBytes().contentEquals(bytes))
                if (showNotification) {
                    uiAutomation.executeShellCommand("cmd statusbar expand-notifications").close()
                    sendStatus(0, Bundle().apply { putString("stream", "Notification fixture ready for screenshot") })
                    Thread.sleep(12_000) // Bounded visual QA window in this isolated test only.
                }
            }
        } finally {
            TransferCoordinator.deactivate(context)
            File(context.noBackupFilesDir, "report-transfer-v1").deleteRecursively(); original.delete()
        }
    }
    private class Loopback(ssl: SSLContext, private val expected: ByteArray, private val dropUpload: Boolean, private val dropComplete: Boolean,
        port: Int = 0, private val persistedBytes: File? = null, private val holdUpload: Boolean = false, private val reusedAcceptance: Boolean = false,
        private var statusDropsAfterComplete: Int = 0, private val recovery: String = "") : AutoCloseable {
        private val socket = ssl.serverSocketFactory.createServerSocket(port, 8, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        private val executor = Executors.newCachedThreadPool()
        val url: String get() = "https://127.0.0.1:" + socket.localPort
        @Volatile var uploads = 0; @Volatile var completions = 0; @Volatile var received = byteArrayOf()
        @Volatile var verifications = 0; private var statusReads = 0; private var completionAttempts = 0
        private val verified = mutableSetOf<String>().apply { if (persistedBytes?.exists() == true && persistedBytes.readBytes().contentEquals(expected)) add("images-0") }
        val actions = java.util.Collections.synchronizedList(mutableListOf<String>())
        val errors = java.util.Collections.synchronizedList(mutableListOf<String>())
        init { executor.execute { while (!socket.isClosed) try { val client = socket.accept(); executor.execute { try { client.use(::receive) } catch (error: Exception) { errors.add(error.toString()) } } } catch (_: Exception) { } } }
        private fun receive(client: Socket) {
            client.soTimeout = 10000
            val input = BufferedInputStream(client.getInputStream())
            fun line(): String { val text = StringBuilder(); while (text.length < 32768) { val next = input.read(); check(next >= 0); if (next == 10) return text.toString().trimEnd('\r'); text.append(next.toChar()) }; error("Header limit") }
            val request = line().split(' '); val route = request[1]; val headers = mutableMapOf<String, String>()
            while (true) { val entry = line(); if (entry.isEmpty()) break; val index = entry.indexOf(':'); headers[entry.substring(0, index).lowercase()] = entry.substring(index + 1).trim() }
            check(headers["x-report-transfer-grant"] == "fixture-report-transfer-grant" && headers["x-device-key"] == "fixture-device-proof")
            check(!headers.containsKey("authorization"))
            val bytes = ByteArray(headers["content-length"]?.toInt() ?: 0); var loaded = 0
            while (loaded < bytes.size) { val count = input.read(bytes, loaded, bytes.size - loaded); check(count > 0); loaded += count }
            val pieces = route.split('/'); val session = pieces[4]
            var status = 200; var code: String? = null
            val data = when {
                route.endsWith("/events") -> { val event = JSONObject(String(bytes)); check(event.optString("appVersion") == "1.0.3 (28)"); actions.add(event.getString("action") + ":" + event.optString("reason")); JSONObject().put("acknowledgements", JSONArray().put(JSONObject().put("eventId", event.getString("eventId")).put("activityId", "fixture-activity"))) }
                route.endsWith("/status") -> {
                    if (completions > 0 && statusDropsAfterComplete > 0) { statusDropsAfterComplete--; return }
                    statusReads++
                    JSONObject().put("sessionId", session).put("ownerId", "fixture-owner").put("type", "asset")
                        .put("status", when { completions > 0 -> "queued"; recovery == "unavailable" -> "unavailable"; recovery in setOf("failed", "cleanup") -> "failed"; recovery == "ready-race" && statusReads <= 2 -> "ready"; recovery.isNotBlank() && (recovery != "race" || statusReads > 1) -> "preparing"; else -> "ready" })
                        .put("accepted", completions > 0).put("reportAvailable", if (completions > 0) true else JSONObject.NULL).also {
                            if (completions > 0) it.put("reportId", "fixture-report").put("jobId", "fixture-job")
                            if (recovery == "unconfirmed") it.put("code", "UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED")
                            if (recovery == "unavailable") it.put("code", "UPLOAD_SESSION_REPORT_UNAVAILABLE")
                            if (recovery == "failed" && completions == 0) it.put("canResumeUploads", true)
                        }
                }
                route.endsWith("/verify") -> { verifications++; val fileId = pieces[6]
                    if (recovery in setOf("race", "ready-race")) { status = 409; code = "UPLOAD_SESSION_LOCKED"; JSONObject() }
                    else if (fileId !in synchronized(verified) { verified.toSet() }) { status = 409; code = "UPLOAD_NOT_VERIFIED"; JSONObject().put("verified", false) }
                    else JSONObject().put("fileId", fileId).put("verified", true).put("size", expected.size) }
                route.endsWith("/complete") -> {
                    completionAttempts++
                    if (recovery == "stale" && completionAttempts == 1) { status = 409; code = "UPLOAD_SESSION_COMPLETION_STALE"; JSONObject() }
                    else { completions++; if (dropComplete && completions == 1) return; JSONObject().put("jobId", "fixture-job").put("reportId", "fixture-report")
                        .put("ownerId", "fixture-owner").put("sessionId", session).put("type", "asset").put("reusedAcceptance", reusedAcceptance) }
                }
                "/files/" in route -> {
                    val body = String(bytes, Charsets.ISO_8859_1); val start = body.indexOf("\r\n\r\n") + 4; val end = body.lastIndexOf("\r\n--")
                    check(start >= 4 && end > start); received = bytes.copyOfRange(start, end); check(received.contentEquals(expected))
                    val fileId = pieces[6]; synchronized(verified) { verified.add(fileId) }; uploads++
                    persistedBytes?.writeBytes(received)
                    if (holdUpload) Thread.sleep(60_000)
                    if (dropUpload && uploads == 1) return
                    JSONObject().put("fileId", fileId).put("key", "fixture-only").put("size", received.size)
                }
                else -> error("Unexpected local route $route")
            }
            val payload = if (route.endsWith("/complete")) data else JSONObject().put("data", data); if (code != null) payload.put("code", code)
            val response = payload.toString().toByteArray()
            client.getOutputStream().apply { write(("HTTP/1.1 $status Fixture\r\nContent-Type: application/json\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n").toByteArray()); write(response); flush() }
        }
        override fun close() { socket.close(); executor.shutdownNow(); executor.awaitTermination(5, TimeUnit.SECONDS) }
    }
    companion object {
        // Public test-only localhost certificate/key; never trusted by the production transport.
        private const val FIXTURE_P12 = "MIIDHgIBAzCCAtwGCSqGSIb3DQEHAaCCAs0EggLJMIICxTCCAgcGCSqGSIb3DQEHBqCCAfgwggH0AgEAMIIB7QYJKoZIhvcNAQcBMBwGCiqGSIb3DQEMAQMwDgQI+9nTUJluQ/MCAggAgIIBwDjbwJOgQpIS5K4dxNc6IEbn4lRQek4ANfIuazhk1mBha0cSgg8A49k9J8aKlycGt91oMFFHbTnjggeMwABNIKZGq5ggzCe72ZM+J32sgPmBtcF+no4bNMcQBrRC4vN2Woayq01cs4YP00JS6liujaBIJYquOqM5xv1aOospz84NgqCaTdVJcM2vxvm6GqpcnhMTwyGIi1qCFq59WTk4TWmkEJIWlJD/IKKn6a7d44K1ettOZ86mFwf0PUp2986Z5C2oOflnhwx5urfdujWXclD3GIUSE7rY1lHS9vc3QAMHhki0QZqWCtwURD9oCNASU213H5SqyFk2ziFYON3o8u7oHjduSVhySExsB+BeFnlGAyXV8hSluXQ/4tsrZckVUotqkAO6RT745FxT0nGYtYKpyqk/p08u8THIEmmjdjU87H59cSej+xtFegdLaZF2j5Owcl/H7m8uXB23mTw2ibjmOu/OjXzQUGJ6PuttCS5RA4Bjyusxha7QIUg8+5k8kxnSTXGp4UmOUkNejwV0X3sb3k8FWNyQKtcfPU1ywT8l8zN6UsUOcyGg1f2cLkUBGOup4U7Y+OHwUIzvsOFlIj0wgbcGCSqGSIb3DQEHAaCBqQSBpjCBozCBoAYLKoZIhvcNAQwKAQKgajBoMBwGCiqGSIb3DQEMAQMwDgQI6mffQytcDi8CAggABEi+LsINFpVsU7NB+2xqRDuCaj04Y+AgujKLxd/mTJbSn3JAwm9Pp3RTEgGe160uLq8xlp1y7XcJTmQ5ZkAfPgafU14EJH77yawxJTAjBgkqhkiG9w0BCRUxFgQUWPXzK/BbqpNtYEA9EtXTuX4ZKMwwOTAhMAkGBSsOAwIaBQAEFChvgTZPbWEXyZXWPmy3wb7h1AgFBBDbTL/Mak9bPbZwcRi1CfLmAgIIAA=="
    }
}
