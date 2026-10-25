package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import java.util.UUID

class LotBuilder(
    private val context: Context,
    private val mode:    LotMode,
    val id:              String = generateLotId()
) {
    companion object {
        private const val TAG = "LotBuilder"

        fun generateLotId(): String {
            val epoch  = System.currentTimeMillis() / 1000
            val suffix = UUID.randomUUID().toString().replace("-", "").take(5)
            return "lot-$epoch-$suffix"
        }

        fun resolveDimensions(context: Context, uri: Uri): Pair<Int, Int> {
            val startMs = SystemClock.elapsedRealtime()
            val result = try {
                when (uri.scheme) {
                    "file" -> {
                        val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        android.graphics.BitmapFactory.decodeFile(uri.path, opts)
                        Pair(opts.outWidth.coerceAtLeast(0), opts.outHeight.coerceAtLeast(0))
                    }
                    "content" -> {
                        context.contentResolver.openInputStream(uri)?.use { stream ->
                            val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            android.graphics.BitmapFactory.decodeStream(stream, null, opts)
                            Pair(opts.outWidth.coerceAtLeast(0), opts.outHeight.coerceAtLeast(0))
                        } ?: Pair(0, 0)
                    }
                    else -> Pair(0, 0)
                }
            } catch (e: Exception) {
                Log.w(TAG, "resolveDimensions failed for $uri: ${e.message}")
                Pair(0, 0)
            }
            val elapsedMs = SystemClock.elapsedRealtime() - startMs
            if (elapsedMs >= 15L) {
                Log.d(
                    "AuctionCameraTiming",
                    "dimension_read ms=$elapsedMs scheme=${uri.scheme} size=${result.first}x${result.second}"
                )
            }
            return result
        }
    }

    private var currentMode  = mode
    private val primaryFiles  = mutableListOf<CapturedFile>()
    private val extraFiles    = mutableListOf<CapturedFile>()
    private var videoFile:    VideoFile? = null
    var coverIndex: Int = 0
        private set

    constructor(context: Context, payload: LotPayload) : this(
        context,
        payload.mode ?: LotMode.SINGLE_LOT,
        payload.id
    ) {
        primaryFiles.addAll(payload.files)
        extraFiles.addAll(payload.extraFiles)
        videoFile = payload.videoFile
        coverIndex = payload.coverIndex
    }

    fun hasVideo(): Boolean = videoFile != null

    fun updateMode(newMode: LotMode) {
        currentMode = newMode
        Log.d(TAG, "Mode updated to ${newMode.apiKey}")
    }

    fun getMode(): LotMode = currentMode

    fun addPrimaryPhoto(uri: Uri, focusBox: FocusBox? = null): CapturedFile {
        val file = buildCapturedFile(uri, primaryFiles.size + 1, "primary", focusBox)
        primaryFiles.add(file)
        Log.d(TAG, "Primary #${primaryFiles.size} → ${file.name} (${file.megapixels}MP)")
        return file
    }

    fun addExtraPhoto(uri: Uri): CapturedFile {
        val file = buildCapturedFile(uri, extraFiles.size + 1, "extra", null)
        extraFiles.add(file)
        Log.d(TAG, "Extra #${extraFiles.size} → ${file.name}")
        return file
    }

    fun setVideo(uri: Uri) {
        val uriString = uri.toString()
        videoFile = VideoFile(
            uri       = uriString,
            name      = "${id}-video.mp4",
            type      = "video/mp4",
            timestamp = System.currentTimeMillis(),
            sourceUri = uriString,
            cacheUri = uriString,
            displayUri = uriString
        )
        Log.d(TAG, "Video attached: ${videoFile!!.name}")
    }

    fun removeFile(uri: Uri): Boolean {
        val uriStr = uri.toString()
        if (videoFile?.uri == uriStr) {
            videoFile = null
            Log.d(TAG, "Video removed: $uriStr")
            return true
        }
        val removedPrimary = primaryFiles.removeAll { it.uri == uriStr }
        if (removedPrimary) {
            Log.d(TAG, "Primary removed: $uriStr")
            if (coverIndex >= primaryFiles.size && primaryFiles.isNotEmpty()) {
                coverIndex = primaryFiles.size - 1
            }
            return true
        }
        val removedExtra = extraFiles.removeAll { it.uri == uriStr }
        if (removedExtra) {
            Log.d(TAG, "Extra removed: $uriStr")
            return true
        }
        return false
    }

    fun replaceUri(oldUri: Uri, newUri: Uri, w: Int = 0, h: Int = 0): Boolean {
        val oldUriStr = oldUri.toString()
        val index = primaryFiles.indexOfFirst { it.uri == oldUriStr }
        if (index != -1) {
            val (finalW, finalH) = if (w > 0 && h > 0) Pair(w, h) else resolveDimensions(context, newUri)
            val mp = if (finalW > 0 && finalH > 0) "%.1f".format((finalW * finalH).toFloat() / 1_000_000f).toDouble() else 0.0
            primaryFiles[index] = primaryFiles[index].copy(
                uri = newUri.toString(),
                width = finalW,
                height = finalH,
                megapixels = mp,
                sourceUri = primaryFiles[index].sourceUri ?: oldUriStr,
                cacheUri = primaryFiles[index].cacheUri ?: oldUriStr,
                originalUri = primaryFiles[index].originalUri ?: oldUriStr,
                displayUri = newUri.toString()
            )
            Log.d(TAG, "Primary URI swapped and dimensions updated: $newUri (${finalW}x${finalH})")
            return true
        }
        return false
    }

    fun replaceExtraUri(oldUri: Uri, newUri: Uri, w: Int = 0, h: Int = 0): Boolean {
        val oldUriStr = oldUri.toString()
        val index = extraFiles.indexOfFirst { it.uri == oldUriStr }
        if (index != -1) {
            val (finalW, finalH) = if (w > 0 && h > 0) Pair(w, h) else resolveDimensions(context, newUri)
            val mp = if (finalW > 0 && finalH > 0) "%.1f".format((finalW * finalH).toFloat() / 1_000_000f).toDouble() else 0.0
            extraFiles[index] = extraFiles[index].copy(
                uri = newUri.toString(),
                width = finalW,
                height = finalH,
                megapixels = mp,
                sourceUri = extraFiles[index].sourceUri ?: oldUriStr,
                cacheUri = extraFiles[index].cacheUri ?: oldUriStr,
                originalUri = extraFiles[index].originalUri ?: oldUriStr,
                displayUri = newUri.toString()
            )
            Log.d(TAG, "Extra URI swapped and dimensions updated: $newUri (${finalW}x${finalH})")
            return true
        }
        return false
    }

    val primaryCount: Int    get() = primaryFiles.size
    val extraCount:   Int    get() = extraFiles.size
    val hasVideo:     Boolean get() = videoFile != null
    val isEmpty:      Boolean get() = primaryFiles.isEmpty() && extraFiles.isEmpty() && videoFile == null
    val lotId:        String  get() = id

    fun build(): LotPayload {
        return LotPayload(
            id          = id,
            mode        = currentMode,
            files       = primaryFiles.toList(),
            extraFiles  = extraFiles.toList(),
            videoFile   = videoFile,
            coverIndex  = if (primaryFiles.isEmpty()) 0 else coverIndex.coerceIn(0, primaryFiles.lastIndex)
        )
    }

    fun buildOrNull(): LotPayload? = build()

    private fun nextCaptureOrder(): Int {
        val maxPrimary = primaryFiles.maxOfOrNull { it.captureOrder } ?: 0
        val maxExtra = extraFiles.maxOfOrNull { it.captureOrder } ?: 0
        return maxOf(maxPrimary, maxExtra, primaryFiles.size + extraFiles.size) + 1
    }

    private fun buildCapturedFile(
        uri:      Uri,
        index:    Int,
        tag:      String,
        focusBox: FocusBox?
    ): CapturedFile {
        val (w, h) = resolveDimensions(context, uri)
        val mp     = "%.1f".format(w.toLong() * h / 1_000_000.0).toDouble()
        val filePath = uri.path ?: ""
        val fileUri = if (uri.scheme == "file") android.net.Uri.fromFile(java.io.File(filePath)).toString() else uri.toString()

        val providerMime = if (uri.scheme == "content") context.contentResolver.getType(uri) else null
        val extension = when {
            providerMime == "image/webp" || fileUri.endsWith(".webp", ignoreCase = true) -> "webp"
            providerMime == "image/avif" || fileUri.endsWith(".avif", ignoreCase = true) -> "avif"
            else -> "jpg"
        }
        val mimeType = when (extension) {
            "webp" -> "image/webp"
            "avif" -> "image/avif"
            else -> "image/jpeg"
        }
        val captureOrder = nextCaptureOrder()

        return CapturedFile(
            uri        = fileUri,
            name       = "${id}-${tag}-${index}.$extension",
            type       = mimeType,
            width      = w,
            height     = h,
            megapixels = mp,
            focusBox   = focusBox,
            timestamp  = System.currentTimeMillis(),
            captureOrder = captureOrder,
            originalOrder = captureOrder,
            sourceUri  = fileUri,
            cacheUri   = fileUri,
            originalUri = fileUri,
            captureOrigin = "camera",
            displayUri = fileUri
        )
    }
}
