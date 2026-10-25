package expo.modules.auctioncamera.controls

import androidx.camera.core.Camera
import androidx.camera.core.ExposureState
import kotlin.math.roundToInt

object ExposureController {

    fun setEV(camera: Camera, ev: Float) {
        val state = camera.cameraInfo.exposureState
        if (!state.isExposureCompensationSupported) return
        camera.cameraControl.setExposureCompensationIndex(evToIndex(ev, state))
    }

    fun stepEV(camera: Camera, steps: Int) {
        val state = camera.cameraInfo.exposureState
        if (!state.isExposureCompensationSupported) return
        val range   = state.exposureCompensationRange
        val current = state.exposureCompensationIndex
        camera.cameraControl.setExposureCompensationIndex(
            (current + steps).coerceIn(range.lower, range.upper)
        )
    }

    fun getCurrentEV(camera: Camera): Float {
        val state = camera.cameraInfo.exposureState
        return state.exposureCompensationIndex * state.exposureCompensationStep.toFloat()
    }

    fun getEVRange(camera: Camera): Pair<Float, Float> {
        val state = camera.cameraInfo.exposureState
        if (!state.isExposureCompensationSupported) return Pair(0f, 0f)
        val step = state.exposureCompensationStep.toFloat()
        return Pair(
            state.exposureCompensationRange.lower * step,
            state.exposureCompensationRange.upper * step
        )
    }

    fun isSupported(camera: Camera): Boolean =
        camera.cameraInfo.exposureState.isExposureCompensationSupported

    private fun evToIndex(ev: Float, state: ExposureState): Int {
        val step  = state.exposureCompensationStep.toFloat()
        val range = state.exposureCompensationRange
        return (ev / step).roundToInt().coerceIn(range.lower, range.upper)
    }
}