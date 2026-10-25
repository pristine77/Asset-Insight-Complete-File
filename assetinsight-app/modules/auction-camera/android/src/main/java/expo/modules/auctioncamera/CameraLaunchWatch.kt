package expo.modules.auctioncamera

/** A startup deadline is not an inspection deadline. Rotation gets a return grace period. */
class CameraLaunchWatch(private val startedAt: Long) {
    private var seen = false
    private var lastPresent = startedAt
    fun expired(now: Long, activityPresent: Boolean): Boolean {
        if (activityPresent) { seen = true; lastPresent = now; return false }
        return if (seen) now - lastPresent >= 2_000 else now - startedAt >= 20_000
    }
}
