package expo.modules.auctioncamera.utils

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.util.Log
import expo.modules.auctioncamera.compression.CompressionResult
import expo.modules.auctioncamera.compression.ExifReader
import expo.modules.auctioncamera.compression.ExifWriter
import expo.modules.auctioncamera.compression.OrientationCorrector
import expo.modules.auctioncamera.compression.RecursiveCompressor
import expo.modules.auctioncamera.model.ExifData
import expo.modules.auctioncamera.model.ImageProcessingConfig
import java.io.File

object ImageProcessingPipeline {
    private const val TAG = "ImagePipeline"

    data class PipelineResult(
        val uri: Uri?,
        val compressionResult: CompressionResult,
        val exifPreserved: Boolean,
    ) {
        val savedSuccessfully get() = uri != null && compressionResult !is CompressionResult.Failure
    }

    fun process(
        sourceFile: File,
        context: Context,
        config: ImageProcessingConfig = ImageProcessingConfig.DEFAULT,
        cacheDir: File = context.cacheDir,
        liveExif: ExifData? = null,
    ): PipelineResult {
        Log.d(
            TAG,
            "START ${sourceFile.name} (${sourceFile.length() / 1024}KB) " +
                    "\u2192 target=${config.targetMaxBytes / 1024}KB " +
                    "gps=${liveExif?.hasGps} optics=${liveExif?.isoSpeedRatings != null}"
        )

        val fileExif = ExifReader.read(sourceFile)
        val mergedExif = if (liveExif != null) merge(fileExif, liveExif) else fileExif
        val decoded = SafeBitmapDecoder.decode(sourceFile, config)
            ?: return PipelineResult(
                null,
                CompressionResult.Failure("SafeBitmapDecoder returned null"),
                false,
            )

        var bmp = decoded.bitmap
        val corrected = OrientationCorrector.correct(bmp, mergedExif)
        bmp = corrected.bitmap

        val tmp = File(cacheDir, "pipeline_${System.currentTimeMillis()}.jpg")
        val cr = RecursiveCompressor.compress(
            bmp, tmp, sourceFile.length(), config,
            decoded.wasScaledDown || corrected.wasRotated,
        )
        bmp.recycle()

        if (cr is CompressionResult.Failure) {
            tmp.delete()
            Log.e(TAG, "FAILED: ${cr.reason}")
            return PipelineResult(null, cr, false)
        }

        val exifOk = ExifWriter.write(tmp, mergedExif, config)
        val uri = saveToMediaStore(tmp, context, config)
        tmp.delete()
        return PipelineResult(uri, cr, exifOk)
    }


    private fun merge(file: ExifData, live: ExifData): ExifData = ExifData(
        orientation = file.orientation,
        gpsLatitude = live.gpsLatitude ?: file.gpsLatitude,
        gpsLatitudeRef = live.gpsLatitudeRef ?: file.gpsLatitudeRef,
        gpsLongitude = live.gpsLongitude ?: file.gpsLongitude,
        gpsLongitudeRef = live.gpsLongitudeRef ?: file.gpsLongitudeRef,
        gpsAltitude = live.gpsAltitude ?: file.gpsAltitude,
        gpsAltitudeRef = live.gpsAltitudeRef ?: file.gpsAltitudeRef,
        gpsTimestamp = live.gpsTimestamp ?: file.gpsTimestamp,
        gpsDateStamp = live.gpsDateStamp ?: file.gpsDateStamp,
        gpsSpeed = live.gpsSpeed ?: file.gpsSpeed,
        gpsSpeedRef = live.gpsSpeedRef ?: file.gpsSpeedRef,
        gpsBearing = live.gpsBearing ?: file.gpsBearing,
        gpsBearingRef = live.gpsBearingRef ?: file.gpsBearingRef,
        gpsProcessingMethod = live.gpsProcessingMethod ?: file.gpsProcessingMethod,
        dateTime = live.dateTime ?: file.dateTime,
        dateTimeOriginal = live.dateTimeOriginal ?: file.dateTimeOriginal,
        dateTimeDigitized = live.dateTimeDigitized ?: file.dateTimeDigitized,
        offsetTime = live.offsetTime ?: file.offsetTime,
        make = live.make ?: file.make,
        model = live.model ?: file.model,
        software = live.software ?: file.software,
        isoSpeedRatings = live.isoSpeedRatings ?: file.isoSpeedRatings,
        exposureTime = live.exposureTime ?: file.exposureTime,
        fNumber = live.fNumber ?: file.fNumber,
        focalLength = live.focalLength ?: file.focalLength,
        focalLengthIn35mm = live.focalLengthIn35mm ?: file.focalLengthIn35mm,
        flash = live.flash ?: file.flash,
        whiteBalance = live.whiteBalance ?: file.whiteBalance,
        exposureMode = live.exposureMode ?: file.exposureMode,
        exposureBiasValue = live.exposureBiasValue ?: file.exposureBiasValue,
        meteringMode = live.meteringMode ?: file.meteringMode,
        sceneCaptureType = live.sceneCaptureType ?: file.sceneCaptureType,
        imageWidth = file.imageWidth,
        imageLength = file.imageLength,
        pixelXDimension = file.pixelXDimension,
        pixelYDimension = file.pixelYDimension,
    )

    private fun saveToMediaStore(
        file: File,
        context: Context,
        config: ImageProcessingConfig,
    ): Uri? =
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q)
            saveApi29(file, context, config)
        else
            saveLegacy(file, context, config)

    private fun saveApi29(file: File, context: Context, config: ImageProcessingConfig): Uri? {
        val cv = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "IMG_${System.currentTimeMillis()}.jpg")
            put(MediaStore.Images.Media.MIME_TYPE, config.outputMimeType)
            put(MediaStore.Images.Media.RELATIVE_PATH, config.outputFolder)
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = context.contentResolver.insert(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv
        ) ?: run {
            Log.e(TAG, "MediaStore insert returned null");
            return null
        }

        return try {
            context.contentResolver.openOutputStream(uri)
                ?.use { out -> file.inputStream().use { it.copyTo(out) } }
            cv.clear()
            cv.put(MediaStore.Images.Media.IS_PENDING, 0)
            context.contentResolver.update(uri, cv, null, null)
            uri
        } catch (e: Exception) {
            Log.e(TAG, "saveApi29 failed: ${e.message}")
            context.contentResolver.delete(uri, null, null)
            null
        }
    }

    private fun saveLegacy(file: File, context: Context, config: ImageProcessingConfig): Uri? {
        val dest = File(
            android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_PICTURES)
                .also { it.mkdirs() }, "IMG_${System.currentTimeMillis()}.jpg"
        )
        return try {
            file.copyTo(dest, overwrite = true)
            var scannedUri: Uri? = null
            android.media.MediaScannerConnection.scanFile(
                context,
                arrayOf(dest.absolutePath),
                arrayOf(config.outputMimeType)
            ) { _, uri -> scannedUri = uri }
            scannedUri
        } catch (e: Exception) {
            Log.e(TAG, "saveLegacy failed: ${e.message}"); null
        }
    }
}