package expo.modules.auctioncamera.extensions

import androidx.camera.extensions.ExtensionMode

sealed class CameraExtensionMode(
    val label: String,
    val extensionMode: Int,
    val blocksManualControls: Boolean = false,
    val isSoftware: Boolean = false,
    val alwaysShow: Boolean = false,
) {
    object Normal : CameraExtensionMode(
        label                = "Auto",
        extensionMode        = ExtensionMode.NONE,
        blocksManualControls = false,
        alwaysShow           = true,
    )

    object HDR : CameraExtensionMode(
        label                = "HDR",
        extensionMode        = ExtensionMode.HDR,
        blocksManualControls = false,
        alwaysShow           = true,
    )

    object Bokeh : CameraExtensionMode(
        label                = "Portrait",
        extensionMode        = ExtensionMode.BOKEH,
        blocksManualControls = true,
        alwaysShow           = true,
    )

    companion object {
        val all: List<CameraExtensionMode> = listOf(Normal, HDR, Bokeh)
        fun fromExtensionMode(mode: Int) = all.firstOrNull { it.extensionMode == mode } ?: Normal
    }
}