package expo.modules.auctioncamera.utils

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import expo.modules.auctioncamera.R

/** Capture owns its one visible logo; the upload preference never controls this. */
object CameraPhotoWatermark {
    fun stamp(context: Context, source: Bitmap): Bitmap {
        val logo = requireNotNull(BitmapFactory.decodeResource(context.resources, R.drawable.ic_app_img))
        val result = if (source.isMutable) source else source.copy(Bitmap.Config.ARGB_8888, true)
        try {
            val width = (source.width * 0.2f).coerceAtLeast(1f)
            val height = width * logo.height / logo.width
            val padding = source.width * 0.03f
            val left = (source.width - width - padding).coerceAtLeast(0f)
            val top = (source.height - height - padding).coerceAtLeast(0f)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { alpha = 200 }
            Canvas(result).drawBitmap(logo, null, RectF(left, top, left + width, top + height), paint)
            if (result !== source) source.recycle()
            return result
        } finally {
            logo.recycle()
        }
    }
}
