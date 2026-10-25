package expo.modules.auctioncamera.model

import android.hardware.camera2.CaptureRequest
import android.util.Range
import expo.modules.auctioncamera.WhiteBalance


data class LensInfo(
    val cameraId: String,
    val lensFacing: Int,
    val focalLengths: FloatArray,
    val label: String,
)

data class DeviceLimits(
    val minIso: Int,
    val maxIso: Int,
    val minShutterNs: Long,
    val maxShutterNs: Long,
    val supportsManualSensor: Boolean,
)

data class Raw(
    val id: String,
    val facing: Int,
    val focal: FloatArray,
    val mp: Float,
    val hasYuv: Boolean,
    val map: android.hardware.camera2.params.StreamConfigurationMap?,
)

data class ManualConfig(
    val aeMode: Int                 = CaptureRequest.CONTROL_AE_MODE_ON,
    val iso: Int?                   = null,
    val shutterSpeedNs: Long?       = null,
    val aeFpsMin: Int               = 15,
    val aeFpsMax: Int               = 30,
    val whiteBalance: WhiteBalance = WhiteBalance.AUTO
)
