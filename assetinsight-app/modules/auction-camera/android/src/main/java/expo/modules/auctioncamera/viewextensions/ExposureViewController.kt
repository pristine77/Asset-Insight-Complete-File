package expo.modules.auctioncamera.viewextensions

import androidx.camera.core.Camera
import androidx.camera.core.ExposureState
import kotlin.math.roundToInt

object ExposureViewController {
    fun setEV(camera: Camera, ev: Float) {
        val state = camera.cameraInfo.exposureState
        if (!state.isExposureCompensationSupported) return
        camera.cameraControl.setExposureCompensationIndex(evToIndex(ev, state))
    }

    fun getCurrentEV(camera: Camera): Float {
        val state = camera.cameraInfo.exposureState
        return state.exposureCompensationIndex * state.exposureCompensationStep.toFloat()
    }

    fun getEVRange(camera: Camera): Pair<Float, Float> {
        val state = camera.cameraInfo.exposureState
        if (!state.isExposureCompensationSupported) return Pair(0f, 0f)
        val step = state.exposureCompensationStep.toFloat()
        return Pair(state.exposureCompensationRange.lower * step, state.exposureCompensationRange.upper * step)
    }

    fun isSupported(camera: Camera): Boolean = camera.cameraInfo.exposureState.isExposureCompensationSupported

    private fun evToIndex(ev: Float, state: ExposureState): Int {
        val step = state.exposureCompensationStep.toFloat()
        return (ev / step).roundToInt().coerceIn(state.exposureCompensationRange.lower, state.exposureCompensationRange.upper)
    }
}