package expo.modules.auctioncamera.engine

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.util.Log
import expo.modules.auctioncamera.model.LensInfo
import expo.modules.auctioncamera.model.Raw

object LensManager {

    private const val TAG = "LensManager"
    private var cachedBack: List<LensInfo>? = null
    private var cachedAll:  List<LensInfo>? = null

    fun clearCache() { cachedBack = null; cachedAll = null }

    fun backLenses(context: Context): List<LensInfo> {
        cachedBack?.let { return it }
        return enumerateLenses(context).filter { it.lensFacing == CameraCharacteristics.LENS_FACING_BACK }.also { cachedBack = it }
    }

    fun enumerateLenses(context: Context): List<LensInfo> {
        cachedAll?.let { return it }
        val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager


        val raws = mgr.cameraIdList.mapNotNull { id ->
            try {
                val c   = mgr.getCameraCharacteristics(id)
                val fac = c.get(CameraCharacteristics.LENS_FACING) ?: return@mapNotNull null
                val foc = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS) ?: return@mapNotNull null
                val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                val jpg = map?.getOutputSizes(ImageFormat.JPEG)?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                val mp  = jpg.maxByOrNull { it.width * it.height }!!.let { (it.width.toLong() * it.height) / 1_000_000f }
                if (mp < 1f) return@mapNotNull null
                Raw(id, fac, foc, mp, map.getOutputSizes(ImageFormat.YUV_420_888)?.isNotEmpty() == true, map)
            } catch (e: Exception) { Log.w(TAG, "Skip $id: ${e.message}"); null }
        }

        val mainFocal = raws.filter { it.facing == CameraCharacteristics.LENS_FACING_BACK }
            .maxByOrNull { it.mp }?.focal?.minOrNull() ?: 6f

        val result = raws.mapNotNull { raw ->
            val label = when (raw.facing) {
                CameraCharacteristics.LENS_FACING_FRONT -> "Front"
                CameraCharacteristics.LENS_FACING_BACK  -> classifyBack(raw.id, raw.focal, raw.mp, raw.hasYuv, raw.map, mainFocal, mgr)
                else -> "External"
            }
            if (label in setOf("Depth", "Macro", "Skip")) { Log.d(TAG, "Skipping ${raw.id} \u2014 $label"); return@mapNotNull null }
            LensInfo(raw.id, raw.facing, raw.focal, label).also { Log.d(TAG, "${raw.id} | $label | f=${raw.focal.toList()} | ${raw.mp}MP") }
        }.sortedBy { it.focalLengths.minOrNull() ?: 0f }

        return result.also { cachedAll = it }
    }

    private fun classifyBack(id: String, focal: FloatArray, mp: Float, hasYuv: Boolean, map: android.hardware.camera2.params.StreamConfigurationMap?, mainFocal: Float, mgr: CameraManager): String {
        val f = focal.minOrNull() ?: return "Skip"
        if (mp < 1.5f && !hasYuv) return "Depth"
        if (mp < 5f) {
            val jpegCount = map?.getOutputSizes(ImageFormat.JPEG)?.size ?: 0
            val ratio = f / mainFocal
            if (ratio in 0.8f..1.8f && mp < 3f && jpegCount <= 4) return "Macro"
            if (mp < 2f && !hasYuv) return "Depth"
        }

        val backCount = mgr.cameraIdList.count { cid ->
            try { mgr.getCameraCharacteristics(cid).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK } catch (e: Exception) { false }
        }
        if (backCount <= 1) return "Wide"

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val zr = mgr.getCameraCharacteristics(id).get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
                if (zr != null) return when {
                    zr.lower < 0.85f -> "UltraWide"
                    zr.upper > 3f    -> "Telephoto"
                    else             -> classifyByFocalRatio(f, mainFocal, mp)
                }
            } catch (e: Exception) { Log.w(TAG, "ZoomRange failed $id: ${e.message}") }
        }
        return classifyByFocalRatio(f, mainFocal, mp)
    }

    private fun classifyByFocalRatio(f: Float, mainFocal: Float, mp: Float): String {
        val r = f / mainFocal
        return when {
            r < 0.55f               -> "UltraWide"
            r < 0.6f  && mp < 8f   -> "UltraWide"
            r < 0.80f && mp >= 8f  -> "Wide"
            r < 1.20f               -> "Wide"
            r >= 1.20f && mp >= 5f -> "Telephoto"
            else                    -> "Wide"
        }
    }
}