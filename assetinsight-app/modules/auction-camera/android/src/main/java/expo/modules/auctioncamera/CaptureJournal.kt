package expo.modules.auctioncamera

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Metadata only. A completed camera photo is durable before its reference is committed here. */
object CaptureJournal {
    private fun lotMap(lots: JSONArray): Map<String, Pair<Int, JSONObject>> =
        (0 until lots.length()).associate { index -> lots.getJSONObject(index).let { it.getString("id") to Pair(index, it) } }
    private fun counts(lots: JSONArray): JSONObject {
        var main = 0; var extra = 0
        for (i in 0 until lots.length()) {
            main += lots.getJSONObject(i).optJSONArray("files")?.length() ?: 0
            extra += lots.getJSONObject(i).optJSONArray("extraFiles")?.length() ?: 0
        }
        return JSONObject().put("lots", lots.length()).put("photos", main + extra).put("mainPhotos", main).put("extraPhotos", extra)
    }
    private fun photos(lot: JSONObject?, key: String): Map<String, Int> {
        val items = lot?.optJSONArray(key) ?: JSONArray()
        return (0 until items.length()).associate { index ->
            val photo = items.getJSONObject(index)
            val id = photo.optString("mediaId").ifBlank {
                MessageDigest.getInstance("SHA-256").digest(photo.optString("uri").toByteArray()).joinToString("") { "%02x".format(it) }
            }
            id to index
        }
    }
    private fun cameraReported(lots: JSONArray): Boolean {
        for (i in 0 until lots.length()) for (key in listOf("files", "extraFiles")) {
            val photos = lots.getJSONObject(i).optJSONArray(key) ?: continue
            for (p in 0 until photos.length()) if (photos.getJSONObject(p).optString("captureOrigin") == "camera") return true
        }
        return false
    }
    /** Preserve intermediate operations even when photos are removed before Done. */
    private fun observations(previous: JSONObject?, lots: JSONArray, session: JSONObject, revision: Long, sessionId: String): JSONArray {
        val events = if (previous?.optBoolean("acknowledged", false) == false) previous.optJSONArray("activity") ?: JSONArray() else JSONArray()
        val oldLots = previous?.optJSONArray("lots") ?: JSONArray()
        val old = lotMap(oldLots); val next = lotMap(lots)
        val stamp = if (cameraReported(lots)) "camera_reported" else "not_recorded"
        var part = 0
        fun add(action: String, detail: JSONObject? = null) {
            val data = JSONObject().put("beforeCounts", counts(oldLots)).put("afterCounts", counts(lots)).put("cameraStamp", stamp)
            detail?.let { data.put("lots", JSONArray().put(it)) }
            events.put(JSONObject().put("eventId", "$sessionId:$revision:${part++}").put("sequence", revision)
                .put("observedAt", java.time.Instant.now().toString()).put("action", action).put("outcome", "completed").put("data", data))
        }
        if (previous == null || previous.optBoolean("acknowledged", false)) {
            add("history_started")
            return events
        }
        for (id in old.keys + next.keys) {
            val a = old[id]; val b = next[id]
            fun detail() = JSONObject().put("id", id)
                .put("lotNumber", (b?.second ?: a?.second)?.optString("lotNumber", "") ?: "")
                .put("beforePosition", a?.first ?: JSONObject.NULL).put("afterPosition", b?.first ?: JSONObject.NULL)
                .put("beforeCover", a?.second?.optInt("coverIndex") ?: JSONObject.NULL).put("afterCover", b?.second?.optInt("coverIndex") ?: JSONObject.NULL)
                .put("before", a?.let { JSONObject().put("mainPhotos", photos(it.second, "files").size).put("extraPhotos", photos(it.second, "extraFiles").size) } ?: JSONObject.NULL)
                .put("after", b?.let { JSONObject().put("mainPhotos", photos(it.second, "files").size).put("extraPhotos", photos(it.second, "extraFiles").size) } ?: JSONObject.NULL)
            if (a == null || b == null) add(if (a == null) "lot_added" else "lot_removed", detail())
            else {
                if (a.first != b.first) add("lots_reordered", detail())
                if (a.second.optInt("coverIndex") != b.second.optInt("coverIndex")) add("cover_changed", detail())
            }
            for ((key, slot) in listOf("files" to "main", "extraFiles" to "extra")) {
                val p = photos(a?.second, key); val q = photos(b?.second, key)
                val changed = (p.keys + q.keys).filter { p[it] != q[it] }.groupBy {
                    if (!q.containsKey(it)) "photos_removed" else if (!p.containsKey(it)) "photo_captured" else "photos_reordered"
                }
                for ((action, ids) in changed) for (batch in ids.chunked(100)) {
                    val rows = JSONArray()
                    for (photo in batch) rows.put(JSONObject().put("id", photo).put("slot", slot).put("before", p[photo] ?: JSONObject.NULL).put("after", q[photo] ?: JSONObject.NULL))
                    add(action, detail().put("photos", rows))
                }
            }
        }
        if (previous.optJSONObject("session")?.optInt("activeLotNumber") != session.optInt("activeLotNumber")) add("next_lot")
        return events
    }
    private fun file(context: Context, owner: String, draft: String): AtomicFile {
        require(owner.isNotBlank() && draft.isNotBlank()) { "A capture owner and draft are required" }
        val key = MessageDigest.getInstance("SHA-256").digest("$owner\u0000$draft".toByteArray()).joinToString("") { "%02x".format(it) }
        return AtomicFile(File(File(context.filesDir, "capture-journals").apply { mkdirs() }, "$key.json"))
    }

