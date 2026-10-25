package expo.modules.auctioncamera.utils

import androidx.camera.core.Camera
import androidx.camera.core.FocusMeteringAction
import androidx.camera.view.PreviewView
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

object TapToFocus {

    private var lastAfTriggerMs = 0L
    private const val AF_THROTTLE_MS = 500L

    fun handle(
        camera: Camera?,
        previewView: PreviewView,
        x: Float,
        y: Float,
        onResult: ((Boolean) -> Unit)? = null,
    ) {
        camera ?: return
        val now = System.currentTimeMillis()
        if (now - lastAfTriggerMs < AF_THROTTLE_MS) return
        lastAfTriggerMs = now

        val factory = previewView.meteringPointFactory
        val point = factory.createPoint(x, y)

        val action = FocusMeteringAction.Builder(
            point,
            FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE
        ).setAutoCancelDuration(3, TimeUnit.SECONDS).build()

        camera.cameraControl.cancelFocusAndMetering()
        val future = camera.cameraControl.startFocusAndMetering(action)

        if (onResult != null) {
            val exec = Executor { android.os.Handler(android.os.Looper.getMainLooper()).post(it) }
            future.addListener({
                try {
                    val result = future.get()
                    onResult(result.isFocusSuccessful)
                } catch (e: Exception) {
                    onResult(false)
                }
            }, exec)
        }
    }
}