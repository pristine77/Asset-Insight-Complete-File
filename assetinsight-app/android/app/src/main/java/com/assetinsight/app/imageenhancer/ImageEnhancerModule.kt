package com.assetinsight.app.imageenhancer

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import kotlin.math.abs

class ImageEnhancerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  companion object {
    const val NAME = "ImageEnhancer"
  }

  private val executor = Executors.newSingleThreadExecutor()

  override fun getName(): String = NAME

  @ReactMethod
  fun autoEnhance(path: String, promise: Promise) {
    executor.execute {
      try {
        val inPath = if (path.startsWith("file://")) path.removePrefix("file://") else path
        val inFile = File(inPath)
        if (!inFile.exists()) {
          promise.reject("ENOENT", "File not found: $inPath")
          return@execute
        }

        val bitmap: Bitmap? = if (Build.VERSION.SDK_INT >= 28) {
          val source = ImageDecoder.createSource(inFile)
          ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SHARED_MEMORY)
            decoder.setMutableRequired(true)
          }
        } else {
          val opts = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inMutable = true
          }
          BitmapFactory.decodeFile(inFile.absolutePath, opts)
        }

        if (bitmap == null) {
          promise.reject("EDECODE", "Failed to decode image")
          return@execute
        }

        val width = bitmap.width
        val height = bitmap.height

        val contrast = 1.08f
        val saturation = 1.10f

        val invSat = 1f - saturation
        val rW = 0.213f
        val gW = 0.715f
        val bW = 0.072f

        val satR = invSat * rW
        val satG = invSat * gW
        val satB = invSat * bW

        fun clamp(v: Int): Int = when {
          v < 0 -> 0
          v > 255 -> 255
          else -> v
        }

        val row = IntArray(width)
        for (y in 0 until height) {
          bitmap.getPixels(row, 0, width, 0, y, width, 1)
          for (x in 0 until width) {
            val c = row[x]
            val a = (c ushr 24) and 0xFF
            var r = (c ushr 16) and 0xFF
            var g = (c ushr 8) and 0xFF
            var b = c and 0xFF

            val rr = (r * (satR + saturation) + g * satG + b * satB)
            val gg = (r * satR + g * (satG + saturation) + b * satB)
            val bb = (r * satR + g * satG + b * (satB + saturation))

            r = clamp(((rr - 128f) * contrast + 128f).toInt())
            g = clamp(((gg - 128f) * contrast + 128f).toInt())
            b = clamp(((bb - 128f) * contrast + 128f).toInt())

            row[x] = (a shl 24) or (r shl 16) or (g shl 8) or b
          }
          bitmap.setPixels(row, 0, width, 0, y, width, 1)
        }

        val mp = (width.toLong() * height.toLong()).toDouble() / 1_000_000.0
        val doSharpen = width >= 3 && height >= 3 && mp <= 32.0

        if (doSharpen) {
          val amount = 0.5f

          fun luma(c: Int): Int {
            val r = (c ushr 16) and 0xFF
            val g = (c ushr 8) and 0xFF
            val b = c and 0xFF
            return (0.2126f * r + 0.7152f * g + 0.0722f * b).toInt()
          }

          var prev = IntArray(width)
          var curr = IntArray(width)
          var next = IntArray(width)

          var lPrev = IntArray(width)
          var lCurr = IntArray(width)
          var lNext = IntArray(width)

          bitmap.getPixels(prev, 0, width, 0, 0, width, 1)
          for (i in 0 until width) lPrev[i] = luma(prev[i])

          bitmap.getPixels(curr, 0, width, 0, 1, width, 1)
          for (i in 0 until width) lCurr[i] = luma(curr[i])

          for (y in 1 until height - 1) {
            bitmap.getPixels(next, 0, width, 0, y + 1, width, 1)
            for (i in 0 until width) lNext[i] = luma(next[i])

            val out = curr.copyOf()

            for (x in 1 until width - 1) {
              val blur = (
                lPrev[x - 1] + lPrev[x] + lPrev[x + 1] +
                  lCurr[x - 1] + lCurr[x] + lCurr[x + 1] +
                  lNext[x - 1] + lNext[x] + lNext[x + 1]
                ) / 9

              val baseY = lCurr[x]
              val detail = baseY - blur
              if (abs(detail) < 2) continue

              val newYf = (baseY.toFloat() + amount * detail.toFloat()).coerceIn(0f, 255f)
              val ratio = if (baseY <= 0) 1f else (newYf / baseY.toFloat())

              val c = curr[x]
              val a = (c ushr 24) and 0xFF
              val r0 = (c ushr 16) and 0xFF
              val g0 = (c ushr 8) and 0xFF
              val b0 = c and 0xFF

              val r = clamp((r0.toFloat() * ratio).toInt())
              val g = clamp((g0.toFloat() * ratio).toInt())
              val b = clamp((b0.toFloat() * ratio).toInt())

              out[x] = (a shl 24) or (r shl 16) or (g shl 8) or b
            }

            bitmap.setPixels(out, 0, width, 0, y, width, 1)

            val tmpP = prev
            prev = curr
            curr = next
            next = tmpP

            val tmpL = lPrev
            lPrev = lCurr
            lCurr = lNext
            lNext = tmpL
          }
        }

        val outFile = File(inFile.parentFile, inFile.nameWithoutExtension + "-enhanced.jpg")
        FileOutputStream(outFile).use { out ->
          bitmap.compress(Bitmap.CompressFormat.JPEG, 98, out)
        }
        bitmap.recycle()

        try {
          val inExif = ExifInterface(inFile.absolutePath)
          val outExif = ExifInterface(outFile.absolutePath)
          val tags = arrayOf(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.TAG_DATETIME,
            ExifInterface.TAG_MAKE,
            ExifInterface.TAG_MODEL,
            ExifInterface.TAG_F_NUMBER,
            ExifInterface.TAG_EXPOSURE_TIME,
            ExifInterface.TAG_ISO_SPEED_RATINGS,
            ExifInterface.TAG_FOCAL_LENGTH,
            ExifInterface.TAG_WHITE_BALANCE,
            ExifInterface.TAG_GPS_LATITUDE,
            ExifInterface.TAG_GPS_LONGITUDE,
            ExifInterface.TAG_GPS_LATITUDE_REF,
            ExifInterface.TAG_GPS_LONGITUDE_REF
          )
          for (t in tags) {
            val v = inExif.getAttribute(t)
            if (v != null) outExif.setAttribute(t, v)
          }
          outExif.saveAttributes()
        } catch (_: Throwable) {
        }

        promise.resolve("file://" + outFile.absolutePath)
      } catch (e: Throwable) {
        promise.reject("EENHANCE", e.message, e)
      }
    }
  }
}
