package expo.modules.auctioncamera.viewextensions

import android.hardware.camera2.CaptureRequest
import expo.modules.auctioncamera.model.ManualConfig

object ExtensionViewConflictResolver {

    data class ConflictResult(
        val safeConfig: ManualConfig,
        val hadConflict: Boolean,
        val reason: String?,
    )

    fun resolve(requested: ManualConfig, activeMode: CameraViewExtensionMode): ConflictResult {
        if (!activeMode.blocksManualControls) return ConflictResult(requested, false, null)

        val hasManual = requested.iso != null ||
                requested.shutterSpeedNs != null ||
                requested.aeMode == CaptureRequest.CONTROL_AE_MODE_OFF

        if (!hasManual) return ConflictResult(requested, false, null)

        val safe = ManualConfig(
            aeMode = CaptureRequest.CONTROL_AE_MODE_ON,
            iso = null,
            shutterSpeedNs = null,
            aeFpsMin = requested.aeFpsMin,
            aeFpsMax = requested.aeFpsMax,
            whiteBalance = requested.whiteBalance,
        )
        return ConflictResult(
            safeConfig = safe,
            hadConflict = true,
            reason = "${activeMode.label} mode controls exposure automatically. " +
                    "ISO and Shutter Speed set to AUTO.",
        )
    }

    fun isProModeLocked(mode: CameraViewExtensionMode): Boolean = mode.blocksManualControls

    fun proModeLockReason(mode: CameraViewExtensionMode): String = when (mode) {
        is CameraViewExtensionMode.Bokeh ->
            "Portrait mode controls exposure internally."
        else ->
            "Manual controls not available in this mode."
    }
}