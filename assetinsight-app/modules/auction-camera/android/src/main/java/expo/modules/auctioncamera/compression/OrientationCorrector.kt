package expo.modules.auctioncamera.compression

import android.graphics.Bitmap
import android.graphics.Matrix
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import expo.modules.auctioncamera.model.ExifData

object OrientationCorrector {

    data class CorrectionResult(val bitmap: Bitmap, val wasRotated: Boolean, val rotationDegrees: Int)

    fun correct(bitmap: Bitmap, exif: ExifData): CorrectionResult {
        val orientation = exif.orientation ?: ExifInterface.ORIENTATION_NORMAL
        val degrees = when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90,  ExifInterface.ORIENTATION_TRANSPOSE  ->  90
            ExifInterface.ORIENTATION_ROTATE_180, ExifInterface.ORIENTATION_FLIP_VERTICAL -> 180
            ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSVERSE -> 270
            else -> 0
        }
        val flip = orientation in setOf(ExifInterface.ORIENTATION_FLIP_HORIZONTAL, ExifInterface.ORIENTATION_FLIP_VERTICAL, ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_TRANSVERSE)
        if (degrees == 0 && !flip) return CorrectionResult(bitmap, false, 0)

        val matrix = Matrix().apply { if (flip) postScale(-1f, 1f); if (degrees != 0) postRotate(degrees.toFloat()) }
        return try {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (rotated !== bitmap) bitmap.recycle()
            CorrectionResult(rotated, true, degrees)
        } catch (e: OutOfMemoryError) { Log.e("OrientCorrector", "OOM \u2014 returning original"); System.gc(); CorrectionResult(bitmap, false, 0) }
        catch (e: Exception) { Log.e("OrientCorrector", "Rotation failed: ${e.message}"); CorrectionResult(bitmap, false, 0) }
    }
}