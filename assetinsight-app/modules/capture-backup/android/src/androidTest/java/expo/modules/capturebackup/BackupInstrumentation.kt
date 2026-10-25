package expo.modules.capturebackup

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.os.Bundle
import android.util.Base64
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Dedicated library test APK: no customer app/session, React, production API or camera access. */
class BackupInstrumentation : Instrumentation() {
    private var phase: String? = null
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); phase = arguments?.getString("persistencePhase"); start() }
    override fun onStart() {
        val result = Bundle()
        try {
            if (!BuildConfig.CAPTURE_BACKUP_ENABLED) {
                runDisabledBuildAssertions(targetContext)
                result.putString("stream", "PASS: disabled release rejects native authority/enqueue/resume/transport; cancels pre-existing WorkManager jobs before React, revokes grants and retains original bytes and queue snapshots.")
                finish(Activity.RESULT_OK, result); return
            }
            if (phase != null) {
                runPersistence(targetContext, phase!!)
                result.putString("stream", "PASS: WorkManager durable scheduling phase " + phase)
                finish(Activity.RESULT_OK, result); return
            }
            runAssertions(targetContext)
            result.putString("stream", "PASS: durable offline queue, 5000-reference manifests, encrypted grant, exact digest/streaming HTTPS bytes, lost-receipt resume without reupload, owner fences, paused/deleted revision preservation and interrupted/resumed activity. No React runtime or production calls.")
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stream", "FAIL: " + error.stackTraceToString()); finish(Activity.RESULT_CANCELED, result)
        }
    }
    private class IsolatedContext(base: Context, private val root: File) : ContextWrapper(base) {
        override fun getNoBackupFilesDir() = root.also { it.mkdirs() }
        override fun getApplicationContext(): Context = this
    }
    private fun runDisabledBuildAssertions(base: Context) {
        val root = File(base.noBackupFilesDir, "disabled-build-fixture-" + UUID.randomUUID())
        val context = IsolatedContext(base, root)
        val original = File(root.also { it.mkdirs() }, "original.jpg")
        val bytes = byteArrayOf(10, 20, 30, 40); original.writeBytes(bytes)
        val owner = "disabled-owner"; val draft = "disabled-draft"; val id = BackupStore.id(owner, draft, 1)
        val manager = WorkManager.getInstance(context)
        try {
            val snapshot = JSONObject().put("ownerId", owner).put("clientDraftId", draft).put("captureId", draft)
                .put("revision", 1).put("type", "asset").put("lots", JSONArray())
                .put("media", JSONArray().put(JSONObject().put("uri", original.toURI().toString()).put("clientFileId", "original-1")))
            val job = JSONObject().put("id", id).put("ownerId", owner).put("clientDraftId", draft).put("revision", 1)
                .put("snapshot", snapshot).put("status", "queued").put("verifiedIds", JSONArray()).put("events", JSONArray())
                .put("hashes", JSONObject().put("original-1", "retained-checkpoint")).put("updatedAt", BackupStore.now())
            BackupStore.save(context, job)
            val savedSnapshot = BackupStore.canonical(BackupStore.read(context, id))
            fun seedOldGrant() = BackupStore.saveAuthority(context, JSONObject().put("ownerId", owner)
                .put("apiBaseUrl", "https://127.0.0.1:9/api").put("token", "old-enabled-build-grant")
                .put("expiresAt", System.currentTimeMillis() + 3600_000L))
            fun expectDisabled(block: () -> Unit) {
                val failure = runCatching(block).exceptionOrNull()
                check(failure is IllegalStateException && failure.message.orEmpty().contains("backup", ignoreCase = true))
            }
            // Seed the old build's durable queue directly; no production coordinator or network is used.
            val request = OneTimeWorkRequestBuilder<BackupWorker>().setInputData(Data.Builder().putString("id", id).build())
                .setInitialDelay(1, TimeUnit.DAYS).build()
            manager.enqueueUniqueWork(BackupCoordinator.workName(id), ExistingWorkPolicy.REPLACE, request).result.get(30, TimeUnit.SECONDS)
            seedOldGrant()
            check(BackupEngine.run(context, id) == BackupEngine.Outcome.DONE)
            check(BackupStore.authority(context) == null)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (manager.getWorkInfosForUniqueWork(BackupCoordinator.workName(id)).get(30, TimeUnit.SECONDS).any { !it.state.isFinished } && System.nanoTime() < deadline) Thread.sleep(10)
            check(manager.getWorkInfosForUniqueWork(BackupCoordinator.workName(id)).get(30, TimeUnit.SECONDS).all { it.state.isFinished })
            seedOldGrant()
            expectDisabled { BackupCoordinator.configure(context, JSONObject()) }
            check(BackupStore.authority(context) == null)
            expectDisabled { BackupCoordinator.enqueue(context, snapshot) }
            expectDisabled { BackupCoordinator.resume(context, owner, draft) }
            seedOldGrant()
            BackupCoordinator.schedule(context, id)
            check(BackupStore.authority(context) == null)
            expectDisabled { BackupTransport.request(id, JSONObject(), "/plans", null) {} }
            expectDisabled { BackupTransport.put(context, id, JSONObject(), JSONObject(), "unused") {} }
            check(original.readBytes().contentEquals(bytes))
            check(BackupStore.canonical(BackupStore.read(context, id)) == savedSnapshot) { "Disabled release changed the retained job snapshot" }
        } finally {
            BackupStore.clearAuthority(context)
            manager.cancelUniqueWork(BackupCoordinator.workName(id)).result.get(30, TimeUnit.SECONDS)
            root.deleteRecursively() // Exact app-private fixture directory created above; never customer storage.
        }
    }
    private fun runPersistence(base: Context, phase: String) {
        val root = File(base.noBackupFilesDir, "workmanager-backup-persistence-fixture")
        val marker = File(root, "test-only-marker")
        if (root.exists()) check(marker.readText() == "capture-backup-library-test") else {
            check(phase == "prepare"); root.mkdirs(); marker.writeText("capture-backup-library-test")
        }
        val context = IsolatedContext(base, root)
        val owner = "wm-fixture-owner"; val draft = "wm-fixture-draft"; val id = BackupStore.id(owner, draft, 1)
        val manager = WorkManager.getInstance(context)
        if (phase == "prepare") {
            BackupCoordinator.deactivate(context)
            manager.cancelUniqueWork(BackupCoordinator.workName(id)).result.get(30, TimeUnit.SECONDS)
            BackupCoordinator.configure(context, JSONObject().put("ownerId", owner).put("apiBaseUrl", "https://127.0.0.1:9/api").put("networkPolicy", "connected"))
            BackupCoordinator.enqueue(context, JSONObject().put("ownerId", owner).put("clientDraftId", draft).put("captureId", draft)
                .put("type", "asset").put("revision", 1).put("title", "Persistence fixture").put("formData", JSONObject()).put("lots", JSONArray()).put("media", JSONArray()))
            BackupStore.saveAuthority(context, BackupStore.authority(context)!!.put("token", "fixture-background-grant").put("expiresAt", System.currentTimeMillis() + 7 * 24 * 3600_000L))
            BackupStore.update(context, id) { it.put("status", "queued") }
            // Production scheduler and Worker, with a test-only delay that prevents any network attempt.
            BackupCoordinator.schedule(context, id, initialDelayMillis = TimeUnit.DAYS.toMillis(1))
        }
        val queued = manager.getWorkInfosForUniqueWork(BackupCoordinator.workName(id)).get(30, TimeUnit.SECONDS).filter { !it.state.isFinished }
        check(queued.size == 1 && queued.single().state == WorkInfo.State.ENQUEUED) { "Persisted WorkManager request was missing" }
        check(BackupStore.read(context, id)!!.getString("status") == "queued")
        check(BackupStore.authority(context)!!.getString("token") == "fixture-background-grant")
        if (phase == "policy-cleanup") {
            val generation = BackupStore.authority(context)!!.getString("generation")
            BackupStore.update(context, id) { it.getJSONObject("hashes").put("checkpoint", "preserved") }
            BackupCoordinator.configure(context, JSONObject().put("ownerId", owner).put("apiBaseUrl", "https://127.0.0.1:9/api").put("networkPolicy", "unmetered"))
            check(BackupStore.authority(context)!!.getString("generation") != generation)
            val changed = manager.getWorkInfosForUniqueWork(BackupCoordinator.workName(id)).get(30, TimeUnit.SECONDS).filter { !it.state.isFinished }
            check(changed.size == 1 && changed.single().constraints.requiredNetworkType == NetworkType.UNMETERED)
            check(changed.single().id != queued.single().id)
            check(BackupStore.read(context, id)!!.getJSONObject("hashes").getString("checkpoint") == "preserved")
            BackupCoordinator.deactivate(context)
            manager.cancelUniqueWork(BackupCoordinator.workName(id)).result.get(30, TimeUnit.SECONDS)
            root.deleteRecursively()
        }
    }
    private fun runAssertions(base: Context) {
        val root = File(base.noBackupFilesDir, "backup-qa-" + UUID.randomUUID())
        val context = IsolatedContext(base, root)
        val original = File(root.also { it.mkdirs() }, "original.jpg")
        val bytes = ByteArray(256 * 1024) { (it % 251).toByte() }; original.writeBytes(bytes)
        fun config(owner: String = "fixture-owner") = JSONObject().put("ownerId", owner).put("apiBaseUrl", "https://127.0.0.1/api").put("networkPolicy", "connected")
        fun snapshot(revision: Long = 1, draft: String = "fixture-draft", count: Int = 1): JSONObject = JSONObject()
            .put("ownerId", "fixture-owner").put("clientDraftId", draft).put("captureId", draft).put("type", "asset")
            .put("revision", revision).put("contractNo", "QA").put("title", "Offline test")
            .put("formData", JSONObject()).put("lots", JSONArray().put(JSONObject().put("id", "lot-1")))
            .put("media", JSONArray((0 until count).map { index -> JSONObject().put("clientFileId", "photo-$index").put("lotId", "lot-1")
                .put("slot", "main").put("index", index).put("name", "fixture.jpg").put("mimeType", "image/jpeg")
                .put("size", bytes.size).put("uri", original.toURI().toString()) }))
        fun expectFailure(block: () -> Unit) { check(runCatching(block).isFailure) }
        try {
            BackupCoordinator.configure(context, config())
            check(BackupCoordinator.enqueue(context, snapshot())["status"] == "auth_required")
            // A kill between the durable journal and its small status cache cannot lose the job.
            File(root, "capture-backup-v1/status-" + BackupStore.id("fixture-owner", "fixture-draft", 1) + ".json").delete()
            check(BackupCoordinator.enqueue(context, snapshot())["total"] == 1)
            expectFailure { BackupCoordinator.enqueue(context, snapshot().put("title", "Changed same revision")) }
            val reloaded = IsolatedContext(base, root)
            check((BackupCoordinator.list(reloaded, "fixture-owner").single()["revision"] as Number).toLong() == 1L)
            BackupCoordinator.pause(context, "fixture-owner", "fixture-draft")
            check(BackupCoordinator.enqueue(context, snapshot(2))["status"] == "paused")
            BackupCoordinator.resume(context, "fixture-owner", "fixture-draft")
            check(BackupCoordinator.list(context, "fixture-owner").single()["status"] == "auth_required")
            BackupCoordinator.pause(context, "fixture-owner", "deleted-before-enqueue", "draft_deleted")
            check(BackupCoordinator.enqueue(context, snapshot(1, "deleted-before-enqueue"))["status"] == "paused")
            expectFailure { BackupCoordinator.resume(context, "fixture-owner", "deleted-before-enqueue") }
            check(BackupCoordinator.enqueue(context, snapshot(1, "many", 5000))["total"] == 5000)
            val withVideo = snapshot(2, "many", 5000)
            withVideo.getJSONArray("media").put(JSONObject(withVideo.getJSONArray("media").getJSONObject(0).toString()).put("clientFileId", "clip-1").put("slot", "video").put("mimeType", "video/mp4"))
            check(BackupCoordinator.enqueue(context, withVideo)["total"] == 5001)
            BackupStore.assertNoLocalReferences(JSONObject().put("notes", "Inspection data: 2026; Profile: standard"))
            for (label in listOf("Data: 2026", "File: inspected", "Asset: tractor")) {
                val metadata = JSONObject().put("notes", label)
                BackupStore.assertNoLocalReferences(metadata)
                check(metadata.getString("notes") == label) { "Ordinary metadata label was changed" }
            }
            for (localReference in listOf("file:///data/private.jpg", "content://media/private", "ph://private", "assets-library://private", "asset://private", "data:image/jpeg;base64,ZmFrZQ==", "/data/private.jpg")) {
                expectFailure { BackupStore.assertNoLocalReferences(JSONObject().put("uri", localReference)) }
            }
            BackupCoordinator.enqueue(context, snapshot(1, "shrinking", 224))
            BackupCoordinator.enqueue(context, snapshot(2, "shrinking", 50))
            val oldCapture = BackupStore.read(context, BackupStore.id("fixture-owner", "shrinking", 1))!!
            check(!oldCapture.optBoolean("superseded")) { "A shorter draft cancelled the earlier original backup" }
            check(BackupCoordinator.list(context, "fixture-owner").single { it["clientDraftId"] == "shrinking" }["retainedEarlierRevisionsPending"] == 1)
            BackupCoordinator.pause(context, "fixture-owner", "shrinking", "draft_deleted")
            check(BackupStore.jobs(context, "fixture-owner").filter { it.getString("clientDraftId") == "shrinking" }.all { it.getString("status") == "paused" })
            BackupCoordinator.enqueue(context, snapshot(1, "retained-resume", 224))
            BackupCoordinator.enqueue(context, snapshot(2, "retained-resume", 50))
            BackupStore.update(context, BackupStore.id("fixture-owner", "retained-resume", 2)) { it.put("status", "completed") }
            File(root, "capture-backup-v1/status-" + BackupStore.id("fixture-owner", "retained-resume", 2) + ".json").delete()
            BackupCoordinator.configure(context, config())
            check(BackupCoordinator.list(context, "fixture-owner").single { it["clientDraftId"] == "retained-resume" }["status"] == "completed")
            BackupCoordinator.pause(context, "fixture-owner", "retained-resume")
            check(BackupCoordinator.list(context, "fixture-owner").single { it["clientDraftId"] == "retained-resume" }["retainedEarlierRevisionsStatus"] == "paused")
            BackupCoordinator.resume(context, "fixture-owner", "retained-resume")
            check(BackupStore.read(context, BackupStore.id("fixture-owner", "retained-resume", 1))!!.getString("status") == "auth_required")
            check(BackupStore.read(context, BackupStore.id("fixture-owner", "retained-resume", 2))!!.getString("status") == "completed")
            val item = snapshot().getJSONArray("media").getJSONObject(0)
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            check(BackupTransport.digest(context, item) {} == digest)
            check(BackupTransport.inspect(context, JSONObject(item.toString()).put("size", 0)) {} == digest to bytes.size.toLong())
            expectFailure { BackupTransport.digest(context, JSONObject(item.toString()).put("size", bytes.size - 1)) {} }
            val authority = BackupStore.authority(context)!!.put("token", "fixture-backup-grant-only").put("expiresAt", System.currentTimeMillis() + 3600_000)
                .put("headers", JSONObject().put("X-Device-Key", "fixture-device-proof"))
            BackupStore.saveAuthority(context, authority)
            check(!File(root, "capture-backup-v1/authority.json").readText().contains("fixture-backup-grant-only"))
            check(BackupStore.authority(reloaded)!!.getString("token") == "fixture-backup-grant-only")
            val clientField = BackupTransport::class.java.getDeclaredField("client").apply { isAccessible = true }
            val savedClient = clientField.get(BackupTransport)
            val store = KeyStore.getInstance("PKCS12").apply { load(ByteArrayInputStream(Base64.decode(FIXTURE_P12, Base64.DEFAULT)), "fixture-test".toCharArray()) }
            val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, "fixture-test".toCharArray()) }
            val trusts = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
            val ssl = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trusts.trustManagers, null) }
            val trust = trusts.trustManagers.filterIsInstance<X509TrustManager>().single()
            val client = OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust).followRedirects(false)
                .retryOnConnectionFailure(false).callTimeout(10, TimeUnit.SECONDS).build()
            clientField.set(BackupTransport, client)
            try {
                Loopback(ssl, digest).use { server ->
                    BackupStore.saveAuthority(context, authority.put("apiBaseUrl", server.url + "/api"))
                    val id = BackupStore.id("fixture-owner", "fixture-draft", 2)
                    BackupStore.update(context, id) { it.put("status", "queued") }
                    check(BackupEngine.run(context, id) == BackupEngine.Outcome.RETRY) { "Expected uncertain first PUT response" }
                    check(server.puts == 1 && server.bytes.contentEquals(bytes))
                    // Pretend the old process vanished while writing its status; the next engine has no React state.
                    BackupStore.update(context, id) { it.put("status", "uploading") }
                    check(BackupEngine.run(reloaded, id) == BackupEngine.Outcome.DONE)
                    check(BackupStore.read(reloaded, id)!!.getString("status") == "completed")
                    check(server.puts == 1) { "A verified original was uploaded twice" }
                    // A finalization retry with all local byte receipts still names an
                    // actual original; the server does not accept confirm fileIds: [].
                    server.requireCompletionRetry()
                    BackupStore.update(context, id) { it.put("status", "queued") }
                    check(BackupEngine.run(reloaded, id) == BackupEngine.Outcome.DONE)
                    check(BackupStore.read(reloaded, id)!!.getString("status") == "completed" && server.puts == 1)
                    check(server.actions.any { it == "backup_interrupted:unknown" })
                    check(server.actions.any { it == "backup_resumed:unknown" })
                    check(server.actions.none { it.endsWith("system_interruption") }) { "Lost process cause must stay unknown" }
                    check(server.errors.isEmpty()) { server.errors.joinToString() }
                }
            } finally { clientField.set(BackupTransport, savedClient) }
            BackupCoordinator.configure(context, config("other-owner"))
            expectFailure { BackupCoordinator.list(context, "fixture-owner") }
            check(BackupEngine.run(context, BackupStore.id("fixture-owner", "many", 2)) == BackupEngine.Outcome.DONE)
            check(original.readBytes().contentEquals(bytes))
        } finally {
            BackupCoordinator.deactivate(context)
            check(original.exists()) { "Backup removed a device original" }
            root.deleteRecursively() // Only this test's freshly created, explicitly scoped fixture directory.
        }
    }
    private class Loopback(ssl: SSLContext, private val expectedDigest: String) : AutoCloseable {
        private val server = ssl.serverSocketFactory.createServerSocket(0, 8, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        private val pool = Executors.newSingleThreadExecutor()
        val url: String get() = "https://127.0.0.1:" + server.localPort
        var puts = 0; var bytes = byteArrayOf(); private var confirmed = false
        val actions = mutableListOf<String>(); val errors = mutableListOf<String>()
        private var plan: JSONObject? = null
        fun requireCompletionRetry() { confirmed = false }
        init { pool.execute { while (!server.isClosed) try { server.accept().use(::receive) } catch (error: Exception) { if (!server.isClosed) errors.add(error.message ?: "fixture error") } } }
        private fun receive(socket: Socket) {
            socket.soTimeout = 10000
            val input = BufferedInputStream(socket.getInputStream())
            fun line(): String {
                val output = StringBuilder()
                while (output.length < 32768) { val next = input.read(); check(next >= 0); if (next == 10) return output.toString().trimEnd('\r'); output.append(next.toChar()) }
                error("Fixture header too large")
            }
            val request = line().split(' '); val headers = mutableMapOf<String, String>()
            while (true) { val text = line(); if (text.isEmpty()) break; val split = text.indexOf(':'); headers[text.substring(0, split).lowercase()] = text.substring(split + 1).trim() }
            val body = ByteArray(headers["content-length"]?.toInt() ?: 0); var read = 0
            while (read < body.size) { val count = input.read(body, read, body.size - read); check(count > 0); read += count }
            if (request[0] == "PUT") {
                check(!headers.containsKey("x-capture-backup-grant") && !headers.containsKey("authorization"))
                check(headers["if-none-match"] == "*"); puts++; bytes = body
                check(MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) } == expectedDigest)
                return // Intentionally lose the first PUT response after receiving all exact bytes.
            }
            check(headers["x-capture-backup-grant"] == "fixture-backup-grant-only")
            check(headers["x-device-key"] == "fixture-device-proof")
            fun receipt() = JSONObject(plan.toString()).put("ownerId", "fixture-owner").put("id", "fixture-plan").put("total", 1).put("verified", if (confirmed) 1 else 0).put("status", if (confirmed) "complete" else "pending")
            val payload = if (body.isEmpty()) JSONObject() else JSONObject(String(body))
            val data = when {
                request[1] == "/api/capture-backups/plans" -> { plan = payload; check(!payload.has("ownerId")); check(!String(body).contains("file:")); check(payload.getJSONArray("media").getJSONObject(0).getString("sha256") == expectedDigest); receipt() }
                request[1].endsWith("/events") -> { actions.add(payload.getString("action") + ":" + payload.getString("reason")); check(payload.has("observedAt") && payload.has("captureId")); JSONObject().put("eventId", payload.getString("eventId")).put("accepted", true) }
                request[1].endsWith("/targets") -> JSONObject().put("targets", JSONArray().put(JSONObject().put("clientFileId", "photo-0")
                    .put("alreadyUploaded", puts > 0).put("uploadUrl", url + "/object").put("headers", JSONObject().put("Content-Type", "image/jpeg").put("If-None-Match", "*"))))
                request[1].endsWith("/confirm") -> { check(payload.getJSONArray("fileIds").length() > 0); confirmed = true; receipt() }
                request[1] == "/api/capture-backups/plans/fixture-plan/status" -> receipt()
                else -> error("Unexpected backup route")
            }
            val response = JSONObject().put("data", data).toString().toByteArray()
            socket.getOutputStream().apply { write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + response.size + "\r\nConnection: close\r\n\r\n").toByteArray()); write(response); flush() }
        }
        override fun close() { server.close(); pool.shutdownNow(); pool.awaitTermination(5, TimeUnit.SECONDS) }
    }
    companion object {
        // Public TEST-ONLY localhost certificate/key, same isolated fixture used by native upload tests.
        private const val FIXTURE_P12 = "MIIENAIBAzCCA94GCSqGSIb3DQEHAaCCA88EggPLMIIDxzCCAT4GCSqGSIb3DQEHAaCCAS8EggErMIIBJzCCASMGCyqGSIb3DQEMCgECoIG9MIG6MGYGCSqGSIb3DQEFDTBZMDgGCSqGSIb3DQEFDDArBBQ+AtNYtoi1hV7aKju370oVsYfwggICJxACASAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEE75u9wJvx1N0Hf/JHKfwBwEUIVbR6CQqdiN7pnv521bLEiDdtTAryqbdDhSWtFJFCbNavw0MNQtfyE1Js6SkMQt8SkaJlStw3OhTMAAzKkB4qI9sbyxciuDKhER9bMpAKYXMVQwLwYJKoZIhvcNAQkUMSIeIABsAG8AbwBwAGIAYQBjAGsALQBmAGkAeAB0AHUAcgBlMCEGCSqGSIb3DQEJFTEUBBJUaW1lIDE3ODk2NzQyNjQ2MTAwggKBBgkqhkiG9w0BBwagggJyMIICbgIBADCCAmcGCSqGSIb3DQEHATBmBgkqhkiG9w0BBQ0wWTA4BgkqhkiG9w0BBQwwKwQULQ72y57mbNmN3YmG+KJ3ynFaD0wCAicQAgEgMAwGCCqGSIb3DQIJBQAwHQYJYIZIAWUDBAEqBBCh10SiG9MvNIRLEbpxJ3M3gIIB8BR6fO9Sj33JuXHTN7KQusfUax1lVMpjv9J40PDBsTazUssyDnvSffzWHWh6ZoKj9NzWgE72ypsABfXFNr7w5tqqy1iuZBuc0pQ+yNT9y4twEcz2mJ3lC6X7mV2EjgkoxcMuyrlBotQwqc7SMvlccqoOYOc40QNVO0V4BwjKgD/TU+Ghneg1v3uLhPpifPMNzlS9geOHmB8iPlXivdK0/9c5TB9Je974yIjtqOFvjftGkcVzxsfiecr8AVrSiCjJL/VZ55xSKArpd4tuvG4JJAKahxPN6SnmMrToKVKtl04LZQDNBx8bIlRofEm/dmamYrwzlxZpW0p7y6xFKjrZoOwOigyUjIh3T1uskGL3y3tJ2f77gTzlUDFA1opWy+LfhgGV+VF7ruxqIP+cpR0UUgAnH2t6KZenEvDjuFBO9xTZcXRAzGZWCDdLj5qTelDYTXyGVswjnFFiUwX+63catCrB8nHZsdnQO1Q+YOWlxiFXnW/bHwKI6XHEXXUGRWZoWY7hJS3TLltVK3Vg1AIGHbrhN4UNueo2JUYoxxdct9xtDf9xke5L4yQlSjQHMfLZfawJ3gXkAxEurfOw9gXGwIxuy/G4cpn+HQvXibqXxOewB6nQg+xdiFjzZLZjVtghs+WfkLoaAJqNcTgoDO2j5z0wTTAxMA0GCWCGSAFlAwQCAQUABCDjUHjws9zZhjNmxO+TBLSoDBxFYiGhRgPkmveH+IgqxwQUV19QvGMCB4pZm5tNzpgrWsar+hECAicQ"
    }
}
