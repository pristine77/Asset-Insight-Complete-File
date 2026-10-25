package expo.modules.auctioncamera

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.auctioncamera.ui.camera.CameraViewActivity

/**
 * EXPO NATIVE MODULE ENTRY POINT
 * This class bridges React Native (JavaScript) with the native Android Camera OS.
 */
class AuctionCameraModule : Module() {

    companion object {
        const val EXTRA_LOT_PAYLOAD_JSON      = "lot_payload_json"
    }

    private val cameraLaunchGate = CameraLaunchGate<Promise>()
    private var initialPayload: String = ""
    private var uploader: ContentUriUploader? = null
    private val main = Handler(Looper.getMainLooper())
    private val handoffIo = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var launchWatch: Runnable? = null

    private fun stopLaunchWatch() { launchWatch?.let { main.removeCallbacks(it) }; launchWatch = null }

    private fun failLaunch(launch: CameraLaunchGate.Claim<Promise>, code: String, message: String, error: Exception? = null) {
        if (!cameraLaunchGate.release(launch)) return
        stopLaunchWatch()
        launch.receiver.reject(code, message, error)
        appContext.reactContext?.let { context -> runCatching { CameraPayloadStore.discard(context, launch.handoffId) } }
        // No journal/original cleanup. A late I/O writer also fences its own transport.
    }

    private fun watchLaunch(launch: CameraLaunchGate.Claim<Promise>) {
        val watch = CameraLaunchWatch(SystemClock.elapsedRealtime())
        val check = object : Runnable {
            override fun run() {
                if (cameraLaunchGate.peek() !== launch) return
                val now = SystemClock.elapsedRealtime()
                val present = CameraActivityRegistry.contains(launch.handoffId)
                val context = appContext.reactContext
                // A fast open/Done can happen entirely between monitor ticks.
                // Its completed receipt proves return even when 'seen' is false.
                val receiptReady = !present && context != null && CameraPayloadStore.hasResult(context, launch.handoffId)
                if (watch.expired(now, present) || receiptReady) {
                    // Android can return to RN without delivering onActivityResult.
                    // Recover the exact receipt when present; never start another camera.
                    val json = context?.let { runCatching { CameraPayloadStore.result(it,
                        Intent().putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, launch.handoffId), launch.handoffId) }.getOrNull() }
                    if (json != null && cameraLaunchGate.release(launch)) {
                        stopLaunchWatch(); launch.receiver.resolve(json)
                        context?.let { runCatching { CameraPayloadStore.discard(it, launch.handoffId) } }
                    } else failLaunch(launch, "E_CAMERA_INTERRUPTED", "The camera did not open or its return was interrupted. Your draft and camera journal are kept. Close and retry or recover this draft.")
                    return
                }
                main.postDelayed(this, 1_000)
            }
        }
        stopLaunchWatch(); launchWatch = check; main.postDelayed(check, 1_000)
    }

    override fun definition() = ModuleDefinition {
        Name("AuctionCameraModule")
        AsyncFunction("getCameraCapabilities") { mapOf("lockedStructure" to true, "launchRecovery" to true) }
        AsyncFunction("cancelCameraLaunch") { id: String ->
            if (CameraActivityRegistry.contains(id)) false
            else {
                cameraLaunchGate.cancelBeforeStart(id)
                cameraLaunchGate.peek()?.takeIf { it.handoffId == id }?.let {
                    failLaunch(it, "E_CAMERA_INTERRUPTED", "Camera opening was cancelled. Your saved draft and capture journal are unchanged.")
                }
                true
            }
        }.runOnQueue(Queues.MAIN)
        Events("uploadProgress")
        AsyncFunction("getContentUriInfo") { value: String ->
            val context = appContext.reactContext ?: error("Application context unavailable")
            val uri = android.net.Uri.parse(value)
            require(uri.scheme == "content" && uri.authority == "media") { "Only device media references are supported" }
            try {
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
                    var length = descriptor.length
                    if (length < 0) context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst() && !cursor.isNull(0)) length = cursor.getLong(0)
                    }
                    mapOf("exists" to true, "size" to length, "type" to context.contentResolver.getType(uri))
                } ?: mapOf("exists" to false)
            } catch (_: java.io.FileNotFoundException) { mapOf("exists" to false) }
              catch (_: SecurityException) { mapOf("exists" to false) }
        }
        AsyncFunction("getPendingCapture") { owner: String, draft: String ->
            val context = appContext.reactContext ?: error("Application context unavailable")
            CaptureJournal.read(context, owner, draft)?.also { journal ->
                val scope = org.json.JSONObject().put("ownerId", owner).put("draftId", draft).put("sessionId", journal.getString("sessionId"))
                journal.put("pendingPhotoCount", expo.modules.auctioncamera.viewextensions.PendingPhotoStore.pending(context, scope, includeFailed = true).size)
            }?.toString()
        }
        AsyncFunction("acknowledgeCapture") { owner: String, draft: String, session: String, revision: Long ->
            CaptureJournal.acknowledge(appContext.reactContext ?: error("Application context unavailable"), owner, draft, session, revision)
        }
        AsyncFunction("uploadContentUri") { id: String, uri: String, url: String, headers: Map<String, String>, size: Long, promise: Promise ->
            val transfer = uploader ?: ContentUriUploader(appContext.reactContext ?: error("Application context unavailable")) { requestId, sent, total ->
                sendEvent("uploadProgress", mapOf("id" to requestId, "bytesSent" to sent, "totalBytes" to total))
            }.also { uploader = it }
            transfer.upload(id, uri, url, headers, size, promise)
        }
        AsyncFunction("cancelContentUriUpload") { id: String -> uploader?.cancel(id) }
        OnDestroy {
            uploader?.close(); uploader = null
            main.post {
                cameraLaunchGate.peek()?.let { failLaunch(it, "E_CAMERA_INTERRUPTED", "Camera connection closed; reopen the original draft to recover media.") }
                stopLaunchWatch()
            }
            handoffIo.shutdown()
        }

