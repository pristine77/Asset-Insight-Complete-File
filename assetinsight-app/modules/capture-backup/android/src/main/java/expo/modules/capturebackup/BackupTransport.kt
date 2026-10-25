package expo.modules.capturebackup

import android.content.Context
import android.net.Uri
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.Semaphore

class BackupHttpFailure(val status: Int, val grantRequest: Boolean = true) : IOException("Backup request could not be completed ($status)")
class BackupStopped : IOException("Backup was stopped")
class BackupOriginalUnavailable : IOException("An original is missing, changed, or inaccessible. Keep the device originals and review the saved draft.")

/** No bearer/refresh tokens, URI logging, redirects, media copies or whole-file JavaScript buffers. */
object BackupTransport {
    private val active = ConcurrentHashMap<String, Call>()
    private val uploadSlots = Semaphore(2, true)
    private val client = OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS).callTimeout(120, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    fun cancel(id: String) { active.remove(id)?.cancel() }
    fun request(id: String, authority: JSONObject, path: String, body: JSONObject?, assertCurrent: () -> Unit): JSONObject {
        check(BuildConfig.CAPTURE_BACKUP_ENABLED) { "Cloud backup is disabled in this app release" }
        require(path == "/events" || path.matches(Regex("/plans(?:/[a-zA-Z0-9._:-]+)?(?:/(?:targets|confirm|events|status))?"))) { "Unsupported backup route" }
        assertCurrent()
        val builder = Request.Builder().url(authority.getString("apiBaseUrl") + "/capture-backups" + path)
            .header("X-Capture-Backup-Grant", authority.getString("token"))
        val headers = authority.optJSONObject("headers") ?: JSONObject()
        headers.keys().forEach { key -> builder.header(key, headers.getString(key)) }
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType())) else builder.get()
        val call = client.newCall(builder.build()); active[id] = call
        var acquired = false
        try {
            while (!uploadSlots.tryAcquire(100, TimeUnit.MILLISECONDS)) assertCurrent()
            acquired = true
            assertCurrent()
            return call.execute().use { response ->
                assertCurrent()
                if (!response.isSuccessful) throw BackupHttpFailure(response.code)
                val stream = response.body?.byteStream() ?: throw IOException("Backup receipt was empty")
                val bytes = stream.use { input ->
                    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) {
                        val read = input.read(buffer); if (read < 0) break
                        if (output.size() + read > 24 * 1024 * 1024) throw IOException("Backup receipt was too large")
                        output.write(buffer, 0, read)
                    }; output.toByteArray()
                }
                JSONObject(String(bytes, Charsets.UTF_8)).getJSONObject("data")
            }
        } finally { active.remove(id, call); if (acquired) uploadSlots.release() }
    }
    fun original(context: Context, media: JSONObject): InputStream {
        val uri = Uri.parse(media.getString("uri"))
        return try {
            when (uri.scheme) {
                "file" -> {
                    val file = File(uri.path ?: throw BackupOriginalUnavailable())
                    if (!file.isFile || (media.getLong("size") > 0 && file.length() != media.getLong("size"))) throw BackupOriginalUnavailable()
                    file.inputStream()
                }
                "content" -> context.contentResolver.openInputStream(uri) ?: throw BackupOriginalUnavailable()
                else -> throw BackupOriginalUnavailable()
            }
        } catch (_: SecurityException) { throw BackupOriginalUnavailable() }
          catch (_: java.io.FileNotFoundException) { throw BackupOriginalUnavailable() }
    }
    fun inspect(context: Context, media: JSONObject, assertCurrent: () -> Unit): Pair<String, Long> {
        val digest = MessageDigest.getInstance("SHA-256"); var size = 0L
        val expected = media.getLong("size")
        val maximum = if (media.getString("slot") == "video") 512L * 1024 * 1024 else 50L * 1024 * 1024
        original(context, media).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                assertCurrent(); val count = input.read(buffer); if (count < 0) break
                size += count; if (size > maximum || (expected > 0 && size > expected)) throw BackupOriginalUnavailable()
                digest.update(buffer, 0, count)
            }
        }
        if (size <= 0 || (expected > 0 && size != expected)) throw BackupOriginalUnavailable()
        return digest.digest().joinToString("") { "%02x".format(it) } to size
    }
    fun digest(context: Context, media: JSONObject, assertCurrent: () -> Unit): String = inspect(context, media, assertCurrent).first
    fun put(context: Context, id: String, media: JSONObject, target: JSONObject, expectedDigest: String, assertCurrent: () -> Unit) {
        check(BuildConfig.CAPTURE_BACKUP_ENABLED) { "Cloud backup is disabled in this app release" }
        val url = Uri.parse(target.getString("uploadUrl"))
        require(url.scheme == "https" && !url.host.isNullOrBlank() && url.userInfo == null && url.fragment == null) { "Invalid backup upload target" }
        val body = object : RequestBody() {
            override fun contentType() = media.getString("mimeType").toMediaType()
            override fun contentLength() = media.getLong("size")
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                val digest = MessageDigest.getInstance("SHA-256"); var sent = 0L
                original(context, media).use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        assertCurrent(); val count = input.read(buffer); if (count < 0) break
                        sent += count; if (sent > contentLength()) throw BackupOriginalUnavailable()
                        digest.update(buffer, 0, count); sink.write(buffer, 0, count)
                    }
                }
                if (sent != contentLength() || digest.digest().joinToString("") { "%02x".format(it) } != expectedDigest) throw BackupOriginalUnavailable()
                assertCurrent()
            }
        }
        val headers = target.optJSONObject("headers") ?: throw IOException("Backup storage headers were missing")
        require(headers.optString("If-None-Match", headers.optString("if-none-match")) == "*") { "Backup target must preserve existing bytes" }
        val builder = Request.Builder().url(url.toString()).put(body)
        headers.keys().forEach { key ->
            require(key.lowercase() in setOf("content-type", "if-none-match", "content-length")) { "Unsupported backup storage header" }
            if (key.equals("content-length", ignoreCase = true)) require(headers.getString(key).toLongOrNull() == media.getLong("size")) { "Backup storage length does not match the original" }
            builder.header(key, headers.getString(key))
        }
        // Progressing clips must not restart every 120 seconds. Idle timeouts remain bounded;
        // WorkManager's execution window still applies and onStopped cancels this call.
        val call = client.newBuilder().callTimeout(0, TimeUnit.MILLISECONDS).build().newCall(builder.build()); active[id] = call
        var acquired = false
        try {
            while (!uploadSlots.tryAcquire(100, TimeUnit.MILLISECONDS)) assertCurrent()
            acquired = true
            assertCurrent()
            call.execute().use { response ->
                assertCurrent()
                // Existing immutable object after a lost receipt is verified by the server's confirm.
                if (!response.isSuccessful && response.code != 412) throw BackupHttpFailure(response.code, grantRequest = false)
            }
        } finally { active.remove(id, call); if (acquired) uploadSlots.release() }
    }
}
