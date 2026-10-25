package expo.modules.auctioncamera.model

data class ImageEffectPreset(
    val contrast:  Int = 0,
    val color:     Int = 0,
    val sharpness: Int = 0,
) {
    companion object {
        val NEUTRAL  = ImageEffectPreset(0,   0,   0)
        val LOW      = ImageEffectPreset(20,  25,  20)
        val MODERATE = ImageEffectPreset(45,  55,  45)
        val HEAVY    = ImageEffectPreset(75,  90,  70)
    }
}