    private fun readStored(context: Context, owner: String, draft: String): JSONObject? {
        val store = file(context, owner, draft)
        if (!store.baseFile.exists()) return null
        val value = JSONObject(store.openRead().bufferedReader().use { it.readText() })
        require(value.getString("ownerId") == owner && value.getString("draftId") == draft) { "Capture journal owner mismatch" }
        return value
    }

    @Synchronized fun read(context: Context, owner: String, draft: String): JSONObject? =
        readStored(context, owner, draft)?.takeUnless { it.optBoolean("acknowledged", false) }

    private fun write(context: Context, owner: String, draft: String, value: JSONObject) {
        val store = file(context, owner, draft)
        val stream = store.startWrite()
        try { stream.write(value.toString().toByteArray()); store.finishWrite(stream) }
        catch (error: Throwable) { store.failWrite(stream); throw error }
    }

    @Synchronized fun save(context: Context, identity: JSONObject, session: JSONObject, lots: JSONArray): JSONObject {
        val owner = identity.getString("ownerId")
        val draft = identity.getString("draftId")
        val previous = readStored(context, owner, draft)
        val sessionId = identity.getString("sessionId")
        require(previous == null || previous.optBoolean("acknowledged", false) || previous.getString("sessionId") == sessionId) { "Unacknowledged capture session exists" }
        val value = JSONObject().put("ownerId", owner).put("draftId", draft).put("sessionId", sessionId)
            .put("revision", (previous?.optLong("revision", 0) ?: 0) + 1)
            .put("updatedAt", java.time.Instant.now().toString()).put("session", session).put("lots", lots)
        value.put("activity", observations(previous, lots, session, value.getLong("revision"), sessionId))
        write(context, owner, draft, value)
        return value
    }

    @Synchronized fun acknowledge(context: Context, owner: String, draft: String, sessionId: String, revision: Long): Boolean {
        val value = readStored(context, owner, draft) ?: return true
        if (value.getString("sessionId") != sessionId || value.getLong("revision") != revision) return false
        if (value.optBoolean("acknowledged", false)) return true
        // Keep only the counter/identity. A reused draft session must never make an
        // old acknowledgement match a later capture after this journal is consumed.
        write(context, owner, draft, JSONObject().put("ownerId", owner).put("draftId", draft)
            .put("sessionId", sessionId).put("revision", revision).put("acknowledged", true))
        return true
    }
}
