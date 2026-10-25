package expo.modules.auctioncamera.utils

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import expo.modules.auctioncamera.model.ImageProcessingConfig
import java.io.File

object SafeBitmapDecoder {

    private const val TAG = "SafeBitmapDecoder"

    data class DecodeResult(
        val bitmap: Bitmap,
        val sampleSize: Int,
        val wasScaledDown: Boolean,
        val originalWidth: Int,
        val originalHeight: Int,
    )

    fun decode(file: File, config: ImageProcessingConfig): DecodeResult? {
        if (!file.exists()) {
            Log.w(TAG, "File not found: ${file.absolutePath}"); return null
        }
        
        if (file.length() == 0L) {
            Log.e(TAG, "File is empty: ${file.absolutePath}"); return null
        }

        return try {
            decodeInternal(file, config)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM \u2014 retrying with higher sample"); System.gc(); retryWithHigherSample(file, config)
        } catch (e: Exception) {
            Log.e(TAG, "Decode failed: ${e.message}"); null
        }
    }

    private fun decodeInternal(file: File, config: ImageProcessingConfig): DecodeResult? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        val (ow, oh) = bounds.outWidth to bounds.outHeight
        
        if (ow <= 0 || oh <= 0) {
            Log.w(TAG, "Invalid dimensions ${ow}x${oh}. Check if the file is a valid image."); return null
        }

        val sample = calculateSampleSize(ow, oh, config)
        
        val options = BitmapFactory.Options().apply {
            inJustDecodeBounds = false
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }

        val raw = BitmapFactory.decodeFile(file.absolutePath, options) ?: run { 
            Log.e(TAG, "decodeFile returned null for ${file.absolutePath}"); return null 
        }

        val (final, scaled) = postScaleIfNeeded(raw, config)
        return DecodeResult(final, sample, sample > 1 || scaled, ow, oh)
    }

    private fun retryWithHigherSample(file: File, config: ImageProcessingConfig): DecodeResult? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            
            val sample = (calculateSampleSize(bounds.outWidth, bounds.outHeight, config) * 2).coerceIn(2, 32)
            
            val bmp = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply {
                inJustDecodeBounds = false; inSampleSize = sample; inPreferredConfig = Bitmap.Config.RGB_565
            }) ?: return null
            
            val (final, _) = postScaleIfNeeded(bmp, config)
            Log.d(TAG, "Emergency decode OK: ${final.width}x${final.height} sample=$sample")
            DecodeResult(final, sample, true, bounds.outWidth, bounds.outHeight)
        } catch (e: Exception) {
            Log.e(TAG, "Emergency decode failed: ${e.message}"); null
        }
    }

    private fun calculateSampleSize(w: Int, h: Int, config: ImageProcessingConfig): Int {
        var sample = 1
        while (w / sample > config.maxDecodedWidthPx || h / sample > config.maxDecodedHeightPx) {
            sample *= 2
        }
        
        val rt = Runtime.getRuntime()
        val available = rt.maxMemory() - (rt.totalMemory() - rt.freeMemory())
        val budget = (available * config.maxHeapFraction).toLong()
        
        while ((w / sample).toLong() * (h / sample) * 4 > budget && sample < 64) {
            sample *= 2
        }
        
        Log.d(TAG, "Sample size calculated: $sample for ${w}x${h}")
        return sample
    }

    private fun postScaleIfNeeded(bitmap: Bitmap, config: ImageProcessingConfig): Pair<Bitmap, Boolean> {
        val w = bitmap.width; val h = bitmap.height
        if (w <= config.maxDecodedWidthPx && h <= config.maxDecodedHeightPx) return Pair(bitmap, false)
        
        val scale = minOf(config.maxDecodedWidthPx.toFloat() / w, config.maxDecodedHeightPx.toFloat() / h)
        val nw = (w * scale).toInt().coerceAtLeast(1)
        val nh = (h * scale).toInt().coerceAtLeast(1)
        
        return try {
            val scaled = Bitmap.createScaledBitmap(bitmap, nw, nh, true)
            if (scaled !== bitmap) bitmap.recycle()
            Pair(scaled, true)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM during post-scale \u2014 returning original bitmap"); Pair(bitmap, false)
        }
    }
}