package expo.modules.auctioncamera.compression

import android.util.Log
import androidx.exifinterface.media.ExifInterface
import expo.modules.auctioncamera.model.ExifData
import expo.modules.auctioncamera.model.ImageProcessingConfig
import java.io.File

object ExifWriter {

    private const val TAG = "ExifWriter"

    fun write(dest: File, exif: ExifData, config: ImageProcessingConfig): Boolean {
        if (!dest.exists() || !dest.canWrite()) {
            Log.w(TAG, "Cannot write: ${dest.absolutePath}"); return false
        }
        return try {
            ExifInterface(dest.absolutePath).apply {
                applyFields(this, exif, config)
                saveAttributes()
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "EXIF write failed: ${e.message}"); false
        }
    }

    private fun applyFields(exif: ExifInterface, d: ExifData, c: ImageProcessingConfig) {
        fun set(tag: String, value: String?) { value?.let { exif.setAttribute(tag, it) } }

        if (c.preserveOrientation)
            exif.setAttribute(ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL.toString())


        if (c.preserveGps && d.hasGps) {
            set(ExifInterface.TAG_GPS_LATITUDE,          d.gpsLatitude)
            set(ExifInterface.TAG_GPS_LATITUDE_REF,      d.gpsLatitudeRef)
            set(ExifInterface.TAG_GPS_LONGITUDE,         d.gpsLongitude)
            set(ExifInterface.TAG_GPS_LONGITUDE_REF,     d.gpsLongitudeRef)
            set(ExifInterface.TAG_GPS_ALTITUDE,          d.gpsAltitude)
            set(ExifInterface.TAG_GPS_ALTITUDE_REF,      d.gpsAltitudeRef)
            set(ExifInterface.TAG_GPS_TIMESTAMP,         d.gpsTimestamp)
            set(ExifInterface.TAG_GPS_DATESTAMP,         d.gpsDateStamp)
            set(ExifInterface.TAG_GPS_SPEED,             d.gpsSpeed)
            set(ExifInterface.TAG_GPS_SPEED_REF,         d.gpsSpeedRef)
            set(ExifInterface.TAG_GPS_IMG_DIRECTION,     d.gpsBearing)
            set(ExifInterface.TAG_GPS_IMG_DIRECTION_REF, d.gpsBearingRef)
            set(ExifInterface.TAG_GPS_PROCESSING_METHOD, d.gpsProcessingMethod)
        }
        if (c.preserveTimestamp) {
            set(ExifInterface.TAG_DATETIME,           d.dateTime)
            set(ExifInterface.TAG_DATETIME_ORIGINAL,  d.dateTimeOriginal)
            set(ExifInterface.TAG_DATETIME_DIGITIZED, d.dateTimeDigitized)
            set(ExifInterface.TAG_OFFSET_TIME,        d.offsetTime)
            set(ExifInterface.TAG_OFFSET_TIME_ORIGINAL, d.offsetTime)
        }
        if (c.preserveDeviceInfo) {
            exif.setAttribute(ExifInterface.TAG_MAKE,
                d.make     ?: android.os.Build.MANUFACTURER)
            exif.setAttribute(ExifInterface.TAG_MODEL,
                d.model    ?: android.os.Build.MODEL)
            exif.setAttribute(ExifInterface.TAG_SOFTWARE,
                d.software ?: "AuctionCamera")
        }
        if (c.preserveCameraSettings) {
            set(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,  d.isoSpeedRatings)
            set(ExifInterface.TAG_EXPOSURE_TIME,             d.exposureTime)
            set(ExifInterface.TAG_F_NUMBER,                  d.fNumber)
            set(ExifInterface.TAG_FOCAL_LENGTH,              d.focalLength)
            set(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM, d.focalLengthIn35mm)
            set(ExifInterface.TAG_FLASH,                     d.flash)
            set(ExifInterface.TAG_WHITE_BALANCE,             d.whiteBalance)
            set(ExifInterface.TAG_EXPOSURE_MODE,             d.exposureMode)
            set(ExifInterface.TAG_EXPOSURE_BIAS_VALUE,       d.exposureBiasValue)
            set(ExifInterface.TAG_METERING_MODE,             d.meteringMode)
            set(ExifInterface.TAG_SCENE_CAPTURE_TYPE,        d.sceneCaptureType)
        }
    }
}