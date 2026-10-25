package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Persists the user's last-applied Pro settings to SharedPreferences so they
 * survive app restarts. The ViewModel loads these on first launch and saves
 * them every time the user presses "Save" or adjusts any control.
 *
 * Key design decisions:
 * - One global "last used" record (not per-lot). The per-lot map in the ViewModel
 *   continues to handle lot-specific overrides during a session; this store only
 *   provides the startup default.
 * - All values match the ProSettings data class fields exactly so serialisation
 *   is trivial: one SharedPreferences key per field, no JSON required.
 */
object ProSettingsStore {

    private const val PREFS_NAME   = "pro_settings_global"
    private const val KEY_ISO_PROG = "iso_progress"
    private const val KEY_SS_PROG  = "shutter_progress"
    private const val KEY_FPS_MIN  = "fps_min"
    private const val KEY_FPS_MAX  = "fps_max"
    private const val KEY_WB_LABEL = "wb_label"
    private const val KEY_WB_INDEX = "wb_index"
    private const val KEY_CONTRAST = "contrast"
    private const val KEY_COLOR    = "color"
    private const val KEY_SHARPNESS= "sharpness"
    private const val KEY_HAS_DATA = "has_saved_data"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Returns true only when the user has ever saved custom settings. */
    fun hasSavedSettings(ctx: Context): Boolean =
        prefs(ctx).getBoolean(KEY_HAS_DATA, false)

    /**
     * Load the last persisted ProSettings. Returns null if the user has never
     * saved custom settings (caller should use defaults in that case).
     */
    fun load(ctx: Context): ProSettings? {
        val p = prefs(ctx)
        if (!p.getBoolean(KEY_HAS_DATA, false)) return null
        return ProSettings(
            isoProgress     = p.getInt(KEY_ISO_PROG, 0),
            shutterProgress = p.getInt(KEY_SS_PROG,  0),
            fpsMin          = p.getInt(KEY_FPS_MIN,  30),
            fpsMax          = p.getInt(KEY_FPS_MAX,  30),
            wbLabel         = p.getString(KEY_WB_LABEL, "Auto") ?: "Auto",
            wbIndex         = p.getInt(KEY_WB_INDEX, 0),
            contrast        = p.getInt(KEY_CONTRAST, 0),
            color           = p.getInt(KEY_COLOR,    0),
            sharpness       = p.getInt(KEY_SHARPNESS, 0)
        )
    }

    /** Persist the current ProSettings. Call this every time settings change. */
    fun save(ctx: Context, settings: ProSettings) {
        prefs(ctx).edit {
            putBoolean(KEY_HAS_DATA,  true)
            putInt(KEY_ISO_PROG,      settings.isoProgress)
            putInt(KEY_SS_PROG,       settings.shutterProgress)
            putInt(KEY_FPS_MIN,       settings.fpsMin)
            putInt(KEY_FPS_MAX,       settings.fpsMax)
            putString(KEY_WB_LABEL,   settings.wbLabel)
            putInt(KEY_WB_INDEX,      settings.wbIndex)
            putInt(KEY_CONTRAST,      settings.contrast)
            putInt(KEY_COLOR,         settings.color)
            putInt(KEY_SHARPNESS,     settings.sharpness)
        }
    }

    /** Wipe persisted settings back to defaults (called from Reset button). */
    fun clear(ctx: Context) {
        prefs(ctx).edit { clear() }
    }
}
