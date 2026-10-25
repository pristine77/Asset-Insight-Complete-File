package expo.modules.auctioncamera.model

data class ImageProcessingConfig(
    val targetMaxBytes: Int         = 400 * 1024,
    val initialQuality: Int         = 90,
    val minQuality: Int             = 20,
    val qualityStep: Int            = 10,
    val maxIterations: Int          = 30,
    val allowDimensionReduction: Boolean = true,
    val minDimensionPx: Int         = 64,
    val maxDecodedWidthPx: Int      = 4096,
    val maxDecodedHeightPx: Int     = 4096,
    val maxHeapFraction: Float      = 0.25f,
    val preserveGps: Boolean        = true,
    val preserveTimestamp: Boolean  = true,
    val preserveDeviceInfo: Boolean = true,
    val preserveCameraSettings: Boolean = true,
    val preserveOrientation: Boolean = true,
    val outputFolder: String        = "DCIM/camera",
    val outputMimeType: String      = "image/jpeg",
    val saveToGallery: Boolean = false
) {
    companion object {
        val DEFAULT = ImageProcessingConfig(saveToGallery = false)
        val HIGH_QUALITY = ImageProcessingConfig(targetMaxBytes = 1024 * 1024, initialQuality = 95, minQuality = 70, qualityStep = 5)
        val LOW_BANDWIDTH = ImageProcessingConfig(targetMaxBytes = 200 * 1024, initialQuality = 80, minQuality = 15, qualityStep = 15)
    }
}