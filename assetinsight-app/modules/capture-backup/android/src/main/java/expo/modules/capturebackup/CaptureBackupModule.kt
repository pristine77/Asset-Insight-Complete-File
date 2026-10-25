package expo.modules.capturebackup

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class CaptureBackupModule : Module() {
    private fun context() = appContext.reactContext?.applicationContext ?: error("Application context unavailable")
    override fun definition() = ModuleDefinition {
        Name("CaptureBackup")
        AsyncFunction("configure") { value: Map<String, Any?> -> BackupCoordinator.configure(context(), JSONObject(value)) }
        AsyncFunction("enqueue") { value: Map<String, Any?> -> BackupCoordinator.enqueue(context(), JSONObject(value)) }
        AsyncFunction("pause") { ownerId: String, draftId: String, reason: String? -> BackupCoordinator.pause(context(), ownerId, draftId, reason ?: "user_pause") }
        AsyncFunction("resume") { ownerId: String, draftId: String -> BackupCoordinator.resume(context(), ownerId, draftId) }
        AsyncFunction("list") { ownerId: String -> BackupCoordinator.list(context(), ownerId) }
        AsyncFunction("deactivate") { BackupCoordinator.deactivate(context()) }
        // No OnDestroy cancellation: durable backups intentionally outlive React and the form.
    }
}
