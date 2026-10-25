package expo.modules.auctioncamera

import android.content.Context
import android.content.Intent
import android.util.AtomicFile
import java.io.File
import java.util.UUID

/**
 * Activity intents cross Binder's shared, size-limited transaction buffer. A camera
 * result includes all lots and its durable activity journal, so even metadata must
 * travel through private files rather than an Intent extra. This store contains no
 * photo bytes and never acknowledges or removes the durable capture journal.
 */
object CameraPayloadStore {
    const val EXTRA_HANDOFF_ID = "camera_handoff_id"
    const val EXTRA_ERROR_CODE = "camera_handoff_error"
    private val validId = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    private fun file(context: Context, id: String, result: Boolean): AtomicFile {
        require(validId.matches(id)) { "Invalid camera handoff identity" }
        val directory = File(context.filesDir, "camera-handoffs")
        check(directory.isDirectory || directory.mkdirs()) { "Camera handoff storage is unavailable" }
        return AtomicFile(File(directory, "$id-${if (result) "result" else "input"}.json"))
    }

    private fun write(context: Context, id: String, result: Boolean, payload: String) {
        val store = file(context, id, result)
        val stream = store.startWrite()
        try {
            stream.write(payload.toByteArray(Charsets.UTF_8))
            store.finishWrite(stream)
        } catch (error: Throwable) {
            store.failWrite(stream)
            throw error
        }
    }

    fun prepare(context: Context, payload: String, id: String = UUID.randomUUID().toString()): String = id.also {
        write(context, it, false, payload)
    }

    fun input(context: Context, intent: Intent): String? {
        val id = intent.getStringExtra(EXTRA_HANDOFF_ID)
            ?: return intent.getStringExtra(AuctionCameraModule.EXTRA_LOT_PAYLOAD_JSON)
        return file(context, id, false).openRead().bufferedReader().use { it.readText() }
    }

    fun resultIntent(context: Context, launchIntent: Intent, payload: String): Intent {
        // Legacy callers have no handoff token; give their result a fresh token too.
        val id = launchIntent.getStringExtra(EXTRA_HANDOFF_ID) ?: UUID.randomUUID().toString()
        write(context, id, true, payload)
        return Intent().putExtra(EXTRA_HANDOFF_ID, id)
    }

    fun result(context: Context, intent: Intent?, expectedId: String?): String {
        val id = intent?.getStringExtra(EXTRA_HANDOFF_ID)
            ?: throw IllegalStateException("Camera returned no saved capture receipt")
        require(expectedId == null || id == expectedId) { "Camera capture receipt does not match this session" }
        return file(context, id, true).openRead().bufferedReader().use { it.readText() }
    }

    fun hasResult(context: Context, id: String): Boolean = runCatching {
        val store = file(context, id, true)
        store.baseFile.isFile || File(store.baseFile.path + ".bak").isFile
    }.getOrDefault(false)

    /** Deletes only the exact metadata transport files, never originals or journals. */
    fun discard(context: Context, id: String) {
        file(context, id, false).delete()
        file(context, id, true).delete()
    }
}
