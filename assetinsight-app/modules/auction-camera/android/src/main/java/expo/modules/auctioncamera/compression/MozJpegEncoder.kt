package expo.modules.auctioncamera.compression

import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.os.Build
import android.util.Log

/**
 * MozJPEG encoder (src/main/cpp). Measured 2026-10-22 on 3000 px camera photos: MozJPEG
 * quality 64 is half the bytes of Bitmap.compress quality 75 with the same look at 4x zoom,
 * and the output is an ordinary JPEG. Each encode takes roughly half a second, so callers
 * should encode once and step down only when a photo exceeds its byte target.
 */
object MozJpegEncoder {
    private const val TAG = "MozJpegEncoder"

    private val available: Boolean = runCatching { System.loadLibrary("auctioncamera_mozjpeg") }
        .onFailure { Log.w(TAG, "MozJPEG unavailable; using Bitmap.compress: ${it.message}") }
        .isSuccess

    @JvmStatic
    private external fun nativeEncode(bitmap: Bitmap, quality: Int): ByteArray?

    /** JPEG bytes, or null when MozJPEG cannot encode this bitmap (callers fall back). */
    fun encode(bitmap: Bitmap, quality: Int): ByteArray? {
        if (!available || bitmap.isRecycled || bitmap.config != Bitmap.Config.ARGB_8888) return null
        // The embedded ICC profile is sRGB; other colour spaces keep Android's encoder.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val colorSpace = bitmap.colorSpace
            if (colorSpace != null && colorSpace != ColorSpace.get(ColorSpace.Named.SRGB)) return null
        }
        return runCatching { nativeEncode(bitmap, quality) }
            .onFailure { Log.e(TAG, "MozJPEG encode failed: ${it.message}") }
            .getOrNull()
    }
}
