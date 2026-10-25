package expo.modules.auctioncamera.viewextensions

import org.json.JSONArray
import org.json.JSONObject

object LotJsonSerializer {

    fun serialize(lots: List<LotPayload>): String {
        val array = JSONArray()
        lots.forEachIndexed { lotIndex, lot ->
            array.put(lotToJson(lot, lotIndex + 1))
        }
        return array.toString(2).replace("\\/", "/")
    }

    private fun lotToJson(lot: LotPayload, lotNumber: Int): JSONObject {
        val modeShort = when (lot.mode) {
            LotMode.SINGLE_LOT -> "bundle"
            LotMode.PER_ITEM   -> "item"
            LotMode.PER_PHOTO  -> "photo"
            else               -> "bundle"
        }
        return JSONObject().apply {
            put("id",         lot.id)
            put("mode",       (lot.mode ?: LotMode.SINGLE_LOT).apiKey)
            put("files",      filesArray(lot.files, lotNumber, modeShort, isExtra = false))
            put("extraFiles", filesArray(lot.extraFiles, lotNumber, modeShort, isExtra = true))
            lot.videoFile?.let { put("videoFile", videoToJson(it, lotNumber, modeShort)) }
            put("coverIndex", lot.coverIndex)
        }
    }

    private fun filesArray(
        files: List<CapturedFile>,
        lotNumber: Int,
        modeShort: String,
        isExtra: Boolean
    ): JSONArray {
        val arr = JSONArray()
        files.forEachIndexed { index, f ->
            arr.put(fileToJson(f, lotNumber, modeShort, index + 1, isExtra))
        }
        return arr
    }

    private fun fileToJson(
        f: CapturedFile,
        lotNumber: Int,
        modeShort: String,
        fileIndex: Int,
        isExtra: Boolean
    ): JSONObject {
        val extraPart = if (isExtra) "-extra" else ""
        val importUri = f.sourceUri ?: f.cacheUri ?: f.originalUri ?: f.uri
        val displayUri = f.displayUri ?: if (f.uri != importUri) f.uri else null
        
        val extension = when {
            f.type == "image/webp" || importUri.endsWith(".webp", ignoreCase = true) -> "webp"
            f.type == "image/avif" || importUri.endsWith(".avif", ignoreCase = true) -> "avif"
            else -> "jpg"
        }
        val mimeType = when (extension) {
            "webp" -> "image/webp"
            "avif" -> "image/avif"
            else -> "image/jpeg"
        }
        
        val humanName = "lot-$lotNumber-$modeShort$extraPart-$fileIndex.$extension"

        return JSONObject().apply {
            put("mediaId", f.mediaId)
            f.captureOrigin?.let { put("captureOrigin", it) }
            put("ownership", if (importUri.startsWith("content://media/")) "gallery" else "camera")
            put("uri",        importUri)
            put("name",       humanName)
            put("type",       mimeType)
            put("width",      f.width)
            put("height",     f.height)
            put("megapixels", f.megapixels)
            put("timestamp",  f.timestamp)
            put("captureOrder", f.captureOrder)
            put("originalOrder", f.originalOrder)
            put("sourceUri",  importUri)
            put("cacheUri",   f.cacheUri ?: importUri)
            put("originalUri", f.originalUri ?: importUri)
            displayUri?.let { put("displayUri", it) }
            f.focusBox?.let { box ->
                put("focusBox", JSONObject().apply {
                    put("x", box.x)
                    put("y", box.y)
                    put("w", box.w)
                    put("h", box.h)
                })
            }
        }
    }

    private fun videoToJson(v: VideoFile, lotNumber: Int, modeShort: String): JSONObject {
        val humanName = "lot-$lotNumber-$modeShort-walkthrough.mp4"
        val importUri = v.sourceUri ?: v.cacheUri ?: v.uri
        val displayUri = v.displayUri ?: if (v.uri != importUri) v.uri else null
        return JSONObject().apply {
            put("uri",  importUri)
            put("name", humanName)
            put("type", "video/mp4")
            put("timestamp", v.timestamp)
            put("sourceUri", importUri)
            v.cacheUri?.let { put("cacheUri", it) }
            displayUri?.let { put("displayUri", it) }
        }
    }
}
