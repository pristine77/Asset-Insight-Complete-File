package expo.modules.auctioncamera.extensions

import android.util.Log
import expo.modules.auctioncamera.model.ManualConfig
import expo.modules.auctioncamera.utils.ManualControls

object ExtensionConflictResolver {
    private const val TAG = "ConflictResolver"
    data class ConflictResult(
        val safeConfig: ManualConfig,
        val hadConflict: Boolean,
        val reason: String?,
    )

    fun resolve(
        requested: ManualConfig,
        activeMode: CameraExtensionMode,
    ): ConflictResult {
        if (!activeMode.blocksManualControls) {
            return ConflictResult(requested, false, null)
        }

        val hasManual = requested.iso != null ||
                requested.shutterSpeedNs != null ||
                requested.aeMode == android.hardware.camera2.CaptureRequest.CONTROL_AE_MODE_OFF

        if (!hasManual) {
            return ConflictResult(requested, false, null)
        }

        Log.w(TAG, "${activeMode.label} blocks manual ISO/shutter \u2014 stripping to AUTO")
        val safe = ManualConfig(
            aeFpsMin     = requested.aeFpsMin,
            aeFpsMax     = requested.aeFpsMax,
            whiteBalance = requested.whiteBalance,
        )
        return ConflictResult(
            safeConfig   = safe,
            hadConflict  = true,
            reason       = "${activeMode.label} mode controls exposure automatically. ISO and Shutter Speed have been set to AUTO.",
        )
    }

    fun isProModeLocked(mode: CameraExtensionMode): Boolean = mode.blocksManualControls

    fun proModeLockReason(mode: CameraExtensionMode): String = when (mode) {
        is CameraExtensionMode.Bokeh  -> "Portrait mode controls exposure internally."
        is CameraExtensionMode.Normal -> "Scene mode uses AI-driven exposure."
        else                          -> "Manual controls are not available in this mode."
    }
}