package expo.modules.auctioncamera.extensions

import android.content.Context
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.extensions.ExtensionsManager
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.google.common.util.concurrent.ListenableFuture

object ExtensionAvailabilityManager {

    private const val TAG = "ExtManager"
    private var extensionsManager: ExtensionsManager? = null
    private var availableModes: List<CameraExtensionMode> = listOf(CameraExtensionMode.Normal)
    private var initialized = false

    fun initialize(
        context: Context,
        lensFacing: Int = CameraSelector.LENS_FACING_BACK,
        onReady: (available: List<CameraExtensionMode>) -> Unit,
    ) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)

        cameraProviderFuture.addListener({
            try {
                val provider = cameraProviderFuture.get()
                val extFuture = ExtensionsManager.getInstanceAsync(context, provider)

                extFuture.addListener({
                    try {
                        val em = extFuture.get()
                        extensionsManager = em
                        val selector = CameraSelector.Builder().requireLensFacing(lensFacing).build()

                        val supported = mutableListOf<CameraExtensionMode>()

                        val candidates = listOf(
                            CameraExtensionMode.HDR,
                            CameraExtensionMode.Bokeh,
                        )

                        for (mode in candidates) {
                            val oemOk = runCatching {
                                em.isExtensionAvailable(selector, mode.extensionMode)
                            }.getOrDefault(false)

                            if (oemOk || mode.alwaysShow) {
                                supported.add(mode)
                                Log.d(TAG, "${mode.label}: oemSupported=$oemOk alwaysShow=${mode.alwaysShow} \u2192 included")
                            } else {
                                Log.d(TAG, "${mode.label}: not available, skipping")
                            }
                        }

                        availableModes = listOf(CameraExtensionMode.Normal) + supported
                        initialized = true
                        Log.d(TAG, "Available: ${availableModes.map { it.label }}")
                        onReady(availableModes)

                    } catch (e: Exception) {
                        Log.e(TAG, "ExtensionsManager.get() failed: ${e.message}")
                        fallback(onReady)
                    }
                }, ContextCompat.getMainExecutor(context))

            } catch (e: Exception) {
                Log.e(TAG, "ProcessCameraProvider failed: ${e.message}")
                fallback(onReady)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun fallback(onReady: (List<CameraExtensionMode>) -> Unit) {
        availableModes = listOf(CameraExtensionMode.Normal, CameraExtensionMode.HDR)
        initialized = true
        onReady(availableModes)
    }

    fun isInitialized() = initialized
    fun getAvailableModes(): List<CameraExtensionMode> = availableModes
    fun isAvailable(mode: CameraExtensionMode): Boolean = availableModes.any { it::class == mode::class }
    fun isHDRAvailable()   = isAvailable(CameraExtensionMode.HDR)


    fun buildExtendedSelector(
        mode: CameraExtensionMode,
        lensFacing: Int = CameraSelector.LENS_FACING_BACK,
    ): CameraSelector? {
        if (FakeExtensionProvider.FORCE_FAKE) return null
        if (mode.isSoftware) return null
        val em = extensionsManager ?: return null
        if (mode is CameraExtensionMode.Normal) return null
        if (!isAvailable(mode)) return null
        val base = CameraSelector.Builder().requireLensFacing(lensFacing).build()
        return runCatching {
            em.getExtensionEnabledCameraSelector(base, mode.extensionMode)
        }.getOrNull()
    }

    fun reset() {
        extensionsManager = null
        availableModes    = listOf(CameraExtensionMode.Normal)
        initialized       = false
    }
}