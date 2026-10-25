package expo.modules.auctioncamera.compression

import android.graphics.Bitmap
import android.util.Log
import expo.modules.auctioncamera.model.ImageProcessingConfig
import java.io.ByteArrayOutputStream
import java.io.File

object RecursiveCompressor {

    private const val TAG = "RecursiveCompressor"

    fun compress(
        bitmap: Bitmap,
        destFile: File,
        originalSizeBytes: Long,
        config: ImageProcessingConfig,
        wasDimensionReduced: Boolean = false,
    ): CompressionResult {
        destFile.parentFile?.mkdirs()
        var quality = config.initialQuality;
        var iter = 0
        var cur = bitmap;
        var ownsCur = false;
        var dimReduced = wasDimensionReduced

        try {
            while (iter < config.maxIterations) {
                iter++
                val bytes = compress(cur, quality)
                    ?: return CompressionResult.Failure("OOM iter=$iter q=$quality")
                Log.d(
                    TAG,
                    "iter=$iter q=$quality \u2192 ${bytes.size / 1024}KB (${cur.width}x${cur.height})"
                )

                if (bytes.size <= config.targetMaxBytes) {
                    writeBytes(bytes, destFile)
                    return CompressionResult.Success(
                        destFile,
                        originalSizeBytes,
                        destFile.length(),
                        quality,
                        iter,
                        dimReduced
                    )
                }

                if (quality > config.minQuality) {
                    quality =
                        (quality - config.qualityStep).coerceAtLeast(config.minQuality); continue
                }
                if (!config.allowDimensionReduction) {
                    writeBytes(bytes, destFile); return CompressionResult.BelowTarget(
                        destFile,
                        destFile.length(),
                        quality,
                        config.targetMaxBytes
                    )
                }

                val nw = cur.width / 2;
                val nh = cur.height / 2
                if (nw < config.minDimensionPx || nh < config.minDimensionPx) {
                    writeBytes(bytes, destFile); return CompressionResult.BelowTarget(
                        destFile,
                        destFile.length(),
                        quality,
                        config.targetMaxBytes
                    )
                }

                val scaled = try {
                    Bitmap.createScaledBitmap(cur, nw, nh, true)
                } catch (e: OutOfMemoryError) {
                    writeBytes(bytes, destFile); return CompressionResult.BelowTarget(
                        destFile,
                        destFile.length(),
                        quality,
                        config.targetMaxBytes
                    )
                }

                if (ownsCur && cur !== bitmap) cur.recycle()
                cur = scaled; ownsCur = true; dimReduced = true; quality = config.initialQuality
            }

            val last = compress(cur, config.minQuality)
                ?: return CompressionResult.Failure("Max iterations + OOM")
            writeBytes(last, destFile)
            return CompressionResult.BelowTarget(
                destFile,
                destFile.length(),
                config.minQuality,
                config.targetMaxBytes
            )
        } finally {
            if (ownsCur && cur !== bitmap) cur.recycle()
        }
    }

    private fun compress(bitmap: Bitmap, quality: Int): ByteArray? = try {
        ByteArrayOutputStream().also {
            bitmap.compress(
                Bitmap.CompressFormat.JPEG,
                quality.coerceIn(1, 100),
                it
            )
        }.toByteArray()
    } catch (e: OutOfMemoryError) {
        Log.e(TAG, "OOM q=$quality"); System.gc(); null
    } catch (e: Exception) {
        Log.e(TAG, "compress failed: ${e.message}"); null
    }

    private fun writeBytes(bytes: ByteArray, dest: File) {
        try {
            dest.parentFile?.mkdirs(); dest.writeBytes(bytes)
        } catch (e: Exception) {
            Log.e(TAG, "write failed: ${e.message}")
        }
    }
}