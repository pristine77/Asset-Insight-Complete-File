package expo.modules.capturebackup

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** All metadata writes are atomic, private and excluded from OS cloud/device-transfer backups. */
object BackupStore {
    private val lock = Any()
    private const val ALIAS = "asset-insight-capture-backup-grant-v1"
    private fun directory(context: Context) = File(context.noBackupFilesDir, "capture-backup-v1").also {
        check(it.isDirectory || it.mkdirs()) { "Backup queue storage unavailable" }
    }
    private fun atomic(context: Context, name: String) = AtomicFile(File(directory(context), name))
    private fun read(file: AtomicFile): JSONObject? = try {
        file.openRead().bufferedReader().use { JSONObject(it.readText()) }
    } catch (_: java.io.FileNotFoundException) { null }
    private fun write(file: AtomicFile, value: JSONObject) {
        val output = file.startWrite()
        try { output.write(value.toString().toByteArray(Charsets.UTF_8)); file.finishWrite(output) }
        catch (error: Throwable) { file.failWrite(output); throw error }
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
        }.generateKey()
    }
    fun authority(context: Context): JSONObject? = synchronized(lock) {
        val encrypted = read(atomic(context, "authority.json")) ?: return@synchronized null
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(encrypted.getString("iv"), Base64.NO_WRAP)))
            JSONObject(String(cipher.doFinal(Base64.decode(encrypted.getString("ciphertext"), Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (_: Exception) { null } // Lost/invalid keys require fresh foreground authorization.
    }
    fun saveAuthority(context: Context, value: JSONObject) = synchronized(lock) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        write(atomic(context, "authority.json"), JSONObject()
            .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)))
    }
    fun clearAuthority(context: Context) = synchronized(lock) { atomic(context, "authority.json").delete() }
    fun pauseReason(context: Context, owner: String, draft: String): String? = synchronized(lock) {
        read(atomic(context, "pause-" + id(owner, draft, 0) + ".json"))?.optString("reason")?.takeIf { it.isNotBlank() }
    }
    fun setPause(context: Context, owner: String, draft: String, reason: String?) = synchronized(lock) {
        val file = atomic(context, "pause-" + id(owner, draft, 0) + ".json")
        if (reason == null) file.delete() else write(file, JSONObject().put("reason", reason))
    }
    fun id(owner: String, draft: String, revision: Long): String = MessageDigest.getInstance("SHA-256")
        .digest("$owner\u0000$draft\u0000$revision".toByteArray()).joinToString("") { "%02x".format(it) }
    fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        null, JSONObject.NULL -> "null"
        is String -> JSONObject.quote(value)
        is Number -> java.math.BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
        is Boolean -> value.toString()
        else -> error("Unsupported backup metadata value")
    }
    fun assertNoLocalReferences(value: Any?, depth: Int = 0) {
        require(depth <= 20) { "Backup metadata is nested too deeply" }
        when (value) {
            is JSONObject -> value.keys().forEach { assertNoLocalReferences(value.get(it), depth + 1) }
            is JSONArray -> (0 until value.length()).forEach { assertNoLocalReferences(value.get(it), depth + 1) }
            is String -> require(!Regex("^(?:(?:file|content|ph|assets-library|asset):/{1,2}|data:[^,\\s]*,)|^/(?:data|storage|private|Users|var)/", RegexOption.IGNORE_CASE).containsMatchIn(value)) { "Backup metadata contains a local media reference" }
        }
    }
    fun now(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    fun expiresAt(value: Any?): Long {
        if (value is Number) return value.toLong()
        if (value !is String) return 0L
        value.toLongOrNull()?.let { return it }
        for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")) {
            try { return SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(value)?.time ?: 0L }
            catch (_: Exception) { }
        }
        return 0L
    }
    fun hasGrant(authority: JSONObject): Boolean = authority.optString("token").isNotBlank() && authority.optLong("expiresAt") > System.currentTimeMillis() + 30_000L
    fun read(context: Context, id: String): JSONObject? = synchronized(lock) {
        require(id.matches(Regex("[a-f0-9]{64}")))
        val job = read(atomic(context, "$id.json")) ?: return@synchronized null
        val status = read(atomic(context, "status-$id.json"))
        if (status == null || status.optLong("storageVersion") != job.optLong("storageVersion")) writeSummary(context, job)
        job
    }
    fun save(context: Context, job: JSONObject) = synchronized(lock) {
        job.put("storageVersion", job.optLong("storageVersion") + 1)
        write(atomic(context, job.getString("id") + ".json"), job)
        writeSummary(context, job)
    }
    private fun writeSummary(context: Context, job: JSONObject) {
        write(atomic(context, "status-" + job.getString("id") + ".json"), JSONObject(summary(job))
            .put("id", job.getString("id")).put("ownerId", job.getString("ownerId"))
            .put("superseded", job.optBoolean("superseded")).put("attemptId", job.optString("attemptId"))
            .put("storageVersion", job.optLong("storageVersion")))
    }
    fun gate(context: Context, id: String): JSONObject? = synchronized(lock) { read(atomic(context, "status-$id.json")) }
    fun update(context: Context, id: String, operation: (JSONObject) -> Unit): JSONObject? = synchronized(lock) {
        val job = read(context, id) ?: return@synchronized null
        operation(job); job.put("updatedAt", now()); save(context, job); job
    }
    fun jobs(context: Context, owner: String? = null): List<JSONObject> = synchronized(lock) {
        directory(context).listFiles().orEmpty().filter { it.name.matches(Regex("[a-f0-9]{64}\\.json")) }
            // A process can die between the authoritative job and compact-cache writes.
            // Startup/configuration scans repair even completed/paused rows, which may
            // never schedule another worker or receive a duplicate JS enqueue.
            .mapNotNull { read(context, it.name.removeSuffix(".json")) }.filter { owner == null || it.optString("ownerId") == owner }
    }
    fun summaries(context: Context, owner: String): List<JSONObject> = synchronized(lock) {
        directory(context).listFiles().orEmpty().filter { it.name.matches(Regex("status-[a-f0-9]{64}\\.json")) }
            .mapNotNull { read(AtomicFile(it)) }.filter { it.optString("ownerId") == owner }
    }
    fun latest(context: Context, owner: String, draft: String): JSONObject? = summaries(context, owner)
        .filter { it.optString("clientDraftId") == draft }.maxByOrNull { it.getLong("revision") }?.let { read(context, it.getString("id")) }
    fun event(context: Context, job: JSONObject, action: String, reason: String) = synchronized(lock) {
        val events = job.optJSONArray("events") ?: JSONArray().also { job.put("events", it) }
        val counter = atomic(context, "sequence-" + id(job.getString("ownerId"), job.getJSONObject("snapshot").getString("captureId"), 0) + ".json")
        val sequence = (read(counter)?.optLong("sequence") ?: 0L) + 1L
        write(counter, JSONObject().put("sequence", sequence)) // Gaps are safe; reuse after process death is not.
        val snapshot = job.getJSONObject("snapshot")
        val event = JSONObject().put("eventId", UUID.randomUUID().toString()).put("sequence", sequence).put("action", action).put("reason", reason).put("observedAt", now())
        for (field in listOf("captureId", "clientDraftId", "type", "revision", "contractNo")) if (snapshot.has(field)) event.put(field, snapshot.get(field))
        events.put(event)
        job.put("eventSequence", sequence)
    }
    fun summary(job: JSONObject): Map<String, Any> = buildMap {
        put("clientDraftId", job.getString("clientDraftId")); put("revision", job.getLong("revision"))
        put("status", job.getString("status")); put("verified", job.optJSONArray("verifiedIds")?.length() ?: 0)
        put("total", job.getJSONObject("snapshot").getJSONArray("media").length()); put("updatedAt", job.getString("updatedAt"))
        if (job.optString("planId").isNotBlank()) put("planId", job.getString("planId"))
        if (job.optString("message").isNotBlank()) put("message", job.getString("message"))
        val snapshot = job.getJSONObject("snapshot")
        if (snapshot.optString("title").isNotBlank()) put("title", snapshot.getString("title"))
        if (snapshot.optString("contractNo").isNotBlank()) put("contractNo", snapshot.getString("contractNo"))
        if (job.optString("pauseReason").isNotBlank()) put("pauseReason", job.getString("pauseReason"))
    }
}
