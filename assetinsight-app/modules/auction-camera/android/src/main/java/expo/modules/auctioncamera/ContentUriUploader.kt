package expo.modules.auctioncamera

import android.content.Context
import android.net.Uri
import expo.modules.kotlin.Promise
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Bounded, exact-length native upload. No JS Blob/base64 and no credential-bearing redirects. */
class ContentUriUploader(
    private val context: Context,
    private val idleTimeoutMs: Long = 120_000,
    private val progress: (String, Long, Long) -> Unit
) {
    private class Transfer(val promise: Promise) {
        // A late network result must never win a cancellation or timeout receipt.
        val terminal = AtomicReference<String?>(null)
        @Volatile var connection: HttpURLConnection? = null
        @Volatile var input: InputStream? = null
        @Volatile var task: Future<*>? = null
        @Volatile var watchdog: ScheduledFuture<*>? = null
        @Volatile var lastActivity = android.os.SystemClock.elapsedRealtime()
        fun active() = terminal.get() == null
        fun checkpoint() { if (!active() || Thread.currentThread().isInterrupted) throw InterruptedException("Upload interrupted") }
        fun advanced() { lastActivity = android.os.SystemClock.elapsedRealtime() }
    }
    private val transfers = ConcurrentHashMap<String, Transfer>()
    private val executor = Executors.newFixedThreadPool(4)
    private val watchdog = Executors.newSingleThreadScheduledExecutor()
    // HttpURLConnection.disconnect()/source close may block briefly; neither runs on
    // the Expo module thread or on the watchdog that must protect other transfers.
    // One slow disconnect must not hold up cancellation of the other three sends.
    private val cleanup = Executors.newFixedThreadPool(4)

    @Synchronized private fun stop(id: String, transfer: Transfer, code: String, message: String) {
        if (!transfer.terminal.compareAndSet(null, code)) return
        transfer.promise.reject(code, message, null)
        transfer.watchdog?.cancel(false)
        transfer.task?.cancel(true)
        cleanup.execute {
            try { transfer.connection?.disconnect() } catch (_: Exception) {}
            try { transfer.input?.close() } catch (_: Exception) {}
            transfers.remove(id, transfer)
        }
    }
    fun cancel(id: String) { transfers[id]?.let { stop(id, it, "E_UPLOAD_CANCELLED", "Upload cancelled. Resume this same upload to check its saved receipt.") } }
    @Synchronized fun close() {
        transfers.keys.forEach(::cancel)
        executor.shutdownNow()
        watchdog.shutdownNow()
        cleanup.shutdown()
    }

    @Synchronized fun upload(id: String, uriString: String, urlString: String, headers: Map<String, String>, expectedSize: Long, promise: Promise) {
        val transfer = Transfer(promise)
        if (transfers.putIfAbsent(id, transfer) != null) {
            promise.reject("E_UPLOAD_ACTIVE", "This upload is already active", null); return
        }
        val task = try { executor.submit {
            try {
                transfer.checkpoint()
                transfer.advanced()
                val timeout = idleTimeoutMs.coerceAtLeast(1)
                transfer.watchdog = watchdog.scheduleWithFixedDelay({
                    if (android.os.SystemClock.elapsedRealtime() - transfer.lastActivity >= timeout) {
                        stop(id, transfer, "E_UPLOAD_STALLED", "Upload stopped making progress. Your draft is unchanged; resume this same upload to check its saved receipt.")
                    }
                }, timeout, minOf(timeout, 1_000), TimeUnit.MILLISECONDS)
                require(expectedSize > 0) { "An exact positive upload length is required" }
                val uri = Uri.parse(uriString)
                require(uri.scheme == "content" && uri.authority == "media") { "Only device media content URIs are supported" }
                val url = URL(urlString)
                require(url.protocol == "https" && url.userInfo == null) { "A secure upload URL is required" }
                transfer.checkpoint()
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
                    transfer.checkpoint()
                    transfer.advanced()
                    val actualSize = descriptor.length
                    require(actualSize < 0 || actualSize == expectedSize) { "The photo changed after upload preparation" }
                    val connection = (url.openConnection() as HttpURLConnection).apply {
                        requestMethod = "PUT"; doOutput = true; instanceFollowRedirects = false
                        connectTimeout = 30_000; readTimeout = 120_000
                        setFixedLengthStreamingMode(expectedSize)
                        headers.forEach { (name, value) ->
                            require(!name.equals("Authorization", true) && !name.equals("Cookie", true) && !name.equals("Host", true)) { "Unsafe upload header" }
                            setRequestProperty(name, value)
                        }
                    }
                    transfer.connection = connection
                    transfer.checkpoint()
                    var sent = 0L
                    var lastProgress = 0L
                    descriptor.createInputStream().use { input ->
                        transfer.input = input
                        transfer.checkpoint()
                        connection.outputStream.use { output ->
                            transfer.checkpoint()
                            transfer.advanced()
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                transfer.checkpoint()
                                val read = input.read(buffer)
                                if (read < 0) break
                                if (read == 0) continue
                                require(sent + read <= expectedSize) { "The photo exceeds its prepared upload length" }
                                output.write(buffer, 0, read); sent += read
                                transfer.checkpoint()
                                transfer.advanced()
                                val now = android.os.SystemClock.elapsedRealtime()
                                if (now - lastProgress >= 250 || sent == expectedSize) { progress(id, sent, expectedSize); lastProgress = now }
                            }
                        }
                    }
                    require(sent == expectedSize) { "The photo is incomplete" }
                    transfer.checkpoint()
                    val status = connection.responseCode
                    transfer.checkpoint()
                    transfer.advanced()
                    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                    val body = stream?.use { input ->
                        val bytes = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(1024)
                        while (bytes.size() < 8192) {
                            val read = input.read(buffer, 0, minOf(buffer.size, 8192 - bytes.size()))
                            if (read < 0) break
                            if (read == 0) continue
                            transfer.checkpoint()
                            transfer.advanced()
                            bytes.write(buffer, 0, read)
                        }
                        String(bytes.toByteArray(), Charsets.UTF_8)
                    } ?: ""
                    val result = mapOf("status" to status, "body" to body, "headers" to connection.headerFields.filterKeys { it != null }.mapValues { it.value.joinToString(",") })
                    if (transfer.terminal.compareAndSet(null, "complete")) promise.resolve(result)
                } ?: throw IllegalStateException("The original photo is no longer available")
            } catch (error: Exception) {
                val code = if (error is InterruptedException) "E_UPLOAD_CANCELLED" else "E_UPLOAD_FAILED"
                if (transfer.terminal.compareAndSet(null, code)) promise.reject(code, error.message ?: "Photo upload failed", error)
            } finally {
                transfer.watchdog?.cancel(false)
                try { transfer.connection?.disconnect() } catch (_: Exception) {}
                transfers.remove(id, transfer)
            }
        } } catch (error: RejectedExecutionException) {
            transfers.remove(id, transfer)
            if (transfer.terminal.compareAndSet(null, "E_UPLOAD_CANCELLED")) promise.reject("E_UPLOAD_CANCELLED", "Upload service closed. Reopen your saved draft to resume.", error)
            return
        }
        transfer.task = task
        // cancel/close can race task submission, before its Future is available.
        if (!transfer.active()) task.cancel(true)
    }
}
