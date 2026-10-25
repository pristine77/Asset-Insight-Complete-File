package expo.modules.reporttransfer

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

/** Authoritative journals contain references, never copies of captured originals. */
object TransferStore {
    val lock = Any()
    private const val ALIAS = "asset-insight-report-transfer-v1"
    private val snapshots = object : LinkedHashMap<String, JSONObject>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?) = size > 8
    }
    private fun directory(context: Context) = File(context.noBackupFilesDir, "report-transfer-v1").also {
        check(it.isDirectory || it.mkdirs()) { "Report queue storage unavailable" }
    }
    private fun file(context: Context, name: String) = AtomicFile(File(directory(context), name))
    private fun read(source: AtomicFile): JSONObject? = try { source.openRead().bufferedReader().use { JSONObject(it.readText()) } }
        catch (_: java.io.FileNotFoundException) { null }
    private fun write(target: AtomicFile, value: JSONObject) {
        val output = target.startWrite()
        try { output.write(value.toString().toByteArray(Charsets.UTF_8)); target.finishWrite(output) }
        catch (error: Throwable) { target.failWrite(output); throw error }
    }
    fun id(owner: String, draft: String, session: String, revision: Long = 1) = MessageDigest.getInstance("SHA-256")
        .digest("$owner\u0000$draft\u0000$session\u0000$revision".toByteArray()).joinToString("") { "%02x".format(it) }
    fun now() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    fun expiry(value: Any?): Long {
        if (value is Number) return value.toLong()
        if (value !is String) return 0L
        value.toLongOrNull()?.let { return it }
        for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")) {
            try { return SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(value)?.time ?: 0L }
            catch (_: Exception) { }
        }
        return 0L
    }
    fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        null, JSONObject.NULL -> "null"
        is String -> JSONObject.quote(value)
        is Number -> java.math.BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
        is Boolean -> value.toString()
        else -> error("Unsupported transfer metadata")
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    fun saveSecret(context: Context, name: String, value: JSONObject) = synchronized(lock) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key())
        write(file(context, "secret-$name.json"), JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(value.toString().toByteArray()), Base64.NO_WRAP)))
    }
    fun secret(context: Context, name: String): JSONObject? = synchronized(lock) {
        val source = read(file(context, "secret-$name.json")) ?: return@synchronized null
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(source.getString("iv"), Base64.NO_WRAP)))
            JSONObject(String(cipher.doFinal(Base64.decode(source.getString("ciphertext"), Base64.NO_WRAP))))
        } catch (_: Exception) { null }
    }
    fun clearSecret(context: Context, name: String) = synchronized(lock) { file(context, "secret-$name.json").delete() }
    fun read(context: Context, id: String): JSONObject? = synchronized(lock) {
        require(id.matches(Regex("[a-f0-9]{64}")))
        val state = read(file(context, "$id.json")) ?: return@synchronized null
        val key = directory(context).absolutePath + "/" + id
        val snapshot = snapshots[key] ?: (read(file(context, "snapshot-$id.json")) ?: error("The immutable transfer snapshot is unavailable")).also { snapshots[key] = it }
        val progress = read(file(context, "progress-$id.json")) ?: JSONObject()
        state.put("snapshot", snapshot).put("verifiedIds", progress.optJSONArray("verifiedIds") ?: state.optJSONArray("verifiedIds") ?: JSONArray())
        progress.optJSONObject("hashes")?.let { state.put("hashes", it) }
        state
    }
    fun save(context: Context, job: JSONObject) = synchronized(lock) {
        val id = job.getString("id"); val immutable = file(context, "snapshot-$id.json")
        // A 5,000-file manifest is written once. Progress/events change only the
        // small checkpoint journal, avoiding gigabytes of repeated manifest writes.
        if (!immutable.baseFile.exists()) write(immutable, job.getJSONObject("snapshot"))
        else if (!file(context, "$id.json").baseFile.exists()) require(canonical(read(immutable)) == canonical(job.getJSONObject("snapshot"))) {
            "A retained immutable transfer snapshot already uses this identity"
        }
        job.put("updatedAt", now())
        val snapshot = job.getJSONObject("snapshot")
        val metadata = JSONObject(); snapshot.keys().forEach { if (it != "files") metadata.put(it, snapshot.get(it)) }
        metadata.put("totalFiles", snapshot.getJSONArray("files").length())
        val progress = JSONObject().put("verifiedIds", job.getJSONArray("verifiedIds"))
        job.optJSONObject("hashes")?.let { progress.put("hashes", it) }
        // These checkpoints only advance after server verification; a crash before
        // the state commit may preserve extra verified progress, never acceptance.
        // Keep them out of queue polling and historical owner/draft lookups.
        write(file(context, "progress-$id.json"), progress)
        val state = JSONObject(); job.keys().forEach { if (it !in setOf("snapshot", "hashes", "verifiedIds")) state.put(it, job.get(it)) }
        state.put("snapshotMetadata", metadata).put("verifiedCount", job.getJSONArray("verifiedIds").length())
        write(file(context, id + ".json"), state)
        // Repaired on every list/start: a kill between these writes never loses the authoritative job.
        write(file(context, "gate-" + job.getString("id") + ".json"), JSONObject()
            .put("status", job.getString("status")).put("attemptId", job.optString("attemptId")).put("generation", job.optString("generation")))
    }
    fun gate(context: Context, id: String): JSONObject? = synchronized(lock) { read(file(context, "gate-$id.json")) }
    fun update(context: Context, id: String, mutate: (JSONObject) -> Unit): JSONObject? = synchronized(lock) {
        val current = read(context, id) ?: return@synchronized null
        mutate(current); save(context, current); current
    }
    fun jobs(context: Context): List<JSONObject> = synchronized(lock) {
        directory(context).listFiles().orEmpty().filter { it.name.matches(Regex("[a-f0-9]{64}\\.json")) }
            .mapNotNull { source -> read(AtomicFile(source))?.let { state ->
                val metadata = state.optJSONObject("snapshotMetadata")
                if (metadata != null) state.put("snapshot", metadata)
                else read(context, source.name.removeSuffix(".json")) // Earlier local journal compatibility.
            } }
    }
    fun nextSchedulerId(context: Context): Int = synchronized(lock) {
        val source = file(context, "scheduler-sequence.json")
        val number = (read(source)?.optInt("value") ?: 170000) + 1
        check(number < 1900000000) { "Transfer queue identity exhausted" }
        write(source, JSONObject().put("value", number)); number
    }
    fun event(context: Context, job: JSONObject, action: String, reason: String? = null) = synchronized(lock) {
        val snapshot = job.getJSONObject("snapshot")
        val counter = file(context, "sequence-" + id(snapshot.getString("ownerId"), "activity", snapshot.getString("sessionId"), 0) + ".json")
        val sequence = (read(counter)?.optLong("sequence") ?: 0L) + 1L
        write(counter, JSONObject().put("sequence", sequence)) // Gaps are safe; reuse after process death is not.
        job.put("eventSequence", sequence)
        val event = JSONObject().put("eventId", UUID.randomUUID().toString()).put("sequence", sequence)
            .put("action", action).put("observedAt", now())
        job.getJSONObject("snapshot").optString("appVersion").takeIf { it.isNotBlank() }?.let { event.put("appVersion", it) }
        if (reason != null) event.put("reason", reason)
        job.getJSONArray("events").put(event)
    }
    fun summary(job: JSONObject): Map<String, Any> = buildMap {
        val snapshot = job.getJSONObject("snapshot")
        for (field in listOf("ownerId", "clientDraftId", "captureId", "clientSubmissionId", "revision", "sessionId", "type", "title")) if (snapshot.has(field)) put(field, snapshot.get(field))
        put("status", job.getString("status")); put("updatedAt", job.getString("updatedAt"))
        val total = snapshot.optJSONArray("files")?.length() ?: snapshot.getInt("totalFiles")
        val completed = job.optJSONArray("verifiedIds")?.length() ?: job.optInt("verifiedCount")
        put("totalFiles", total); put("completedFiles", completed)
        put("percent", if (job.getString("status") == "accepted") 100 else if (total > 0) completed * 95 / total else 0)
        put("canPause", job.getString("status") in setOf("queued", "uploading", "waiting_network", "interrupted") && !job.optBoolean("finalizing"))
        if (job.optString("message").isNotBlank()) put("message", job.getString("message"))
        job.optJSONObject("receipt")?.let { receipt ->
            put("receipt", receipt.keys().asSequence().associateWith { receipt.get(it) })
            if (receipt.optString("reportId").isNotBlank()) put("reportId", receipt.getString("reportId"))
        }
    }
}
