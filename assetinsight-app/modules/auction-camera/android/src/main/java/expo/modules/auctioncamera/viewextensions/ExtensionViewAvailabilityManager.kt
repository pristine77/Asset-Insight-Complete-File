package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.extensions.ExtensionsManager
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat

object ExtensionViewAvailabilityManager {

    private const val TAG = "ExtViewManager"

    private var extensionsManager: ExtensionsManager? = null
    private var availableModes: List<CameraViewExtensionMode> = defaultModes()
    private var initialized = false

    private fun defaultModes() = listOf(
        CameraViewExtensionMode.Normal,
        CameraViewExtensionMode.HDR,
        CameraViewExtensionMode.Bokeh,
        CameraViewExtensionMode.Night,
    )

    fun initialize(
        context: Context,
        lensFacing: Int = CameraSelector.LENS_FACING_BACK,
        onReady: (List<CameraViewExtensionMode>) -> Unit,
    ) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                val extFuture = ExtensionsManager.getInstanceAsync(context, provider)
                extFuture.addListener({
                    try {
                        val em = extFuture.get()
                        extensionsManager = em
                        val selector = CameraSelector.Builder()
                            .requireLensFacing(lensFacing)
                            .build()

                        availableModes = buildList {
                            add(CameraViewExtensionMode.Normal)
                            add(CameraViewExtensionMode.HDR)
                            add(CameraViewExtensionMode.Night)

                            val bokehAvailable = runCatching {
                                em.isExtensionAvailable(
                                    selector,
                                    CameraViewExtensionMode.Bokeh.extensionMode
                                )
                            }.getOrDefault(false)

                            Log.d(TAG, "Bokeh available on device: $bokehAvailable")
                            if (bokehAvailable) add(CameraViewExtensionMode.Bokeh)
                        }

                        initialized = true
                        Log.d(TAG, "Available: ${availableModes.map { it.label }}")
                        onReady(availableModes)

                    } catch (e: Exception) {
                        Log.e(TAG, "ExtensionsManager failed: ${e.message}")
                        fallback(onReady)
                    }
                }, ContextCompat.getMainExecutor(context))
            } catch (e: Exception) {
                Log.e(TAG, "Provider failed: ${e.message}")
                fallback(onReady)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun fallback(onReady: (List<CameraViewExtensionMode>) -> Unit) {
        availableModes = defaultModes()
        initialized = true
        Log.w(TAG, "Using fallback modes: ${availableModes.map { it.label }}")
        onReady(availableModes)
    }

    fun isInitialized() = initialized
    fun getAvailableModes() = availableModes
    fun isAvailable(mode: CameraViewExtensionMode) =
        availableModes.any { it::class == mode::class }

    fun buildExtendedSelector(
        mode: CameraViewExtensionMode,
        lensFacing: Int = CameraSelector.LENS_FACING_BACK,
    ): CameraSelector? {
        if (mode.isSoftware || mode is CameraViewExtensionMode.Normal) return null
        val em = extensionsManager ?: return null
        val base = CameraSelector.Builder().requireLensFacing(lensFacing).build()
        val ok = runCatching {
            em.isExtensionAvailable(base, mode.extensionMode)
        }.getOrDefault(false)
        if (!ok) return null
        return runCatching {
            em.getExtensionEnabledCameraSelector(base, mode.extensionMode)
        }.getOrNull()
    }

    fun reset() {
        extensionsManager = null
        availableModes = defaultModes()
        initialized = false
    }
}