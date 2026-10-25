package expo.modules.auctioncamera.compression

import android.util.Log
import androidx.exifinterface.media.ExifInterface
import expo.modules.auctioncamera.model.ExifData
import java.io.File
import java.io.InputStream

object ExifReader {

    private const val TAG = "ExifReader"

    fun read(file: File): ExifData {
        if (!file.exists() || !file.canRead()) { Log.w(TAG, "Cannot read: ${file.absolutePath}"); return ExifData() }
        return try { parse(ExifInterface(file.absolutePath)) } catch (e: Exception) { Log.w(TAG, "EXIF read failed: ${e.message}"); ExifData() }
    }

    fun readFromStream(stream: InputStream): ExifData =
        try { parse(ExifInterface(stream)) } catch (e: Exception) { Log.w(TAG, "EXIF stream failed: ${e.message}"); ExifData() }

    private fun parse(exif: ExifInterface): ExifData {
        fun tag(key: String) = try { exif.getAttribute(key)?.takeIf { it.isNotBlank() } } catch (e: Exception) { null }
        fun tagInt(key: String, def: Int) = try { exif.getAttributeInt(key, def) } catch (e: Exception) { def }
        return ExifData(
            orientation         = tagInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED).takeIf { it != ExifInterface.ORIENTATION_UNDEFINED },
            gpsLatitude         = tag(ExifInterface.TAG_GPS_LATITUDE),    gpsLatitudeRef    = tag(ExifInterface.TAG_GPS_LATITUDE_REF),
            gpsLongitude        = tag(ExifInterface.TAG_GPS_LONGITUDE),   gpsLongitudeRef   = tag(ExifInterface.TAG_GPS_LONGITUDE_REF),
            gpsAltitude         = tag(ExifInterface.TAG_GPS_ALTITUDE),    gpsAltitudeRef    = tag(ExifInterface.TAG_GPS_ALTITUDE_REF),
            gpsTimestamp        = tag(ExifInterface.TAG_GPS_TIMESTAMP),   gpsDateStamp      = tag(ExifInterface.TAG_GPS_DATESTAMP),
            dateTime            = tag(ExifInterface.TAG_DATETIME),        dateTimeOriginal  = tag(ExifInterface.TAG_DATETIME_ORIGINAL),
            dateTimeDigitized   = tag(ExifInterface.TAG_DATETIME_DIGITIZED),
            make                = tag(ExifInterface.TAG_MAKE),            model             = tag(ExifInterface.TAG_MODEL),
            software            = tag(ExifInterface.TAG_SOFTWARE),
            isoSpeedRatings     = tag(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY),
            exposureTime        = tag(ExifInterface.TAG_EXPOSURE_TIME),   fNumber           = tag(ExifInterface.TAG_F_NUMBER),
            focalLength         = tag(ExifInterface.TAG_FOCAL_LENGTH),    focalLengthIn35mm = tag(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM),
            flash               = tag(ExifInterface.TAG_FLASH),           whiteBalance      = tag(ExifInterface.TAG_WHITE_BALANCE),
            exposureMode        = tag(ExifInterface.TAG_EXPOSURE_MODE),   exposureBiasValue = tag(ExifInterface.TAG_EXPOSURE_BIAS_VALUE),
            meteringMode        = tag(ExifInterface.TAG_METERING_MODE),   sceneCaptureType  = tag(ExifInterface.TAG_SCENE_CAPTURE_TYPE),
            imageWidth          = tag(ExifInterface.TAG_IMAGE_WIDTH),     imageLength       = tag(ExifInterface.TAG_IMAGE_LENGTH),
            pixelXDimension     = tag(ExifInterface.TAG_PIXEL_X_DIMENSION), pixelYDimension = tag(ExifInterface.TAG_PIXEL_Y_DIMENSION),
        )
    }
}