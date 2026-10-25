package expo.modules.auctioncamera.ui.base

import android.content.Context
import android.content.res.Configuration
import androidx.appcompat.app.AppCompatActivity

/**
 * Base Activity that gives every subclass two permanent fixes:
 *
 * 1. FONT SIZE LOCK
 *    The user's "Font size" accessibility setting is ignored.
 *    Text never overflows containers regardless of system font scale.
 *
 * 2. CORRECT LANDSCAPE LAYOUT ON ROTATION
 *    res/layout-land/ is correctly selected after rotation.
 */
abstract class BaseActivity : AppCompatActivity() {

    override fun applyOverrideConfiguration(overrideConfig: Configuration) {
        overrideConfig.fontScale = 1.0f
        super.applyOverrideConfiguration(overrideConfig)
    }

    override fun attachBaseContext(base: Context) {
        val config = Configuration(base.resources.configuration).apply {
            fontScale = 1.0f
        }
        super.attachBaseContext(base.createConfigurationContext(config))
    }
}
