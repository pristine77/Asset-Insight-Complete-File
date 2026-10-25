package expo.modules.auctioncamera.viewextensions

import android.util.Range
import androidx.camera.core.CameraInfo
import androidx.camera.core.DynamicRange
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.VideoCapture

/** One recording profile for every listing-camera lens and rebind path. */
object ListingVideoProfile {
    const val FRAMES_PER_SECOND = 30
    const val BIT_RATE = 5_000_000
    const val UNSUPPORTED_MESSAGE =
        "720p at 30 fps is unavailable on this camera. Try another supported camera or device."
    val frameRate: Range<Int> get() = Range(FRAMES_PER_SECOND, FRAMES_PER_SECOND)

    fun supports(qualities: List<Quality>, frameRates: Set<Range<Int>>): Boolean =
        Quality.HD in qualities && frameRate in frameRates

    fun requireSupported(cameraInfo: CameraInfo) {
        val qualities = Recorder.getVideoCapabilities(cameraInfo)
            .getSupportedQualities(DynamicRange.SDR)
        check(supports(qualities, cameraInfo.supportedFrameRateRanges)) { UNSUPPORTED_MESSAGE }
    }

    fun buildCapture(rotation: Int): VideoCapture<Recorder> {
        val recorder = Recorder.Builder()
            // No fallback: unsupported devices must not silently record 1080p/4K or 480p.
            .setQualitySelector(QualitySelector.from(Quality.HD))
            .setTargetVideoEncodingBitRate(BIT_RATE)
            .build()
        return VideoCapture.Builder(recorder)
            .setDynamicRange(DynamicRange.SDR)
            .setTargetRotation(rotation)
            .setTargetFrameRate(frameRate)
            .build()
    }

    fun is720p(width: Int, height: Int): Boolean =
        minOf(width, height) == 720 && maxOf(width, height) == 1280

    fun requireBoundProfile(capture: VideoCapture<Recorder>) {
        val crop = capture.resolutionInfo?.cropRect
        check(capture.selectedQuality == Quality.HD && crop != null &&
            is720p(crop.width(), crop.height())) { UNSUPPORTED_MESSAGE }
    }
}
