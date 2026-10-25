package expo.modules.auctioncamera.viewextensions

import android.net.Uri
import com.google.gson.annotations.SerializedName

enum class LotMode(val apiKey: String, val displayLabel: String) {
    SINGLE_LOT ("single_lot", "Bundle"),
    PER_ITEM   ("per_item",   "Item"),
    PER_PHOTO  ("per_photo",  "Photo");

    companion object {
        fun fromApiKey(key: String): LotMode =
            entries.firstOrNull { it.apiKey == key } ?: SINGLE_LOT
    }

    fun toCaptureMode(): expo.modules.auctioncamera.CaptureMode = when (this) {
        SINGLE_LOT -> expo.modules.auctioncamera.CaptureMode.BUNDLE
        PER_ITEM   -> expo.modules.auctioncamera.CaptureMode.ITEM
        PER_PHOTO  -> expo.modules.auctioncamera.CaptureMode.PHOTO
    }
}

data class FocusBox(
    @SerializedName("x") val x: Float,
    @SerializedName("y") val y: Float,
    @SerializedName("w") val w: Float,
    @SerializedName("h") val h: Float
)

data class CapturedFile(
    @SerializedName("uri")        val uri:        String,
    @SerializedName("name")       val name:       String,
    @SerializedName("type")       val type:       String    = "image/jpeg",
    @SerializedName("width")      val width:      Int,
    @SerializedName("height")     val height:     Int,
    @SerializedName("megapixels") val megapixels: Double,
    @SerializedName("focusBox")   val focusBox:  FocusBox? = null,
    @SerializedName("timestamp")  val timestamp: Long      = 0L,
    @SerializedName("captureOrder") val captureOrder: Int   = 0,
    @SerializedName("originalOrder") val originalOrder: Int = 0,
    @SerializedName("sourceUri")  val sourceUri: String?   = null,
    @SerializedName("cacheUri")   val cacheUri:  String?   = null,
    @SerializedName("originalUri") val originalUri: String? = null,
    @SerializedName("displayUri") val displayUri: String?  = null,
    @SerializedName("mediaId") val mediaId: String = java.util.UUID.randomUUID().toString(),
    @SerializedName("captureOrigin") val captureOrigin: String? = null
)

data class VideoFile(
    @SerializedName("uri")       val uri:       String,
    @SerializedName("name")      val name:      String,
    @SerializedName("type")      val type:      String = "video/mp4",
    @SerializedName("timestamp") val timestamp: Long   = 0L,
    @SerializedName("sourceUri") val sourceUri: String? = null,
    @SerializedName("cacheUri")  val cacheUri:  String? = null,
    @SerializedName("displayUri") val displayUri: String? = null
)

data class LotPayload(
    @SerializedName("id")         val id:         String,
    @SerializedName("mode")       val mode: LotMode? = LotMode.SINGLE_LOT,
    @SerializedName("files")      val files:      List<CapturedFile> = emptyList(),
    @SerializedName("extraFiles") val extraFiles: List<CapturedFile> = emptyList(),
    @SerializedName("videoFile")  val videoFile:  VideoFile?         = null,
    @SerializedName("coverIndex") val coverIndex: Int                = 0,
    @SerializedName("lotNumber")  val lotNumber:  Int                = 1
)

data class LotLegacy(val label: String, val count: Int)

data class  ProSettings(
    val isoProgress: Int = 0,
    val shutterProgress: Int = 0,
    val fpsMin: Int = 30,
    val fpsMax: Int = 30,
    val wbLabel: String = "Auto",
    val wbIndex: Int = 0,
    val contrast:        Int    = 0,
    val color:           Int    = 0,
    val sharpness:       Int    = 0
)
