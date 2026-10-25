package expo.modules.auctioncamera.utils

import android.hardware.camera2.CaptureRequest
import android.util.Range
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.ImageCapture
import androidx.camera.core.Preview
import androidx.camera.video.Recorder
import androidx.camera.video.VideoCapture
import expo.modules.auctioncamera.model.ManualConfig

object ManualControls {

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    fun applyToPreview(b: Preview.Builder, c: ManualConfig) =
        b.also { apply(Camera2Interop.Extender(b), c) }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    fun applyToImageCapture(b: ImageCapture.Builder, c: ManualConfig) =
        b.also { apply(Camera2Interop.Extender(b), c) }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    fun applyToVideoCapture(b: VideoCapture.Builder<Recorder>, c: ManualConfig) =
        b.also { apply(Camera2Interop.Extender(b), c) }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun <T> apply(ext: Camera2Interop.Extender<T>, c: ManualConfig) {
        val isManualExposure = c.aeMode == CaptureRequest.CONTROL_AE_MODE_OFF &&
                (c.iso != null || c.shutterSpeedNs != null)

        if (isManualExposure) {
            ext.setCaptureRequestOption(
                CaptureRequest.CONTROL_AE_MODE,
                CaptureRequest.CONTROL_AE_MODE_OFF
            )
            c.iso?.let {
                ext.setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, it)
            }
            c.shutterSpeedNs?.let {
                ext.setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, it)
            }
        } else {
            ext.setCaptureRequestOption(
                CaptureRequest.CONTROL_AE_MODE,
                CaptureRequest.CONTROL_AE_MODE_ON
            )
        }
        ext.setCaptureRequestOption(
            CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
            Range(c.aeFpsMin, c.aeFpsMax)
        )
        ext.setCaptureRequestOption(
            CaptureRequest.CONTROL_AWB_MODE,
            c.whiteBalance.awbMode
        )
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    fun applyToBuilder(builder: CaptureRequestOptions.Builder, c: ManualConfig) {
        val isManualExposure = c.aeMode == CaptureRequest.CONTROL_AE_MODE_OFF &&
                (c.iso != null || c.shutterSpeedNs != null)

        if (isManualExposure) {
            builder.setCaptureRequestOption(
                CaptureRequest.CONTROL_AE_MODE,
                CaptureRequest.CONTROL_AE_MODE_OFF
            )
            c.iso?.let {
                builder.setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, it)
            }
            c.shutterSpeedNs?.let {
                builder.setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, it)
            }
        } else {
            builder.setCaptureRequestOption(
                CaptureRequest.CONTROL_AE_MODE,
                CaptureRequest.CONTROL_AE_MODE_ON
            )
        }

        builder.setCaptureRequestOption(
            CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
            Range(c.aeFpsMin, c.aeFpsMax)
        )
        builder.setCaptureRequestOption(
            CaptureRequest.CONTROL_AWB_MODE,
            c.whiteBalance.awbMode
        )
    }

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    fun applyDirect(camera: Camera, c: ManualConfig) {
        try {
            val c2 = Camera2CameraControl.from(camera.cameraControl)
            val builder = CaptureRequestOptions.Builder()
            applyToBuilder(builder, c)
            c2.captureRequestOptions = builder.build()
        } catch (e: Exception) {
            android.util.Log.w("ManualControls", "applyDirect failed: ${e.message}")
        }
    }
}