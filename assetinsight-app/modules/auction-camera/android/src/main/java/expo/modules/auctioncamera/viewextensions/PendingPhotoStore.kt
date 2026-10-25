package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import expo.modules.auctioncamera.CaptureMode
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** Immutable shot ownership. No raw frame is ever inserted into a report. */
data class CaptureTicket(val mode: CaptureMode, val isExtra: Boolean, val tapAtMs: Long,
    val lotNumber: Int, val id: String = UUID.randomUUID().toString()) {
    fun json() = JSONObject().put("id", id).put("mode", mode.name).put("extra", isExtra)
        .put("tap", tapAtMs).put("lot", lotNumber)
    companion object {
        fun read(value: JSONObject) = CaptureTicket(CaptureMode.valueOf(value.getString("mode")),
            value.getBoolean("extra"), value.getLong("tap"), value.getInt("lot"), value.getString("id"))
    }
}

object PendingPhotoStore {
    data class Frame(val raw: File, val record: File, val data: JSONObject) {
        val ticket get() = CaptureTicket.read(data.getJSONObject("ticket"))
    }
    private val uuid = Regex("[0-9a-f-]{36}")
    private fun directory(context: Context) = File(context.filesDir, "pending-camera-photos").apply { check(isDirectory || mkdirs()) }
    private fun write(file: File, value: JSONObject) {
        val atomic = AtomicFile(file)
        val out = atomic.startWrite()
        try { out.write(value.toString().toByteArray()); atomic.finishWrite(out) }
        catch (error: Throwable) { atomic.failWrite(out); throw error }
    }
    @Synchronized fun create(context: Context, identity: JSONObject, ticket: CaptureTicket, options: JSONObject): Frame {
        require(uuid.matches(ticket.id))
        for (key in listOf("ownerId", "draftId", "sessionId")) require(identity.getString(key).isNotBlank())
        val folder = directory(context)
        val frame = Frame(File(folder, ticket.id + ".jpg"), File(folder, ticket.id + ".json"),
            JSONObject().put("identity", JSONObject(identity.toString())).put("ticket", ticket.json()).put("options", options)
                .put("ready", false).put("pid", android.os.Process.myPid()))
        write(frame.record, frame.data)
        return frame
    }
    @Synchronized fun pending(context: Context, identity: JSONObject, includeFailed: Boolean = false): List<Frame> =
        directory(context).listFiles().orEmpty().filter { it.extension == "json" }.mapNotNull { file -> runCatching {
            val data = JSONObject(AtomicFile(file).openRead().bufferedReader().use { it.readText() })
            val owner = data.getJSONObject("identity")
            if (listOf("ownerId", "draftId", "sessionId").any { owner.getString(it) != identity.getString(it) }) return@runCatching null
            if (!includeFailed && data.optBoolean("failed")) return@runCatching null
            val ticket = CaptureTicket.read(data.getJSONObject("ticket"))
            require(uuid.matches(ticket.id) && file.name == ticket.id + ".json")
            val raw = File(file.parentFile, ticket.id + ".jpg")
            if (!data.optBoolean("ready")) {
                // Never race a CameraX writer in this process. After process
                // death only a complete JPEG end marker permits raw recovery.
                if (data.optInt("pid") == android.os.Process.myPid() || !raw.isFile || raw.length() < 2) return@runCatching null
                val complete = java.io.RandomAccessFile(raw, "r").use { it.seek(it.length() - 2); it.readUnsignedShort() == 0xffd9 }
                if (!complete) return@runCatching null
                data.put("ready", true); write(file, data)
            }
            Frame(raw, file, data)
        }.getOrNull() }.sortedBy { it.ticket.tapAtMs }
    @Synchronized fun completed(frame: Frame, result: JSONObject) { frame.data.put("result", result).put("failed", false); write(frame.record, frame.data) }
    @Synchronized fun ready(frame: Frame) { frame.data.put("ready", true); write(frame.record, frame.data) }
    @Synchronized fun failed(frame: Frame) { frame.data.put("failed", true); write(frame.record, frame.data) }
    @Synchronized fun acknowledge(frame: Frame) {
        // Called only after the processed URI is durably in the owner-bound lot journal.
        frame.raw.delete(); AtomicFile(frame.record).delete()
    }
}

/** One encoder, at most three live shots, ordered delivery. Survives activity rotation. */
object PhotoWorkQueue {
    val executor = Executors.newSingleThreadExecutor()
    private data class Receiver(val commit: (JSONObject) -> Boolean, val finish: (String?) -> Unit, val revision: Long)
    private val receivers = mutableMapOf<String, Receiver>()
    @Synchronized fun activeCount() = receivers.size
    @Synchronized fun contains(id: String) = receivers.containsKey(id)
    fun enqueue(frame: PendingPhotoStore.Frame, work: () -> JSONObject, commit: (JSONObject) -> Boolean, finish: (String?) -> Unit, receiverRevision: Long = 0) {
        val id = frame.ticket.id
        synchronized(this) {
            if (!frame.record.isFile || (receivers[id]?.revision ?: Long.MIN_VALUE) > receiverRevision) return
            val exists = receivers.containsKey(id)
            receivers[id] = Receiver(commit, finish, receiverRevision)
            if (exists) return // The recreated activity takes delivery of the same job.
        }
        executor.execute {
            var error: String? = null
            val result = try {
                work().also { PendingPhotoStore.completed(frame, it) }
            } catch (failure: Throwable) {
                if (failure !is Exception && failure !is OutOfMemoryError) throw failure
                runCatching { PendingPhotoStore.failed(frame) }
                error = "Photo processing could not finish. Its original frame is kept on this device; reopen this draft to retry."
                null
            }
            Handler(Looper.getMainLooper()).post {
                val receiver = synchronized(this) { receivers.remove(id) } ?: return@post
                try {
                    if (result != null) {
                        if (receiver.commit(result)) PendingPhotoStore.acknowledge(frame)
                        else error = "Photo is saved on this device. Its draft could not be saved; free storage and tap Done to retry."
                    }
                } catch (_: Exception) {
                    error = "Photo is saved locally but its lot could not be saved. Reopen this draft to recover it."
                } finally { receiver.finish(error) }
            }
        }
    }
}
