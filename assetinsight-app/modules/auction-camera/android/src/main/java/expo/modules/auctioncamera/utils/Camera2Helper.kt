package expo.modules.auctioncamera.utils

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera

@OptIn(ExperimentalCamera2Interop::class)
object Camera2Helper {

    fun getCameraManager(context: Context) =
        context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    fun getCameraId(camera: Camera) = Camera2CameraInfo.from(camera.cameraInfo).cameraId

    private fun chars(camera: Camera, context: Context) =
        getCameraManager(context).getCameraCharacteristics(getCameraId(camera))

    private fun charsById(id: String, context: Context) =
        getCameraManager(context).getCameraCharacteristics(id)

    private fun <T> safe(camera: Camera, context: Context, key: CameraCharacteristics.Key<T>) =
        runCatching { chars(camera, context).get(key) }.getOrNull()

    private fun <T> safeById(id: String, context: Context, key: CameraCharacteristics.Key<T>) =
        runCatching { charsById(id, context).get(key) }.getOrNull()

    fun getIsoRange(camera: Camera, context: Context) =
        safe(camera, context, CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)

    fun getExposureTimeRange(camera: Camera, context: Context) =
        safe(camera, context, CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)

    fun getFpsRanges(camera: Camera, context: Context) = safe(
        camera,
        context,
        CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES
    )?.toList() ?: emptyList()


    fun getAvailableCapabilities(camera: Camera, context: Context) =
        safe(camera, context, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)

    fun hasCapability(camera: Camera, context: Context, cap: Int) =
        getAvailableCapabilities(camera, context)?.contains(cap) == true


    fun supportsManualSensor(camera: Camera, context: Context): Boolean {
        if (hasCapability(
                camera, context,
                CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR
            )
        ) return true
        val hasRanges = getIsoRange(camera, context) != null &&
                getExposureTimeRange(camera, context) != null
        if (!hasRanges) return false
        val hwLevel = safe(camera, context, CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)
        if (hwLevel != null &&
            hwLevel != CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY
        ) return true
        return true
    }


    fun getAllBackCameraIds(context: Context) =
        getCameraManager(context).cameraIdList.filter { id ->
            runCatching {
                getCameraManager(context).getCameraCharacteristics(id)
                    .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            }.getOrDefault(false)
        }
}