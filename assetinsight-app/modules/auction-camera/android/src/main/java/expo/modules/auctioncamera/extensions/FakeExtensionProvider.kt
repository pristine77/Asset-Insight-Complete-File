package expo.modules.auctioncamera.extensions


object FakeExtensionProvider {
    const val FORCE_FAKE = false
    val fakeAvailable: List<CameraExtensionMode> = listOf(
        CameraExtensionMode.Normal,
        CameraExtensionMode.HDR,
        CameraExtensionMode.Normal,
    )
}