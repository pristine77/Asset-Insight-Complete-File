package expo.modules.auctioncamera.utils

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.util.Log
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import expo.modules.auctioncamera.engine.LensManager
import kotlin.math.abs

@OptIn(ExperimentalCamera2Interop::class)
object UltraWideCameraSelector {

    private const val TAG = "LensSelector"

    fun getUltraWideSelector(context: Context) = selectorForLabel(context, "UltraWide")
    fun getWideSelector(context: Context) = selectorForLabel(context, "Wide")
    fun getTelephotoSelector(context: Context) = selectorForLabel(context, "Telephoto")
    fun getSelectorOrDefault(context: Context, label: String) =
        selectorForLabel(context, label) ?: CameraSelector.DEFAULT_BACK_CAMERA

    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun selectorForLabel(context: Context, label: String): CameraSelector? {
        val lenses = LensManager.backLenses(context)
        val target = if (label == "Telephoto") lenses.filter { it.label == label }
            .maxByOrNull { it.focalLengths.minOrNull() ?: 0f }
        else lenses.filter { it.label == label }.minByOrNull { it.focalLengths.minOrNull() ?: 0f }
            ?: return null
        val targetFocal = target?.focalLengths?.minOrNull() ?: return null
        val targetId = target.cameraId
        val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        Log.d(TAG, "Selector '$label' id=$targetId focal=${targetFocal}mm")

        return CameraSelector.Builder().addCameraFilter { list: MutableList<CameraInfo> ->
            list.filter { Camera2CameraInfo.from(it).cameraId == targetId }
                .takeIf { it.isNotEmpty() }
                ?: list.filter { info ->
                    runCatching {
                        val id = Camera2CameraInfo.from(info).cameraId
                        val c = mgr.getCameraCharacteristics(id)
                        c.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK &&
                                abs(
                                    (c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                                        ?.minOrNull() ?: Float.MAX_VALUE) - targetFocal
                                ) <= 0.5f
                    }.getOrDefault(false)
                }.takeIf { it.isNotEmpty() }
                ?: list.filter {
                    runCatching {
                        mgr.getCameraCharacteristics(
                            Camera2CameraInfo.from(
                                it
                            ).cameraId
                        )
                            .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
                    }.getOrDefault(false)
                }
                    .let { back ->
                        if (back.size == 1) back else back.minByOrNull { info ->
                            runCatching {
                                abs(
                                    (mgr.getCameraCharacteristics(Camera2CameraInfo.from(info).cameraId)
                                        .get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                                        ?.minOrNull() ?: Float.MAX_VALUE) - targetFocal
                                )
                            }.getOrDefault(Float.MAX_VALUE)
                        }?.let { listOf(it) } ?: emptyList()
                    }
        }.build()
    }
}