// Receives the serialized JSON string of existing lots/photos from React Native
        AsyncFunction("setInitialPayload") { payload: String, promise: Promise ->
            this@AuctionCameraModule.initialPayload = payload
            promise.resolve(null)
        }

       // ── async function exposed to JS ──────────────────────────────────────
        // Launches the full-screen native CameraViewActivity
        AsyncFunction("openAuctionCamera") { payload: String?, requestedId: String?, promise: Promise ->
            val launchStartMs = SystemClock.elapsedRealtime()
            val activity = appContext.activityProvider?.currentActivity
                ?: run {
                    promise.reject("E_NO_ACTIVITY", "No current Activity found", null)
                    return@AsyncFunction
                }

            if (CameraActivityRegistry.hasActiveCamera()) {
                promise.reject("E_CAMERA_BUSY", "The camera is still open. Return to that capture before opening another.", null)
                return@AsyncFunction
            }
            val launch = cameraLaunchGate.claim(promise, requestedId ?: java.util.UUID.randomUUID().toString()) ?: run {
                promise.reject("E_CAMERA_BUSY", "The camera is already open. Finish the current capture first.", null)
                return@AsyncFunction
            }

            val effectivePayload = payload ?: initialPayload
            initialPayload = ""
            watchLaunch(launch)
            handoffIo.execute {
                try {
                    val handoffId = CameraPayloadStore.prepare(activity, effectivePayload.ifEmpty { "[]" }, launch.handoffId)
                    main.post {
                        if (cameraLaunchGate.peek() !== launch) {
                            runCatching { CameraPayloadStore.discard(activity, launch.handoffId) }
                            return@post
                        }
                        try {
                            check(!activity.isFinishing && !activity.isDestroyed && appContext.activityProvider?.currentActivity === activity) { "Report activity changed before camera launch" }
                            val intent = Intent(activity, CameraViewActivity::class.java)
                                .putExtra(CameraPayloadStore.EXTRA_HANDOFF_ID, handoffId)
                            Log.d("AuctionCameraTiming", "launch payloadBytes=${effectivePayload.length} prepMs=${SystemClock.elapsedRealtime() - launchStartMs}")
                            activity.startActivityForResult(intent, launch.requestCode)
                        } catch (error: Exception) {
                            failLaunch(launch, "E_CAMERA_LAUNCH", "The camera could not open. Your saved draft and photos are unchanged. Try again.", error)
                        }
                    }
                } catch (error: Exception) {
                    main.post { failLaunch(launch, "E_CAMERA_LAUNCH", "The camera could not prepare its saved draft. Free storage and retry; your originals are unchanged.", error) }
                }
            }
        }.runOnQueue(Queues.MAIN)

       // ── handle the Activity result ────────────────────────────────────────
        // When the user taps "Done" in the native UI, this passes the updated JSON back to JS
        OnActivityResult { _, payload ->
            val launch = cameraLaunchGate.peek()?.takeIf { it.requestCode == payload.requestCode } ?: return@OnActivityResult
            val receiptId = payload.data?.getStringExtra(CameraPayloadStore.EXTRA_HANDOFF_ID)
            if (receiptId != null && receiptId != launch.handoffId) return@OnActivityResult
            if (!cameraLaunchGate.release(launch)) return@OnActivityResult
            stopLaunchWatch()
            val promise = launch.receiver
            val handoffId = launch.handoffId
            val context = appContext.reactContext
            try {
                if (payload.resultCode == Activity.RESULT_OK) {
                    val json = CameraPayloadStore.result(context ?: error("Application context unavailable"), payload.data, handoffId)
                    Log.d("AuctionCameraTiming", "activity_result payloadBytes=${json.length}")
                    promise.resolve(json)
                } else if (payload.data?.getStringExtra(CameraPayloadStore.EXTRA_ERROR_CODE) != null) {
                    promise.reject("E_CAMERA_INPUT", "The camera could not restore this draft. Your saved photos are unchanged.", null)
                } else {
                    promise.reject("E_CANCELLED", "User cancelled the camera", null)
                }
            } catch (error: Exception) {
                promise.reject("E_CAMERA_RESULT", "Captured photos remain saved on this device. Reopen this draft to recover the camera capture.", error)
            } finally {
                // Journal recovery survives even if JS is interrupted before saving.
                if (context != null) runCatching { CameraPayloadStore.discard(context, handoffId) }
            }
        }
    }
}
