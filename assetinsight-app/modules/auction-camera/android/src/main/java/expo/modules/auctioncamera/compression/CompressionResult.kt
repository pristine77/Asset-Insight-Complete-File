package expo.modules.auctioncamera.compression

import java.io.File

sealed class CompressionResult {
    data class Success(
        val file: File,
        val originalSizeBytes: Long,
        val finalSizeBytes: Long,
        val finalQuality: Int,
        val iterations: Int,
        val wasDimensionReduced: Boolean,
    ) : CompressionResult() {
        val compressionRatio get() = if (originalSizeBytes > 0) finalSizeBytes.toFloat() / originalSizeBytes else 1f
        val savedPercent get() = ((1f - compressionRatio) * 100).toInt()
    }

    data class BelowTarget(
        val file: File,
        val finalSizeBytes: Long,
        val finalQuality: Int,
        val targetBytes: Int,
    ) : CompressionResult() {
        val overageKb get() = ((finalSizeBytes - targetBytes) / 1024).toInt().coerceAtLeast(0)
    }
    data class Failure(val reason: String, val exception: Exception? = null) : CompressionResult()
}