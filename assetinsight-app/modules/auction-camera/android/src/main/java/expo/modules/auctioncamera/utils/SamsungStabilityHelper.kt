package expo.modules.auctioncamera.utils

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.util.Log

object SamsungStabilityHelper {

    private const val TAG = "StabilityHelper"

    val isSamsung get() = android.os.Build.MANUFACTURER.equals("samsung", ignoreCase = true)

    val isSamsungUltra
        get(): Boolean {
            if (!isSamsung) return false
            val m = android.os.Build.MODEL.uppercase()
            return m.contains("S24") || m.contains("S25") ||
                    m.startsWith("SM-S92") || m.startsWith("SM-S93")
        }

    val requiresFullUnbindOnSwitch get() = isSamsung

    val unbindDelayMs
        get() = when {
            isSamsungUltra -> 50L
            isSamsung      -> 16L
            else           -> 0L
        }

    val afThrottleMs
        get() = when {
            isSamsungUltra -> 400L
            isSamsung      -> 250L
            else           -> 200L
        }

    fun logCameraCapabilities(context: Context) {
        val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        Log.d(TAG, "=== Device: ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} ===")
        mgr.cameraIdList.forEach { id ->
            try {
                val c = mgr.getCameraCharacteristics(id)
                Log.d(
                    TAG,
                    "[$id] facing=${c.get(CameraCharacteristics.LENS_FACING)}" +
                            " focal=${c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.toList()}" +
                            " iso=${c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)}" +
                            " fps=${c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.toList()}"
                )
            } catch (e: Exception) {
                Log.w(TAG, "Cannot read [$id]: ${e.message}")
            }
        }
    }
}
