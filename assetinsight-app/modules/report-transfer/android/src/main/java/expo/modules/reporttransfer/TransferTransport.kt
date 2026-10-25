package expo.modules.reporttransfer

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class TransferHttpFailure(val status: Int, val code: String = "") : IOException("Report transfer request failed ($status)")
class TransferStopped : IOException("Report transfer stopped")
class TransferOriginalUnavailable : IOException("An original is missing, changed or inaccessible. Open the saved draft; originals were retained.")

/** Every byte streams from the original. No main bearer token, redirects, media logging or recompression. */
object TransferTransport {
    private val calls = ConcurrentHashMap<String, MutableSet<Call>>()
    private var client = OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).callTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).build()
    fun cancel(id: String) { synchronized(calls) { calls.remove(id)?.toList() }?.forEach { it.cancel() } }
    fun requireDurableOriginal(context: Context, media: JSONObject) {
        val uri = Uri.parse(media.getString("uri"))
        when (uri.scheme) {
            "file" -> {
                val file = File(uri.path ?: throw TransferOriginalUnavailable()).canonicalFile
                val roots = listOf(context.filesDir, context.noBackupFilesDir) + context.getExternalFilesDirs(null).filterNotNull()
                require(roots.any { file.path.startsWith(it.canonicalPath + File.separator) }) { "Save this original in the draft before starting background upload" }
                if (!file.isFile || file.length() != media.getLong("size")) throw TransferOriginalUnavailable()
            }
            "content" -> {
                val persisted = context.contentResolver.persistedUriPermissions.any { it.isReadPermission && (uri == it.uri || uri.toString().startsWith(it.uri.toString().trimEnd('/') + "/")) }
                val ownMedia = if (Build.VERSION.SDK_INT >= 29 && uri.authority == MediaStore.AUTHORITY) runCatching {
                    context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.OWNER_PACKAGE_NAME), null, null, null)?.use { it.moveToFirst() && it.getString(0) == context.packageName } == true
                }.getOrDefault(false) else false
                require(persisted || ownMedia) { "This gallery original needs to be saved in the draft before background upload" }
                original(context, media).use { } // Verify permission without copying or reading the whole original.
            }
            else -> throw TransferOriginalUnavailable()
        }
    }
    private fun original(context: Context, media: JSONObject): InputStream {
        val uri = Uri.parse(media.getString("uri"))
        return try {
            when (uri.scheme) {
                "file" -> {
                    val file = File(uri.path ?: throw TransferOriginalUnavailable())
                    if (!file.isFile || file.length() != media.getLong("size")) throw TransferOriginalUnavailable()
                    file.inputStream()
                }
                "content" -> context.contentResolver.openInputStream(uri) ?: throw TransferOriginalUnavailable()
                else -> throw TransferOriginalUnavailable()
            }
        } catch (_: SecurityException) { throw TransferOriginalUnavailable() }
          catch (_: java.io.FileNotFoundException) { throw TransferOriginalUnavailable() }
    }
    fun inspect(context: Context, media: JSONObject, assertCurrent: () -> Unit): String {
        val digest = MessageDigest.getInstance("SHA-256"); var length = 0L
        original(context, media).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                assertCurrent(); val count = input.read(buffer); if (count < 0) break
                length += count; if (length > media.getLong("size")) throw TransferOriginalUnavailable()
                digest.update(buffer, 0, count)
            }
        }
        if (length != media.getLong("size")) throw TransferOriginalUnavailable()
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    private fun request(context: Context, job: JSONObject, suffix: String, body: RequestBody?, assertCurrent: () -> Unit): JSONObject {
        require(suffix in setOf("status", "complete", "events") || suffix.matches(Regex("files/[a-zA-Z0-9._:-]+(?:/verify)?"))) { "Unsupported transfer route" }
        assertCurrent()
        val snapshot = job.getJSONObject("snapshot"); val id = job.getString("id")
        val authority = TransferStore.secret(context, "owner") ?: throw TransferStopped()
        if (authority.optString("ownerId") != snapshot.getString("ownerId")) throw TransferStopped()
        val grant = TransferStore.secret(context, id) ?: throw TransferHttpFailure(401)
        if (grant.optLong("expiresAt") <= System.currentTimeMillis() + 30_000L) throw TransferHttpFailure(401)
        val route = "/report-transfers/" + snapshot.getString("type") + "/" + snapshot.getString("sessionId") + "/" + suffix
        val request = Request.Builder().url(authority.getString("apiBaseUrl") + route).header("X-Report-Transfer-Grant", grant.getString("token"))
        val headers = authority.getJSONObject("headers"); headers.keys().forEach { request.header(it, headers.getString(it)) }
        if (body == null) request.get() else request.post(body)
        val call = client.newCall(request.build())
        synchronized(calls) { calls.getOrPut(id) { mutableSetOf() }.add(call) }
        try {
            assertCurrent()
            return call.execute().use { response ->
                assertCurrent()
                val input = response.body?.byteStream() ?: throw IOException("Empty transfer response")
                val bytes = input.use { stream ->
                    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { assertCurrent(); val count = stream.read(buffer); if (count < 0) break
                        if (output.size() + count > 2 * 1024 * 1024) throw IOException("Transfer response too large")
                        output.write(buffer, 0, count)
                    }; output.toByteArray()
                }
                val payload = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (_: Exception) { JSONObject() }
                if (!response.isSuccessful) throw TransferHttpFailure(response.code, payload.optString("code"))
                if (suffix == "complete") payload.optJSONObject("data") ?: payload
                else payload.optJSONObject("data") ?: throw IOException("Transfer response was incomplete")
            }
        } finally { synchronized(calls) { calls[id]?.let { it.remove(call); if (it.isEmpty()) calls.remove(id) } } }
    }
    fun json(context: Context, job: JSONObject, suffix: String, body: JSONObject?, assertCurrent: () -> Unit): JSONObject =
        request(context, job, suffix, body?.toString()?.toRequestBody("application/json".toMediaType()), assertCurrent)
    fun upload(context: Context, job: JSONObject, media: JSONObject, expectedHash: String, assertCurrent: () -> Unit): JSONObject {
        val body = object : RequestBody() {
            override fun contentType() = media.getString("type").toMediaType()
            override fun contentLength() = media.getLong("size")
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                val digest = MessageDigest.getInstance("SHA-256"); var sent = 0L
                original(context, media).use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        assertCurrent(); val count = input.read(buffer); if (count < 0) break
                        sent += count; if (sent > contentLength()) throw TransferOriginalUnavailable()
                        digest.update(buffer, 0, count); sink.write(buffer, 0, count)
                    }
                }
                if (sent != contentLength() || digest.digest().joinToString("") { "%02x".format(it) } != expectedHash) throw TransferOriginalUnavailable()
                assertCurrent()
            }
        }
        return request(context, job, "files/" + media.getString("fileId"), MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", media.getString("name"), body).build(), assertCurrent)
    }
}
