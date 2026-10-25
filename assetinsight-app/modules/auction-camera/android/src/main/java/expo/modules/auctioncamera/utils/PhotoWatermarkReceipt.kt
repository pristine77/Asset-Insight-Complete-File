package expo.modules.auctioncamera.utils

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/** Byte-bound processing receipt shared with the backend; never a trust/auth token. */
object PhotoWatermarkReceipt {
    private val prefix = "AssetInsight:photo-watermark:v1\u0000".toByteArray(Charsets.US_ASCII)
    private val payloadSize = prefix.size + 32
    private val jpegSize = payloadSize + 4
    private val boxSize = payloadSize + 8
    private fun ascii(bytes: ByteArray, start: Int, count: Int) =
        if (start >= 0 && start + count <= bytes.size) String(bytes, start, count, Charsets.US_ASCII) else ""
    private fun jpeg(bytes: ByteArray) = bytes.size >= 2 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte()
    private fun webp(bytes: ByteArray) = ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WEBP"
    private fun avif(bytes: ByteArray) = ascii(bytes, 4, 4) == "ftyp" && ascii(bytes, 8, 4) in listOf("avif", "avis")
    private fun intAt(bytes: ByteArray, offset: Int, little: Boolean = false) =
        ByteBuffer.wrap(bytes, offset, 4).order(if (little) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN).int
    private fun putInt(bytes: ByteArray, offset: Int, value: Int, little: Boolean = false) {
        ByteBuffer.wrap(bytes, offset, 4).order(if (little) ByteOrder.LITTLE_ENDIAN else ByteOrder.BIG_ENDIAN).putInt(value)
    }
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun has(bytes: ByteArray): Boolean {
        if (jpeg(bytes)) {
            if (bytes.size < 2 + jpegSize || bytes[2] != 0xff.toByte() || bytes[3] != 0xef.toByte()) return false
            if (((bytes[4].toInt() and 255) * 256 + (bytes[5].toInt() and 255)) != payloadSize + 2) return false
            if (!bytes.copyOfRange(6, 6 + prefix.size).contentEquals(prefix)) return false
            val original = bytes.copyOfRange(0, 2) + bytes.copyOfRange(2 + jpegSize, bytes.size)
            return MessageDigest.isEqual(bytes.copyOfRange(6 + prefix.size, 2 + jpegSize), digest(original))
        }
        val offset = bytes.size - boxSize
        if (offset < 12 || (!webp(bytes) && !avif(bytes))) return false
        if (webp(bytes)) {
            if (intAt(bytes, 4, true) != bytes.size - 8 || ascii(bytes, offset, 4) != "aiwm" || intAt(bytes, offset + 4, true) != payloadSize) return false
        } else if (intAt(bytes, offset) != boxSize || ascii(bytes, offset + 4, 4) != "free") return false
        if (!bytes.copyOfRange(offset + 8, offset + 8 + prefix.size).contentEquals(prefix)) return false
        val original = bytes.copyOfRange(0, offset)
        if (webp(bytes)) putInt(original, 4, original.size - 8, true)
        return MessageDigest.isEqual(bytes.copyOfRange(offset + 8 + prefix.size, bytes.size), digest(original))
    }

    /** Call after EXIF edits and only after stamping pixels (or editing stamped pixels). */
    fun add(bytes: ByteArray): ByteArray {
        if (has(bytes)) return bytes
        if (jpeg(bytes)) {
            val marker = byteArrayOf(0xff.toByte(), 0xef.toByte(), 0, (payloadSize + 2).toByte()) + prefix + digest(bytes)
            return bytes.copyOfRange(0, 2) + marker + bytes.copyOfRange(2, bytes.size)
        }
        require(webp(bytes) || avif(bytes)) { "Unsupported watermark photo format" }
        val marker = ByteArray(boxSize)
        if (webp(bytes)) {
            require(intAt(bytes, 4, true) == bytes.size - 8) { "Invalid WebP size" }
            "aiwm".toByteArray(Charsets.US_ASCII).copyInto(marker)
            putInt(marker, 4, payloadSize, true)
        } else {
            putInt(marker, 0, boxSize)
            "free".toByteArray(Charsets.US_ASCII).copyInto(marker, 4)
        }
        prefix.copyInto(marker, 8)
        digest(bytes).copyInto(marker, 8 + prefix.size)
        val output = bytes + marker
        if (webp(bytes)) putInt(output, 4, output.size - 8, true)
        return output
    }
}
