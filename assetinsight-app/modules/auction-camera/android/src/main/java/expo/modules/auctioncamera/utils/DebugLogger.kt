package expo.modules.auctioncamera.utils

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.util.Log
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import expo.modules.auctioncamera.engine.LensManager

@OptIn(ExperimentalCamera2Interop::class)
object DebugLogger {

    private const val TAG = "CAM_DEBUG"


    fun logDeviceCapabilities(
        context: Context,
        camera: Camera,
        trueMinZoom: Float
    ) {
        try {
            val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

            Log.d(TAG, "========================================")
            Log.d(TAG, "Device     : ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
            Log.d(TAG, "Android API: ${android.os.Build.VERSION.SDK_INT}")
            Log.d(TAG, "Camera IDs : ${mgr.cameraIdList.toList()}")

            for (id in mgr.cameraIdList) {
                logCameraId(id, mgr)
            }

            Log.d(TAG, "--- LensManager ---")
            LensManager.backLenses(context).forEach {
                Log.d(TAG, "  ${it.label} focal=${it.focalLengths.toList()} id=${it.cameraId}")
            }

            logActiveCameraX(camera, trueMinZoom)

            Log.d(TAG, "========================================")

        } catch (e: Exception) {
            Log.e(TAG, "debugLog failed: ${e.message}")
        }
    }

    private fun logCameraId(id: String, mgr: CameraManager) {
        try {
            val chars = mgr.getCameraCharacteristics(id)

            val facing    = chars.get(CameraCharacteristics.LENS_FACING)
            val facingStr = when (facing) {
                CameraCharacteristics.LENS_FACING_BACK  -> "BACK"
                CameraCharacteristics.LENS_FACING_FRONT -> "FRONT"
                else                                    -> "OTHER($facing)"
            }

            val focal = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)

            val mp = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(ImageFormat.JPEG)
                ?.maxByOrNull { it.width * it.height }
                ?.let { (it.width.toLong() * it.height) / 1_000_000f }

            val hwLevel = chars.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)
            val hwStr   = hwLevelString(hwLevel)

            val digitalZoom = chars.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM)

            val zoomRange = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R)
                chars.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) else null

            val capabilities = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
            val isLogical    = capabilities?.contains(
                CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA
            ) ?: false

            val physicalIds: Set<String>? =
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                    runCatching {
                        mgr.getCameraCharacteristics(id).physicalCameraIds.ifEmpty { null }
                    }.getOrNull()
                } else null

            val cropRegion  = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
            val isoRange    = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
            val apertures   = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES)

            Log.d(TAG, "--- Camera ID=$id ---")
            Log.d(TAG, "  facing        = $facingStr")
            Log.d(TAG, "  focal lengths = ${focal?.toList()}")
            Log.d(TAG, "  apertures     = ${apertures?.toList()}")
            Log.d(TAG, "  megapixels    = $mp MP")
            Log.d(TAG, "  hwLevel       = $hwStr")
            Log.d(TAG, "  digitalZoom   = $digitalZoom")
            Log.d(TAG, "  zoomRange     = $zoomRange")
            Log.d(TAG, "  isLogical     = $isLogical")
            Log.d(TAG, "  physicalIds   = $physicalIds")
            Log.d(TAG, "  cropRegion    = $cropRegion")
            Log.d(TAG, "  isoRange      = $isoRange")

            if (isLogical && physicalIds != null &&
                android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                physicalIds.forEach { physId ->
                    logPhysicalCamera(physId, mgr)
                }
            }

        } catch (e: Exception) {
            Log.w(TAG, "Camera ID=$id failed: ${e.message}")
        }
    }

    private fun logPhysicalCamera(physId: String, mgr: CameraManager) {
        try {
            val physChars = mgr.getCameraCharacteristics(physId)

            val physFocal = physChars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)

            val physMp = physChars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(ImageFormat.JPEG)
                ?.maxByOrNull { it.width * it.height }
                ?.let { (it.width.toLong() * it.height) / 1_000_000f }

            val physZoom = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R)
                physChars.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) else null

            val physAperture = physChars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES)
            val physHwLevel  = physChars.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)

            Log.d(TAG, "    [physical $physId]")
            Log.d(TAG, "      focal    = ${physFocal?.toList()}")
            Log.d(TAG, "      aperture = ${physAperture?.toList()}")
            Log.d(TAG, "      mp       = $physMp")
            Log.d(TAG, "      hwLevel  = ${hwLevelString(physHwLevel)}")
            Log.d(TAG, "      zoomRange= $physZoom")

        } catch (e: Exception) {
            Log.d(TAG, "    [physical $physId] read failed: ${e.message}")
        }
    }

    private fun logActiveCameraX(camera: Camera, trueMinZoom: Float) {
        try {
            val zs           = camera.cameraInfo.zoomState.value
            val activeCameraId = runCatching {
                Camera2CameraInfo.from(camera.cameraInfo).cameraId
            }.getOrDefault("unknown")

            Log.d(TAG, "--- CameraX active ---")
            Log.d(TAG, "  cameraId    = $activeCameraId")
            Log.d(TAG, "  minZoom     = ${zs?.minZoomRatio}")
            Log.d(TAG, "  maxZoom     = ${zs?.maxZoomRatio}")
            Log.d(TAG, "  currentZoom = ${zs?.zoomRatio}")
            Log.d(TAG, "  trueMinZoom = $trueMinZoom")
        } catch (e: Exception) {
            Log.w(TAG, "logActiveCameraX failed: ${e.message}")
        }
    }

    private fun hwLevelString(level: Int?): String = when (level) {
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY  -> "LEGACY"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL    -> "FULL"
        CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3       -> "LEVEL_3"
        else -> "EXTERNAL($level)"
    }
}