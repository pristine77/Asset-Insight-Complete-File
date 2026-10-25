package expo.modules.auctioncamera.controls

import android.util.Range
import android.util.Log
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import expo.modules.auctioncamera.utils.Camera2Helper

@OptIn(ExperimentalCamera2Interop::class)
object AeFpsController {

    private const val TAG = "AeFpsController"

    enum class FpsPreset(val min: Int, val max: Int, val label: String) {
        AUTO(15, 30, "Auto"), LOCKED_24(24, 24, "24fps"), LOCKED_30(30, 30, "30fps"),
        LOCKED_60(60, 60, "60fps"), SMOOTH(30, 60, "30-60");

        fun toRange() = Range(min, max)
    }

    private var currentPreset = FpsPreset.AUTO
    private var currentCustomRange: Range<Int>? = null
    private var supportedRanges: List<Range<Int>> = emptyList()

    fun loadSupportedRanges(camera: Camera, context: android.content.Context): List<Range<Int>> =
        Camera2Helper.getFpsRanges(camera, context)
            .also {
                supportedRanges = it;
                Log.d(TAG, "FPS: $it")
            }

    fun isRangeSupported(min: Int, max: Int) =
        supportedRanges.isEmpty() || supportedRanges.any { it.lower <= min && it.upper >= max }


    fun getSupportedPresets() = FpsPreset.entries.filter { isRangeSupported(it.min, it.max) }
    fun getCurrentRange() = currentCustomRange ?: currentPreset.toRange()

    fun getBestMatch(reqMin: Int, reqMax: Int): Range<Int> {
        if (supportedRanges.isEmpty()) return Range(reqMin, reqMax)
        return supportedRanges.firstOrNull { it.lower == reqMin && it.upper == reqMax }
            ?: supportedRanges.filter { it.lower <= reqMin && it.upper >= reqMax }
                .minByOrNull { it.upper - it.lower }
            ?: supportedRanges.minByOrNull { Math.abs(it.upper - reqMax) }
            ?: Range(15, 30)
    }

    fun setCustomRange(min: Int, max: Int) {
        currentCustomRange = getBestMatch(min, max)
    }

    fun setPreset(preset: FpsPreset) {
        currentPreset = preset; currentCustomRange = null
    }

    fun reset() {
        currentPreset = FpsPreset.AUTO; currentCustomRange = null
    }

    fun logCapabilities() {
        Log.d(
            TAG,
            "Ranges=$supportedRanges | Presets=${getSupportedPresets().map { it.label }} | Current=${getCurrentRange()}"
        )
    }
}