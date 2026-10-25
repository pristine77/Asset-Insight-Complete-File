package expo.modules.auctioncamera.viewextensions

import android.content.Context

object OutputQualityStore {
    private const val PREF_NAME = "camera_output_quality"
    private const val KEY_12MP  = "use_12mp_output"

    fun save(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_12MP, enabled).apply()
    }

    fun load(context: Context): Boolean =
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_12MP, false)       // default OFF
}
