package com.assetinsight.app

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.Paint
import android.graphics.RectF
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.Display
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import expo.modules.auctioncamera.compression.MozJpegEncoder
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.utils.PhotoWatermarkReceipt
import expo.modules.auctioncamera.viewextensions.CameraViewEngine
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Synthetic, offline fixtures only. Results remain in the isolated emulator for visual QA. */
object MozJpegCameraAssertions {
    private fun progressive(bytes: ByteArray): Boolean {
        var index = 2
        while (index + 3 < bytes.size && bytes[index] == 0xff.toByte()) {
            val marker = bytes[index + 1].toInt() and 255
            if (marker == 0xc2) return true
            if (marker == 0xda || marker == 0xd9) return false
            val length = ((bytes[index + 2].toInt() and 255) shl 8) or (bytes[index + 3].toInt() and 255)
            if (length < 2) return false
            index += length + 2
        }
        return false
    }

    private fun chart(width: Int, height: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(223, 226, 230))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val step = width / 4f
        for ((index, color) in listOf(Color.RED, Color.GREEN, Color.BLUE, Color.WHITE).withIndex()) {
            paint.color = color
            canvas.drawRect(index * step, 0f, (index + 1) * step, height / 5f, paint)
        }
        paint.color = Color.BLACK
        paint.textSize = width / 80f
        for (row in 1..15) {
            canvas.drawText("LOT 142 | VIN 1FTFW1ET5EFA12345 | HOURS 10,770.4 | 2026 Asset Insight", 40f, height / 5f + row * height / 23f, paint)
        }
        paint.strokeWidth = 1f
        for (line in 0..100) canvas.drawLine(width * 0.75f + line * 2, height * 0.4f, width * 0.75f + line * 2, height * 0.8f, paint)
        return bitmap
    }

    @JvmStatic fun run(instrumentation: Instrumentation) {
        val context = instrumentation.targetContext
        val directory = File(context.getExternalFilesDir(null), "mozjpeg-qa").apply { mkdirs() }
        val measurements = JSONArray()
        val source = chart(1600, 1200)
        val start = SystemClock.elapsedRealtime()
        val encoded = checkNotNull(MozJpegEncoder.encode(source, 60)) { "MozJPEG JNI did not load/encode" }
        check(progressive(encoded)) { "Encoder did not produce progressive JPEG" }
        check(String(encoded, Charsets.ISO_8859_1).contains("ICC_PROFILE")) { "Missing sRGB profile" }
        val decoded = checkNotNull(BitmapFactory.decodeByteArray(encoded, 0, encoded.size))
        check(decoded.width == 1600 && decoded.height == 1200)
        for ((x, expected) in listOf(200 to Color.RED, 600 to Color.GREEN, 1000 to Color.BLUE)) {
            val actual = decoded.getPixel(x, 100)
            check(kotlin.math.abs(Color.red(actual) - Color.red(expected)) < 15)
            check(kotlin.math.abs(Color.green(actual) - Color.green(expected)) < 15)
            check(kotlin.math.abs(Color.blue(actual) - Color.blue(expected)) < 15)
        }
        measurements.put(JSONObject().put("case", "direct-1600").put("bytes", encoded.size).put("ms", SystemClock.elapsedRealtime() - start))
        decoded.recycle()
        File(directory, "direct-q60.jpg").writeBytes(encoded)
        val unsupported = Bitmap.createBitmap(32, 32, Bitmap.Config.RGB_565)
        check(MozJpegEncoder.encode(unsupported, 60) == null)
        unsupported.recycle()
        check(MozJpegEncoder.encode(unsupported, 60) == null)
        if (Build.VERSION.SDK_INT >= 26) {
            val wide = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888, false, ColorSpace.get(ColorSpace.Named.DISPLAY_P3))
            check(MozJpegEncoder.encode(wide, 60) == null) { "Wide gamut was mislabeled as sRGB" }
            wide.recycle()
        }
        // libjpeg rejects dimensions above 65,500; cleanup must unlock the bitmap and
        // leave the encoder usable after its longjmp path.
        val tooWide = Bitmap.createBitmap(65501, 1, Bitmap.Config.ARGB_8888)
        check(MozJpegEncoder.encode(tooWide, 60) == null)
        tooWide.eraseColor(Color.WHITE)
        tooWide.recycle()
        check(MozJpegEncoder.encode(source, 60) != null)
        val pool = Executors.newFixedThreadPool(3)
        try {
            val results = pool.invokeAll((1..6).map { Callable { checkNotNull(MozJpegEncoder.encode(source, 60)) } })
            results.forEach { check(it.get(30, TimeUnit.SECONDS).contentEquals(encoded)) }
        } finally {
            pool.shutdownNow()
            source.recycle()
        }

        lateinit var engine: CameraViewEngine
        instrumentation.runOnMainSync {
            val owner = object : LifecycleOwner { override val lifecycle = LifecycleRegistry(this) }
            val display = context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
            engine = CameraViewEngine(context.createDisplayContext(display), owner)
        }
        val method = CameraViewEngine::class.java.getDeclaredMethod("processCapturedFile", File::class.java).apply { isAccessible = true }
        fun process(label: String, width: Int, height: Int, expectedWidth: Int, expectedHeight: Int, rotation: Int = 1, high: Boolean = false, crop: RectF? = null, texture: Boolean = false) {
            engine.set12MPOutput(high)
            engine.activeCropRect = crop
            val input = File(directory, "$label-input.jpg")
            val chart = chart(width, height)
            if (texture) {
                val random = java.util.Random(20261022L)
                val row = IntArray(width)
                for (y in 0 until height) {
                    for (x in row.indices) row[x] = Color.rgb(random.nextInt(256), random.nextInt(256), random.nextInt(256))
                    chart.setPixels(row, 0, width, 0, y, width, 1)
                }
            }
            input.outputStream().use { check(chart.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
            chart.recycle()
            ExifInterface(input.path).apply {
                setAttribute(ExifInterface.TAG_ORIENTATION, rotation.toString())
                setAttribute(ExifInterface.TAG_MAKE, "Asset Insight Synthetic QA")
                saveAttributes()
            }
            val begin = SystemClock.elapsedRealtime()
            val result = checkNotNull(method.invoke(engine, input)) { "$label processing failed" }
            val getter = result.javaClass.getDeclaredMethod("getUri").apply { isAccessible = true }
            val uri = getter.invoke(result) as Uri
            val bytes = checkNotNull(context.contentResolver.openInputStream(uri)).use { it.readBytes() }
            val image = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
            check(image.width == expectedWidth && image.height == expectedHeight) { "$label size ${image.width}x${image.height}" }
            check(PhotoWatermarkReceipt.has(bytes)) { "$label missing watermark receipt" }
            check(PhotoWatermarkReceipt.add(bytes).contentEquals(bytes)) { "$label receipt not idempotent" }
            val exif = ExifInterface(bytes.inputStream())
            check(exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, -1) == 1)
            check(exif.getAttribute(ExifInterface.TAG_MAKE) == "Asset Insight Synthetic QA")
            check(progressive(bytes) == !high) { "$label changed encoder policy" }
            File(directory, "$label.jpg").writeBytes(bytes)
            // Inspect the logo's actual proportional rectangle. On a very wide
            // photo, its width-based padding is larger than 10% of photo height.
            val logo = checkNotNull(BitmapFactory.decodeResource(context.resources, R.drawable.ic_app_img))
            val logoWidth = image.width * 0.2f
            val logoHeight = logoWidth * logo.height / logo.width
            logo.recycle()
            val padding = image.width * 0.03f
            val left = (image.width - logoWidth - padding).toInt().coerceAtLeast(0)
            val top = (image.height - logoHeight - padding).toInt().coerceAtLeast(0)
            var logoPixels = 0
            for (y in top until minOf(image.height, (top + logoHeight).toInt()) step 2) {
                for (x in left until minOf(image.width, (left + logoWidth).toInt()) step 2) {
                    val pixel = image.getPixel(x, y)
                    if (Color.red(pixel) < 150 || Color.green(pixel) < 150 || Color.blue(pixel) < 150) logoPixels++
                }
            }
            check(logoPixels > 20) { "$label visible logo missing" }
            image.recycle()
            measurements.put(JSONObject().put("case", label).put("width", expectedWidth).put("height", expectedHeight).put("bytes", bytes.size).put("ms", SystemClock.elapsedRealtime() - begin).put("progressive", progressive(bytes)))
        }
        try {
            process("landscape", 4032, 3024, 2400, 1800)
            process("portrait-exif", 4032, 3024, 1800, 2400, rotation = 6)
            process("no-enlargement", 1280, 960, 1280, 960)
            process("focus-crop", 4032, 3024, 2016, 1512, crop = RectF(0.25f, 0.25f, 0.75f, 0.75f))
            process("high-resolution", 6200, 1000, 6000, 968, high = true)
            // Deliberately incompressible input exercises repeated encodes and the
            // quality floor. 200 KiB is a target, never a reason to discard a photo.
            process("high-detail-stress", 2400, 1800, 2400, 1800, texture = true)
        } finally {
            instrumentation.runOnMainSync { engine.shutdown() }
        }
        File(directory, "measurements.json").writeText(JSONObject().put("api", Build.VERSION.SDK_INT).put("cases", measurements).toString(2))
    }
}
