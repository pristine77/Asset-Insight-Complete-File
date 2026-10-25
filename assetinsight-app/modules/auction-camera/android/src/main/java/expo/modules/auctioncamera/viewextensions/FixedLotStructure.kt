package expo.modules.auctioncamera.viewextensions

import org.json.JSONArray
import org.json.JSONObject

/** Imported lots have stable identities. The displayed label is never a navigation key. */
class FixedLotStructure private constructor(
    private val slots: List<Slot>,
    private val labels: List<String>
) {
    private data class Slot(val id: String, val mode: LotMode)
    val size: Int get() = slots.size

    fun label(number: Int): String = labels.getOrNull(number - 1)?.takeIf { it.isNotBlank() } ?: "Lot $number"
    fun contains(number: Int): Boolean = number in 1..size
    fun mode(number: Int): LotMode = slots[checkedIndex(number)].mode
    private fun checkedIndex(number: Int): Int {
        require(contains(number)) { "This lot is not in the imported capture" }
        return number - 1
    }
    fun validateLot(lot: LotPayload, number: Int = lot.lotNumber) {
        val slot = slots[checkedIndex(number)]
        require(lot.lotNumber == number && lot.id == slot.id && lot.mode == slot.mode) {
            "Imported lot identity, order or mode changed. Reopen the original draft."
        }
    }
    fun validate(lots: List<LotPayload>) {
        require(lots.size == size) { "Imported lots cannot be added or removed in the camera" }
        lots.forEachIndexed { index, lot -> validateLot(lot, index + 1) }
    }
    fun saveTo(root: JSONObject) {
        root.put("lockedStructure", true)
        root.put("fixedLots", JSONArray().also { rows -> slots.forEachIndexed { index, slot ->
            rows.put(JSONObject().put("id", slot.id).put("mode", slot.mode.apiKey).put("lotNumber", index + 1))
        } })
        root.put("sourceLabels", JSONArray(labels))
    }
    fun validateSession(root: JSONObject) {
        require(root.optBoolean("lockedStructure", false)) { "An older camera session needs review before opening imported lots" }
        val saved = parseRows(root.getJSONArray("fixedLots"))
        require(saved == slots) { "Saved camera lots no longer match the imported draft" }
    }

    companion object {
        fun fromPayload(root: JSONObject?): FixedLotStructure? {
            if (root?.optBoolean("lockedStructure", false) != true) return null
            val rows = root.getJSONArray("lots")
            val slots = parseRows(rows)
            val supplied = root.optJSONArray("sourceLabels")
            require(supplied == null || supplied.length() == slots.size) { "Imported lot labels do not match the lot count" }
            val labels = slots.indices.map { index -> supplied?.optString(index, "")?.take(500) ?: "" }
            return FixedLotStructure(slots, labels)
        }

        private fun parseRows(rows: JSONArray): List<Slot> {
            require(rows.length() in 1..5000) { "Imported camera lots are missing or exceed the supported limit" }
            val slots = (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index)
                val id = row.getString("id")
                val mode = LotMode.entries.firstOrNull { it.apiKey == row.getString("mode") }
                    ?: throw IllegalArgumentException("Imported lot mode is invalid")
                require(id.isNotBlank() && row.getInt("lotNumber") == index + 1) { "Imported lot order is invalid" }
                Slot(id, mode)
            }
            require(slots.map { it.id }.toSet().size == slots.size) { "Imported lot identities must be unique" }
            return slots
        }
    }
}
