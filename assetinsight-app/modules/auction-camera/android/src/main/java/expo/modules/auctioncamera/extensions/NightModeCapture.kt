package expo.modules.auctioncamera.extensions


import android.util.Log
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import expo.modules.auctioncamera.utils.SoftwareNightMode
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class NightModeCapture(
    private val imageCapture: ImageCapture,
    private val cacheDir: File,
    private val executor: ExecutorService,
    private val mainHandler: android.os.Handler,
) {
    private val TAG = "NightCapture"
    private val INTER_FRAME_DELAY_MS = 120L
    private val cancelled = AtomicBoolean(false)

    private val mainExecutor = java.util.concurrent.Executor { cmd -> mainHandler.post(cmd) }

    fun capture(
        onProgress: (Int, Int) -> Unit,
        onComplete: (List<File>) -> Unit,
        onError: (String) -> Unit,
    ) {
        cancelled.set(false)
        val total      = SoftwareNightMode.FRAME_COUNT
        val captured   = mutableListOf<File>()
        val frameIndex = AtomicInteger(0)

        fun captureNext() {
            if (cancelled.get()) {
                Log.d(TAG, "Cancelled at frame ${frameIndex.get()}")
                captured.forEach { it.delete() }
                return
            }

            val idx = frameIndex.get()
            if (idx >= total) {
                onComplete(captured.toList())
                return
            }

            val frameFile = File(cacheDir, "night_frame_${System.currentTimeMillis()}_$idx.jpg")
            val options   = ImageCapture.OutputFileOptions.Builder(frameFile).build()

            imageCapture.takePicture(options, mainExecutor,
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                        if (frameFile.exists() && frameFile.length() > 0) {
                            captured.add(frameFile)
                            Log.d(TAG, "Frame $idx captured: ${frameFile.length() / 1024}KB")
                        }
                        frameIndex.incrementAndGet()
                        onProgress(captured.size, total)

                        mainHandler.postDelayed({ captureNext() }, INTER_FRAME_DELAY_MS)
                    }

                    override fun onError(e: ImageCaptureException) {
                        Log.w(TAG, "Frame $idx failed: ${e.message} \u2014 continuing")
                        frameIndex.incrementAndGet()
                        if (frameIndex.get() >= total) {
                            if (captured.isEmpty()) onError("Night mode: all frames failed")
                            else onComplete(captured.toList())
                        } else {
                            mainHandler.postDelayed({ captureNext() }, INTER_FRAME_DELAY_MS)
                        }
                    }
                }
            )
        }

        captureNext()
    }

    fun cancel() {
        cancelled.set(true)
        Log.d(TAG, "Capture cancelled")
    }
}