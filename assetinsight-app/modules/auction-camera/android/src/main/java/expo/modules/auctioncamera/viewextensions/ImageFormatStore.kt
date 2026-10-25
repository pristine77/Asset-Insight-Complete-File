package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.os.Build
import androidx.core.content.edit

/**
 * Persists the user's chosen output image format across app restarts.
 *
 * Supported formats:
 *   JPEG  — existing behaviour, unchanged (default)
 *   WEBP  — lossy WebP, targets ~200 KB, broadly supported (API 14+)
 *   AVIF  — smallest files, best quality/size ratio, requires API 31+
 *           (falls back to WEBP automatically on older devices)
 *
 * Usage:
 *   ImageFormatStore.save(context, ImageFormatStore.Format.WEBP)
 *   val fmt = ImageFormatStore.load(context)   // returns Format.JPEG by default
 */
object ImageFormatStore {

    enum class Format(val label: String) {
        JPEG("JPEG"),
        WEBP("WebP"),
        AVIF("AVIF")
    }

    private const val PREFS_NAME = "image_format_prefs"
    private const val KEY_FORMAT  = "output_format"

    fun save(ctx: Context, format: Format) {
        // If the device cannot run AVIF (API < 31), silently fall back to WebP
        val actual = if (format == Format.AVIF && Build.VERSION.SDK_INT < Build.VERSION_CODES.S)
            Format.WEBP else format
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit { putString(KEY_FORMAT, actual.name) }
    }

    fun load(ctx: Context): Format {
        val raw = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_FORMAT, Format.JPEG.name) ?: Format.JPEG.name
        return runCatching { Format.valueOf(raw) }.getOrDefault(Format.JPEG)
    }

    /** True if the current device supports AVIF encoding (API 31+). */
    fun isAvifSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
}
