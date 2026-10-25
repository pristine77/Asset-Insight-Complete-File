package expo.modules.auctioncamera.utils

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.util.UUID

/** Original videos never depend on a purgeable cache and are not copied by draft saves. */
object CameraVideoStorage {
    fun createOutputFile(context: Context): File {
        val directory = File(context.filesDir, "camera-videos")
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create video storage. Check free space." }
        return File(directory, "VID_${UUID.randomUUID()}.mp4")
    }

    fun publish(context: Context, file: File): Uri {
        var galleryUri: Uri? = null
        try {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, file.name)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Auctioneer")
                    put(MediaStore.Video.Media.IS_PENDING, 1)
                }
            }
            galleryUri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                ?: error("Gallery storage unavailable")
            resolver.openOutputStream(galleryUri, "w")?.use { output ->
                file.inputStream().use { it.copyTo(output) }
                output.flush()
            } ?: error("Gallery video is not writable")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val published = resolver.update(galleryUri, ContentValues().apply {
                    put(MediaStore.Video.Media.IS_PENDING, 0)
                }, null, null)
                check(published == 1) { "Gallery video could not be published" }
            }
            return galleryUri
        } catch (error: Exception) {
            galleryUri?.let { runCatching { context.contentResolver.delete(it, null, null) } }
            Log.w("CameraVideoStorage", "Gallery unavailable; retaining durable camera video", error)
            return Uri.fromFile(file)
        }
    }

    fun acknowledgeGalleryHandoff(context: Context, file: File, uri: Uri, journalSaved: Boolean) {
        if (!journalSaved || uri.scheme != "content" || uri.authority != MediaStore.AUTHORITY) return
        val directory = File(context.filesDir, "camera-videos").canonicalFile
        if (file.canonicalFile.parentFile != directory) return
        // A gallery original plus its exact draft journal now exist; discard only our intermediate.
        if (file.exists() && !file.delete()) Log.w("CameraVideoStorage", "Recorded video intermediate retained")
    }
}
