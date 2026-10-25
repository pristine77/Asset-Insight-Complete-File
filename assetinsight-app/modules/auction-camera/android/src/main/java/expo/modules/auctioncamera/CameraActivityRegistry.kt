package expo.modules.auctioncamera

import android.app.Activity
import java.lang.ref.WeakReference

/** Main-thread identity tracking, including permission prompts, gallery and rotation. */
object CameraActivityRegistry {
    private val activities = mutableMapOf<String, WeakReference<Activity>>()
    fun attach(id: String?, activity: Activity) { if (id != null) activities[id] = WeakReference(activity) }
    fun detach(id: String?, activity: Activity) {
        if (id != null && activities[id]?.get() === activity) activities.remove(id)
    }
    fun contains(id: String): Boolean = activities[id]?.get()?.let { !it.isDestroyed && !it.isFinishing } == true
    fun hasActiveCamera(): Boolean = activities.keys.toList().any { contains(it) }
}
