package expo.modules.auctioncamera.utils


import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import java.io.File
import java.io.FileOutputStream


object SoftwareNightMode {

    private const val TAG = "NightMode"
    const val FRAME_COUNT = 0
    private const val BRIGHTNESS_LIFT = 0.18f
    private const val CONTRAST_FACTOR = 1.15f
    fun stackFrames(frames: List<File>): Bitmap? {
        val file = frames.firstOrNull() ?: return null

        val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
        val bmp = runCatching { BitmapFactory.decodeFile(file.absolutePath, opts) }
            .getOrNull() ?: return null

        val width  = bmp.width
        val height = bmp.height
        val pixels = IntArray(width * height)
        bmp.getPixels(pixels, 0, width, 0, 0, width, height)
        bmp.recycle()

        for (i in pixels.indices) {
            val px = pixels[i]
            var r = (px shr 16) and 0xFF
            var g = (px shr 8)  and 0xFF
            var b =  px         and 0xFF

            r = applyBrightnessLift(r)
            g = applyBrightnessLift(g)
            b = applyBrightnessLift(b)

            r = applyContrast(r)
            g = applyContrast(g)
            b = applyContrast(b)

            pixels[i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        }

        val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        output.setPixels(pixels, 0, width, 0, 0, width, height)

        frames.forEach { runCatching { it.delete() } }
        Log.d(TAG, "Night processing complete: ${width}x${height}")
        return output
    }

    fun saveBitmap(bitmap: Bitmap, dest: File, quality: Int = 92): Boolean {
        return runCatching {
            FileOutputStream(dest).use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            }
            true
        }.getOrElse { e ->
            Log.e(TAG, "Save failed: ${e.message}")
            false
        }
    }

    private fun applyBrightnessLift(channel: Int): Int =
        (channel + ((255 - channel) * BRIGHTNESS_LIFT).toInt()).coerceIn(0, 255)

    private fun applyContrast(channel: Int): Int =
        (((channel - 128) * CONTRAST_FACTOR) + 128).toInt().coerceIn(0, 255)
}