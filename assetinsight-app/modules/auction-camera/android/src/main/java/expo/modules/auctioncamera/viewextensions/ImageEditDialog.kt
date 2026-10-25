package expo.modules.auctioncamera.viewextensions

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.SeekBar
import android.widget.Toast
import androidx.core.content.ContextCompat
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.databinding.ItemLayoutColorBinding
import com.google.android.material.bottomsheet.BottomSheetDialogFragment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File


class ImageEditDialog(
    private val imageUri: Uri,
    private val onSaved: (Uri) -> Unit,
) : BottomSheetDialogFragment() {

    private var _binding: ItemLayoutColorBinding? = null
    private val binding get() = _binding!!
    private val scope = CoroutineScope(Dispatchers.Main + Job())

    private var contrast  = 0
    private var color     = 0
    private var sharpness = 0
    private var activePreset: String? = null

    private var fullBitmap:  Bitmap? = null
    private var thumbBitmap: Bitmap? = null

    private val AMBER         get() = ContextCompat.getColor(requireContext(), R.color.orange)
    private val MAX_FILE_BYTES = 600 * 1024L
    private var previewJob: Job? = null

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _binding = ItemLayoutColorBinding.inflate(i, c, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        loadBitmaps()
        setupSliders()
        setupPresets()
        setupButtons()
        syncSlidersToValues()
        updateLabels()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        scope.cancel()
        _binding = null
    }

    private fun loadBitmaps() {
        scope.launch {
            val ctx = requireContext()
            val (full, thumb) = withContext(Dispatchers.IO) {
                try {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    openStream(ctx, imageUri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                    val w = bounds.outWidth; val h = bounds.outHeight

                    val fullOpts = BitmapFactory.Options()
                    val fullBmp = openStream(ctx, imageUri)?.use {
                        BitmapFactory.decodeStream(it, null, fullOpts)
                    }
                    val thumbOpts = BitmapFactory.Options().apply {
                        inSampleSize = calcSample(w, h, 900)
                    }
                    val thumbBmp = openStream(ctx, imageUri)?.use {
                        BitmapFactory.decodeStream(it, null, thumbOpts)
                    }
                    Pair(fullBmp, thumbBmp)
                } catch (e: Exception) { Pair(null, null) }
            }
            fullBitmap  = full
            thumbBitmap = thumb
            thumbBitmap?.let { binding.ivPreview.setImageBitmap(it) }
        }
    }

    private fun openStream(ctx: android.content.Context, uri: Uri) = try {
        when (uri.scheme) {
            "file"    -> java.io.File(uri.path!!).inputStream()
            "content" -> ctx.contentResolver.openInputStream(uri)
            else      -> null
        }
    } catch (_: Exception) { null }

    private fun calcSample(w: Int, h: Int, target: Int): Int {
        var s = 1
        if (w > target || h > target)
            while ((w / s / 2) >= target && (h / s / 2) >= target) s *= 2
        return s
    }

    private fun setupSliders() {
        binding.seekContrast.max  = 200
        binding.seekColor.max     = 200
        binding.seekSharpness.max = 200

        fun wire(seek: SeekBar, assign: (Int) -> Unit) {
            seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar, p: Int, fromUser: Boolean) {
                    if (!fromUser) return
                    assign(p - 100)
                    activePreset = null
                    syncPresetHighlight()
                    updateLabels()
                    schedulePreview()
                }
                override fun onStartTrackingTouch(sb: SeekBar) {}
                override fun onStopTrackingTouch(sb: SeekBar) {}
            })
        }
        wire(binding.seekContrast)  { contrast  = it }
        wire(binding.seekColor)     { color     = it }
        wire(binding.seekSharpness) { sharpness = it }
    }

    private fun syncSlidersToValues() {
        binding.seekContrast.progress  = contrast  + 100
        binding.seekColor.progress     = color     + 100
        binding.seekSharpness.progress = sharpness + 100
    }

    private fun updateLabels() {
        binding.labelContrast.text  = "${fmtVal(contrast)}"
        binding.labelColor.text     = "${fmtVal(color)}"
        binding.labelSharpness.text = "${fmtVal(sharpness)}"
    }

    private fun fmtVal(v: Int) = if (v >= 0) "+$v" else "$v"

    private fun setupPresets() {
        binding.presetLow.setOnClickListener {
            applyPreset("LOW", contrast = 20, color = 25, sharpness = 20)
        }
        binding.presetModerate.setOnClickListener {
            applyPreset("MODERATE", contrast = 45, color = 55, sharpness = 45)
        }
        binding.presetHeavy.setOnClickListener {
            applyPreset("HEAVY", contrast = 75, color = 90, sharpness = 70)
        }
    }

    private fun applyPreset(key: String, contrast: Int, color: Int, sharpness: Int) {
        activePreset      = if (activePreset == key) null else key
        val active        = activePreset != null
        this.contrast     = if (active) contrast  else 0
        this.color        = if (active) color     else 0
        this.sharpness    = if (active) sharpness else 0
        syncSlidersToValues()
        syncPresetHighlight()
        updateLabels()
        schedulePreview()
    }

    private fun syncPresetHighlight() {
        mapOf("LOW" to binding.presetLow, "MODERATE" to binding.presetModerate, "HEAVY" to binding.presetHeavy)
            .forEach { (key, chip) ->
                val on = key == activePreset
                chip.setTextColor(if (on) AMBER else requireContext().getColor(android.R.color.white))
                chip.setBackgroundResource(if (on) R.drawable.bg_click_solid_color else R.drawable.bg_zoom_pill)
            }
    }

    private fun schedulePreview() {
        previewJob?.cancel()
        previewJob = scope.launch {
            val src = thumbBitmap ?: return@launch
            val c = contrast; val col = color; val sh = sharpness
            val result = withContext(Dispatchers.Default) {
                applyEffects(src.copy(src.config ?: Bitmap.Config.ARGB_8888, true), c, col, sh)
            }
            _binding?.ivPreview?.setImageBitmap(result)
        }
    }

    private fun setupButtons() {
        binding.btnReset.setOnClickListener {
            contrast = 0; color = 0; sharpness = 0
            activePreset = null
            syncSlidersToValues()
            syncPresetHighlight()
            updateLabels()
            thumbBitmap?.let { binding.ivPreview.setImageBitmap(it) }
        }
        binding.btnApply.setOnClickListener { saveProcessedImage() }
    }

    private fun saveProcessedImage() {
        val full     = fullBitmap ?: run { Toast.makeText(requireContext(), "Image not loaded", Toast.LENGTH_SHORT).show(); return }
        val filePath = imageUri.path ?: run { Toast.makeText(requireContext(), "Cannot save: unsupported URI", Toast.LENGTH_SHORT).show(); return }

        binding.btnApply.isEnabled = false
        binding.btnApply.alpha     = 0.5f
        binding.progressSave.visibility = View.VISIBLE

        val c = contrast; val col = color; val sh = sharpness

        scope.launch {
            val savedUri = withContext(Dispatchers.IO) {
                try {
                    val processed    = applyEffects(full.copy(full.config ?: Bitmap.Config.ARGB_8888, false), c, col, sh)
                    val alreadyStamped = expo.modules.auctioncamera.utils.PhotoWatermarkReceipt.has(File(filePath).readBytes())
                    val originalExif = androidx.exifinterface.media.ExifInterface(filePath)
                    val outputFile   = File(filePath)
                    var quality      = 90
                    do {
                        outputFile.outputStream().buffered().use { out ->
                            processed.compress(Bitmap.CompressFormat.JPEG, quality, out)
                        }
                        quality -= 5
                    } while (outputFile.length() > MAX_FILE_BYTES && quality >= 20)
                    processed.recycle()

                    runCatching {
                        val newExif = androidx.exifinterface.media.ExifInterface(filePath)
                        copyExif(originalExif, newExif)
                        newExif.setAttribute(
                            androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
                            androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL.toString()
                        )
                        newExif.saveAttributes()
                    }
                    if (alreadyStamped) {
                        outputFile.writeBytes(expo.modules.auctioncamera.utils.PhotoWatermarkReceipt.add(outputFile.readBytes()))
                    }
                    imageUri
                } catch (e: Exception) {
                    android.util.Log.e("ImageEditDialog", "Save failed: ${e.message}"); null
                }
            }

            _binding?.progressSave?.visibility = View.GONE
            _binding?.btnApply?.isEnabled      = true
            _binding?.btnApply?.alpha          = 1f

            if (savedUri != null) {
                Toast.makeText(requireContext(), "Saved!", Toast.LENGTH_SHORT).show()
                onSaved(savedUri); dismiss()
            } else {
                Toast.makeText(requireContext(), "Save failed", Toast.LENGTH_SHORT).show()
            }
        }
    }

    companion object {
        fun applyEffects(src: Bitmap, contrast: Int, color: Int, sharpness: Int): Bitmap {
            val withCC = applyColorMatrix(src, contrast, color)
            if (src !== withCC) src.recycle()

            return if (sharpness != 0) {
                val result = unsharpMask(withCC, sharpness)
                withCC.recycle()
                result
            } else withCC
        }

        private fun applyColorMatrix(src: Bitmap, contrast: Int, color: Int): Bitmap {
            val cs = 1f + (contrast / 100f)
            val ct = 128f * (1f - cs)

            val contrastMatrix = ColorMatrix(floatArrayOf(
                cs, 0f, 0f, 0f, ct,
                0f, cs, 0f, 0f, ct,
                0f, 0f, cs, 0f, ct,
                0f, 0f, 0f, 1f, 0f,
            ))

            val sat = 1f + (color / 100f) * 1.8f
            val satMatrix = ColorMatrix().apply { setSaturation(sat.coerceAtLeast(0f)) }
            satMatrix.preConcat(contrastMatrix)

            val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint  = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                colorFilter = ColorMatrixColorFilter(satMatrix)
            }
            canvas.drawBitmap(src, 0f, 0f, paint)
            return out
        }
        private fun unsharpMask(src: Bitmap, sharpness: Int): Bitmap {
            val w = src.width
            val h = src.height
            val blurredBitmap = src.copy(Bitmap.Config.ARGB_8888, true)
            applyBoxBlurToBitmap(blurredBitmap, 2)
            val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val rowPixels = IntArray(w)
            val rowBlurred = IntArray(w)
            val strength = sharpness / 100f
            for (y in 0 until h) {
                src.getPixels(rowPixels, 0, w, 0, y, w, 1)
                blurredBitmap.getPixels(rowBlurred, 0, w, 0, y, w, 1)
                for (x in 0 until w) {
                    val o = rowPixels[x]; val bl = rowBlurred[x]
                    val oR = (o shr 16) and 0xFF; val oG = (o shr 8) and 0xFF; val oB = o and 0xFF
                    val bR = (bl shr 16) and 0xFF; val bG = (bl shr 8) and 0xFF; val bB = bl and 0xFF
                    val nR = (oR + (strength * (oR - bR)).toInt()).coerceIn(0, 255)
                    val nG = (oG + (strength * (oG - bG)).toInt()).coerceIn(0, 255)
                    val nB = (oB + (strength * (oB - bB)).toInt()).coerceIn(0, 255)
                    rowPixels[x] = (0xFF shl 24) or (nR shl 16) or (nG shl 8) or nB
                }
                out.setPixels(rowPixels, 0, w, 0, y, w, 1)
            }
            blurredBitmap.recycle()
            return out
        }

        private fun applyBoxBlurToBitmap(bitmap: Bitmap, radius: Int) {
            val w = bitmap.width; val h = bitmap.height; val pixels = IntArray(w * h)
            bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
            val temp = IntArray(w * h)
            for (y in 0 until h) {
                for (x in 0 until w) {
                    var r = 0; var g = 0; var b = 0; var count = 0
                    for (dx in -radius..radius) {
                        val nx = (x + dx).coerceIn(0, w - 1); val p = pixels[y * w + nx]
                        r += (p shr 16) and 0xFF; g += (p shr 8) and 0xFF; b += p and 0xFF; count++
                    }
                    temp[y * w + x] = (0xFF shl 24) or ((r / count) shl 16) or ((g / count) shl 8) or (b / count)
                }
            }
            for (x in 0 until w) {
                for (y in 0 until h) {
                    var r = 0; var g = 0; var b = 0; var count = 0
                    for (dy in -radius..radius) {
                        val ny = (y + dy).coerceIn(0, h - 1); val p = temp[ny * w + x]
                        r += (p shr 16) and 0xFF; g += (p shr 8) and 0xFF; b += p and 0xFF; count++
                    }
                    pixels[y * w + x] = (0xFF shl 24) or ((r / count) shl 16) or ((g / count) shl 8) or (b / count)
                }
            }
            bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
        }

        fun copyExif(
            src: androidx.exifinterface.media.ExifInterface,
            dst: androidx.exifinterface.media.ExifInterface,
        ) {
            listOf(
                androidx.exifinterface.media.ExifInterface.TAG_MAKE,
                androidx.exifinterface.media.ExifInterface.TAG_MODEL,
                androidx.exifinterface.media.ExifInterface.TAG_DATETIME,
                androidx.exifinterface.media.ExifInterface.TAG_DATETIME_ORIGINAL,
                androidx.exifinterface.media.ExifInterface.TAG_EXPOSURE_TIME,
                androidx.exifinterface.media.ExifInterface.TAG_F_NUMBER,
                androidx.exifinterface.media.ExifInterface.TAG_ISO_SPEED_RATINGS,
                androidx.exifinterface.media.ExifInterface.TAG_FOCAL_LENGTH,
                androidx.exifinterface.media.ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
                androidx.exifinterface.media.ExifInterface.TAG_WHITE_BALANCE,
                androidx.exifinterface.media.ExifInterface.TAG_FLASH,
                androidx.exifinterface.media.ExifInterface.TAG_GPS_LATITUDE,
                androidx.exifinterface.media.ExifInterface.TAG_GPS_LATITUDE_REF,
                androidx.exifinterface.media.ExifInterface.TAG_GPS_LONGITUDE,
                androidx.exifinterface.media.ExifInterface.TAG_GPS_LONGITUDE_REF,
                androidx.exifinterface.media.ExifInterface.TAG_GPS_ALTITUDE,
                androidx.exifinterface.media.ExifInterface.TAG_GPS_ALTITUDE_REF,
                androidx.exifinterface.media.ExifInterface.TAG_DIGITAL_ZOOM_RATIO,
                androidx.exifinterface.media.ExifInterface.TAG_APERTURE_VALUE,
                androidx.exifinterface.media.ExifInterface.TAG_SHUTTER_SPEED_VALUE,
            ).forEach { tag -> src.getAttribute(tag)?.let { dst.setAttribute(tag, it) } }
        }
    }
}
