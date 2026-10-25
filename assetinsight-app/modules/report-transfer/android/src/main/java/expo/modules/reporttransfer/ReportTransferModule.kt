package expo.modules.reporttransfer

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class ReportTransferModule : Module() {
    private fun context() = appContext.reactContext?.applicationContext ?: error("Application context unavailable")
    override fun definition() = ModuleDefinition {
        Name("ReportTransfer")
        Function("getCapabilities") { mapOf("version" to 1, "durable" to true, "uidt" to (Build.VERSION.SDK_INT >= 34)) }
        AsyncFunction("configure") { value: Map<String, Any?> -> TransferCoordinator.configure(context(), JSONObject(value)) }
        AsyncFunction("enqueue") { value: Map<String, Any?> -> TransferCoordinator.enqueue(context(), JSONObject(value)) }
        AsyncFunction("list") { owner: String -> TransferCoordinator.list(context(), owner) }
        AsyncFunction("pause") { owner: String, draft: String -> TransferCoordinator.pause(context(), owner, draft) }
        AsyncFunction("resume") { owner: String, draft: String, grant: Map<String, Any?>? -> TransferCoordinator.resume(context(), owner, draft, grant?.let { JSONObject(it) }) }
        AsyncFunction("forget") { owner: String, draft: String -> TransferCoordinator.forget(context(), owner, draft) }
        AsyncFunction("deactivate") { TransferCoordinator.deactivate(context()) }
        // Work deliberately outlives React destruction and form closure.
    }
}
