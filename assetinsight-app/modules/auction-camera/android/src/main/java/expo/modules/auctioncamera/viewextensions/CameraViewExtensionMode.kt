package expo.modules.auctioncamera.viewextensions

import androidx.camera.extensions.ExtensionMode

sealed class CameraViewExtensionMode(
    val label: String,
    val extensionMode: Int,
    val blocksManualControls: Boolean = false,
    val isSoftware: Boolean = false,
    val alwaysShow: Boolean = false,
) {
    object Normal : CameraViewExtensionMode(
        label = "Normal",
        extensionMode = ExtensionMode.NONE,
        alwaysShow = true,
    )

    object HDR : CameraViewExtensionMode(
        label = "HDR",
        extensionMode = ExtensionMode.HDR,
        alwaysShow = true,
    )

    object Bokeh : CameraViewExtensionMode(
        label = "Portrait",
        extensionMode = ExtensionMode.BOKEH,
        blocksManualControls = true,
        alwaysShow = true,
    )

    object Night : CameraViewExtensionMode(
        label = "Night",
        extensionMode = ExtensionMode.NIGHT,
        alwaysShow = true,
    )
}