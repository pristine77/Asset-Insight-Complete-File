package expo.modules.auctioncamera.viewextensions

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.RectF
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.OrientationEventListener
import android.view.Surface
import androidx.annotation.OptIn
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.auctioncamera.WhiteBalance
import expo.modules.auctioncamera.ZoomSlot
import expo.modules.auctioncamera.controls.AeFpsController
import expo.modules.auctioncamera.engine.LensManager
import expo.modules.auctioncamera.model.DeviceLimits
import expo.modules.auctioncamera.model.ManualConfig
import expo.modules.auctioncamera.utils.Camera2Helper
import expo.modules.auctioncamera.utils.CameraProfiler
import expo.modules.auctioncamera.utils.ManualControls
import expo.modules.auctioncamera.utils.CameraPhotoWatermark
import expo.modules.auctioncamera.utils.CameraVideoStorage
import expo.modules.auctioncamera.utils.PhotoWatermarkReceipt
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.pow

/*
 * Standard Android photo policy: owner-supplied MozJPEG optimization, 2026-10-22.
 *
 * Standard photos keep their aspect ratio, are never enlarged, and have at most
 * 2400 pixels on the longest side. JPEG targets 200 KiB with MozJPEG quality
 * 60, stepping down to 40; WebP/AVIF still target 300 KiB. These are encoding targets,
 * not hard byte caps. The 12 MP option retains its separate 6000 px / 1 MiB policy.
 *
 * The iOS/JS camera retains its separate 3000 px / JPEG 95 policy. High-resolution
 * Android JPEG retains the existing encoder and 6000 px / 1 MiB policy.
 */
internal const val STANDARD_PHOTO_MAX_SIDE = 2400
internal const val STANDARD_PHOTO_MAX_JPEG_BYTES = 200 * 1024
internal const val STANDARD_PHOTO_MAX_OTHER_BYTES = 300 * 1024
internal const val STANDARD_PHOTO_MOZJPEG_QUALITY = 60

internal fun mozJpegQualityForTarget(quality: Int, size: Int, target: Int): Int {
    require(target > 0)
    if (size <= target || quality <= 40) return quality
    val steps = kotlin.math.ceil(kotlin.math.ln(size.toDouble() / target) / 0.02).toInt()
    return (quality - steps).coerceIn(40, quality - 1)
}

/** The size that fits width x height inside boxWidth x boxHeight, keeping the shape and never enlarging. */
internal fun fitInsideBox(width: Int, height: Int, boxWidth: Int, boxHeight: Int): Pair<Int, Int> {
    if (width <= 0 || height <= 0) return Pair(width, height)
    val scale = minOf(1.0, boxWidth.toDouble() / width, boxHeight.toDouble() / height)
    if (scale >= 1.0) return Pair(width, height)
    return Pair(
        Math.round(width * scale).toInt().coerceAtLeast(1),
        Math.round(height * scale).toInt().coerceAtLeast(1)
    )
}

class CameraViewEngine(private val context: Context, private val lifecycleOwner: LifecycleOwner) {

    companion object {
        private const val TAG = "CameraViewEngine"
        private const val MIN_RECORDING_MS = 1000L
        private const val SURFACE_WARMUP = 600L
    }

    private var pendingEV = 0f
    private val thumbCache = android.util.LruCache<String, android.graphics.Bitmap>(8)
    private var torchEnabled = false
    private var pendingContrast = 0
    private var pendingColor = 0
    private var pendingSharpness = 0
    private var outputFormat: ImageFormatStore.Format = ImageFormatStore.Format.JPEG
    private var use12MPOutput: Boolean = false
    var onCameraRebound: (() -> Unit)? = null
    var onZoomChanged: ((Float, Float, Float) -> Unit)? = null
    var onPhotoCaptured: ((Uri) -> Unit)? = null
    var onPhotoProcessed: ((Uri, Uri, Int, Int) -> Unit)? = null
    var onVideoRecordingStarted: (() -> Unit)? = null
    var onVideoFinalizing: ((Uri) -> Unit)? = null
    var onVideoRecorded: ((Uri) -> Boolean)? = null
    var onRecordingError: ((String) -> Unit)? = null
    var onVideoReady: (() -> Unit)? = null
    var onEVChanged: ((Float) -> Unit)? = null
    var onTrueMinZoomDetected: ((Float) -> Unit)? = null
    var onDeviceLimitsReady: ((DeviceLimits?) -> Unit)? = null
    var onFpsRangesReady: ((List<Range<Int>>) -> Unit)? = null
    var onExtensionsReady: ((List<CameraViewExtensionMode>) -> Unit)? = null
    var onExtensionModeChanged: ((CameraViewExtensionMode) -> Unit)? = null
    var onManualConflictResolved: ((String) -> Unit)? = null
    var onNightModeComplete: (() -> Unit)? = null
    var onNightModeUriReady: ((Uri) -> Unit)? = null
    var onNightModeError: ((String) -> Unit)? = null
    private var lensFacing = CameraSelector.LENS_FACING_BACK
    private lateinit var preview: Preview
    private lateinit var imageCapture: ImageCapture
    private lateinit var videoCapture: VideoCapture<Recorder>
    private lateinit var camera: Camera
    private lateinit var orientationListener: OrientationEventListener
    private var recording: Recording? = null
    private var isStopping = false
    private var currentLensLabel = "Wide"
    private var manualConfig = ManualConfig()
    private var currentRotation = Surface.ROTATION_0
    private var deviceLimits: DeviceLimits? = null
    private var pendingResSelector: ResolutionSelector? = null
    private var activeExtensionMode: CameraViewExtensionMode = CameraViewExtensionMode.Normal
    private var savedManualConfig: ManualConfig? = null
    private var trueMinZoom = 1f
    private var trueMinZoomReady = false
    private var uwCameraId: String? = null
    private var wideCameraId: String? = null
    private var teleCameraId: String? = null
    private var currentCameraId: String? = null
    private var cachedProvider: ProcessCameraProvider? = null
    private var isVideoReady = false
    private var isVideoMode = false
    private var videoBindingRevision = 0L
    private var firstFrameConfirmed = false
    private var recordingStartMs = 0L
    private var currentZoomRatio = 1f
    private var isNightMode = false
    var previewViewWidth = 0
    var previewViewHeight = 0

    @Volatile
    private var probeActive = false
    private var currentFlashMode = ImageCapture.FLASH_MODE_OFF
    private val mainHandler = Handler(Looper.getMainLooper())
    private var cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    // One bounded, activity-independent photo processing lane.
    private var processingExecutor: ExecutorService = PhotoWorkQueue.executor
    private var captureIdentity: org.json.JSONObject? = null
    private var deliveryRevision = 0L
    var onCaptureSaved: ((CaptureTicket) -> Unit)? = null
    var onQueuedPhotoReady: ((Uri, CaptureTicket) -> Boolean)? = null
    var onQueuedPhotoSettled: ((CaptureTicket, String?) -> Unit)? = null
    var onQueuedCaptureError: ((CaptureTicket, String) -> Unit)? = null
    private val enqueuedShots = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun setCaptureIdentity(value: org.json.JSONObject?, revision: Long = 0) {
        captureIdentity = value?.let { org.json.JSONObject(it.toString()) }; deliveryRevision = revision
    }
    fun hasPendingPhotos() = captureIdentity?.let { PendingPhotoStore.pending(context, it, includeFailed = true).isNotEmpty() } ?: false
    fun resumePendingPhotos(retryCompleted: Boolean = false) {
        val identity = captureIdentity ?: return
        for (frame in PendingPhotoStore.pending(context, identity, includeFailed = true)) {
            if (retryCompleted && (frame.data.has("result") || frame.data.optBoolean("failed")) && !PhotoWorkQueue.contains(frame.ticket.id)) enqueuedShots.remove(frame.ticket.id)
            if (!PhotoWorkQueue.contains(frame.ticket.id) && PhotoWorkQueue.activeCount() >= 3) continue
            if (enqueuedShots.add(frame.ticket.id)) {
                onCaptureSaved?.invoke(frame.ticket)
                queueFrame(frame)
            }
        }
    }

    private fun queueFrame(frame: PendingPhotoStore.Frame) {
        PhotoWorkQueue.enqueue(frame, work = work@{
            // A killed process may already have produced the finished bytes.
            // Validate that exact local output before reusing its saved receipt.
            frame.data.optJSONObject("result")?.let { saved ->
                val uri = Uri.parse(saved.optString("uri"))
                val output = uri.path?.let { File(it) }
                if (uri.scheme == "file" && output?.isFile == true &&
                    output.canonicalPath.startsWith(File(context.filesDir, "camera-photos").canonicalPath + File.separator) &&
                    PhotoWatermarkReceipt.has(output.readBytes())) return@work saved
            }
            val result = processCapturedFile(frame.raw, frame.data.getJSONObject("options"), keepInput = true)
                ?: error("Photo encoding failed")
            org.json.JSONObject().put("uri", result.uri.toString()).put("width", result.width).put("height", result.height)
        }, commit = { result -> onQueuedPhotoReady?.invoke(Uri.parse(result.getString("uri")), frame.ticket) == true },
            finish = { error -> onQueuedPhotoSettled?.invoke(frame.ticket, error) }, receiverRevision = deliveryRevision)
    }

    private fun captureOptions() = org.json.JSONObject().put("format", outputFormat.name).put("highResolution", use12MPOutput)
        .put("previewWidth", previewViewWidth).put("previewHeight", previewViewHeight).put("contrast", pendingContrast)
        .put("color", pendingColor).put("sharpness", pendingSharpness).also { options -> activeCropRect?.let {
            options.put("crop", org.json.JSONArray(listOf(it.left, it.top, it.right, it.bottom)))
        } }
    var suppressGalleryCopy = false
    private var autoFlashEnabled = false
    private val lotPhotosDir: File by lazy {
        File(context.cacheDir, "lot_photos").apply { mkdirs() }
    }

    @Volatile
    private var isCameraBinding = false
    private var isPreviewBound = false

    var activeCropRect: RectF? = null
    var onPreviewFilterChanged: ((contrast: Int, color: Int) -> Unit)? = null
    fun isFrontCamera() = lensFacing == CameraSelector.LENS_FACING_FRONT
    fun isStopping() = isStopping
    fun hasUltraWideLens() = uwCameraId != null || trueMinZoom < 0.95f
    fun hasTeleLens() = teleCameraId != null
    fun getTrueMinZoom() = trueMinZoom
    fun getCurrentLensLabel() = currentLensLabel
    fun getCamera() = if (::camera.isInitialized) camera else null
    fun getMaxZoomRatio() =
        if (::camera.isInitialized) camera.cameraInfo.zoomState.value?.maxZoomRatio ?: 1f else 1f

    fun isEVSupported() = ::camera.isInitialized && ExposureViewController.isSupported(camera)
    fun getExposureRange() =
        if (::camera.isInitialized) ExposureViewController.getEVRange(camera) else null

    fun isManualSupported() = deviceLimits?.supportsManualSensor == true
    fun isRecording() = recording != null || isStopping
    fun hasFlash() = ::camera.isInitialized && camera.cameraInfo.hasFlashUnit()
    fun getActiveExtensionMode() = activeExtensionMode

    fun getPendingContrast() = pendingContrast
    fun getPendingColor() = pendingColor
    private fun reapplyTorch() {
        if (!::imageCapture.isInitialized) return
        imageCapture.flashMode = when {
            torchEnabled -> ImageCapture.FLASH_MODE_ON
            autoFlashEnabled -> ImageCapture.FLASH_MODE_AUTO
            else -> ImageCapture.FLASH_MODE_OFF
        }
    }

    fun setImageEffects(contrast: Int, color: Int, sharpness: Int) {
        pendingContrast = contrast
        pendingColor = color
        pendingSharpness = sharpness
        // Camera2-level sharpness/WB applied to hardware pipeline (affects preview + capture)
        applyCombinedCaptureOptions(manualConfig.whiteBalance, contrast, color, sharpness)
        // GPU layer filter for contrast/color — shows instantly in preview
        mainHandler.post { onPreviewFilterChanged?.invoke(contrast, color) }
        Log.d(TAG, "Effects set: contrast=$contrast color=$color sharpness=$sharpness")
    }

    // Public setter called from the Activity:
    fun set12MPOutput(enabled: Boolean) {
        use12MPOutput = enabled
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun applyCombinedCaptureOptions(
        wb: WhiteBalance,
        contrast: Int,
        color: Int,
        sharpness: Int
    ) {
        if (!::camera.isInitialized) return

//        // Protect OEM Extensions (like Portrait/Bokeh) from being overwritten by manual controls
//        if (activeExtensionMode !is CameraViewExtensionMode.Normal && !activeExtensionMode.isSoftware) {
//            Log.d(TAG, "Skipping manual capture options. OEM Extension active: ${activeExtensionMode.label}")
//            return
//        }

        if (activeExtensionMode.blocksManualControls) {
            Log.d(
                TAG,
                "Skipping manual capture options. Mode blocks manual controls: ${activeExtensionMode.label}"
            )
            return
        }

        try {
            val c2 = Camera2CameraControl.from(camera.cameraControl)

            val edgeMode = when {
                sharpness > 50 -> CameraMetadata.EDGE_MODE_HIGH_QUALITY
                sharpness > 10 -> CameraMetadata.EDGE_MODE_FAST
                sharpness < -10 -> CameraMetadata.EDGE_MODE_OFF
                else -> CameraMetadata.EDGE_MODE_FAST
            }
            val noiseMode = when {
                sharpness < -10 -> CameraMetadata.NOISE_REDUCTION_MODE_HIGH_QUALITY
                else -> CameraMetadata.NOISE_REDUCTION_MODE_FAST
            }

            val builder = CaptureRequestOptions.Builder()
            ManualControls.applyToBuilder(builder, effectiveManualConfig())

            val flashReq = when {
                torchEnabled -> CameraMetadata.FLASH_MODE_TORCH
                autoFlashEnabled -> CameraMetadata.FLASH_MODE_SINGLE
                else -> CameraMetadata.FLASH_MODE_OFF
            }
            val aeMode = when {
                autoFlashEnabled -> CameraMetadata.CONTROL_AE_MODE_ON_AUTO_FLASH
                else -> CameraMetadata.CONTROL_AE_MODE_ON
            }

            builder.setCaptureRequestOption(CaptureRequest.CONTROL_AWB_MODE, wb.awbMode)
                .setCaptureRequestOption(CaptureRequest.EDGE_MODE, edgeMode)
                .setCaptureRequestOption(CaptureRequest.NOISE_REDUCTION_MODE, noiseMode)
                .setCaptureRequestOption(CaptureRequest.FLASH_MODE, flashReq)
                .setCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE, aeMode)

            c2.captureRequestOptions = builder.build()

            Log.d(
                TAG,
                "WB+effects applied: ${wb.label} awb=${wb.awbMode} edge=$edgeMode noise=$noiseMode"
            )
        } catch (e: Exception) {
            Log.e(TAG, "applyCombinedCaptureOptions failed: ${e.message}")
        }
    }

    private fun applyWBDirect(wb: WhiteBalance) {
        if (!::camera.isInitialized) return
        applyCombinedCaptureOptions(wb, pendingContrast, pendingColor, pendingSharpness)
        Log.d(TAG, "WB applied: ${wb.label} (awbMode=${wb.awbMode})")
    }

    fun updatePreviewSurface(previewView: PreviewView) {
        // 1. Use post to ensure the view has been laid out and attached to the window
        previewView.post {
            if (::preview.isInitialized) {
                // 2. Grab the actual rotation of the display right now
                val displayRotation =
                    previewView.display?.rotation ?: android.view.Surface.ROTATION_0
                currentRotation = displayRotation

                // 3. Tell the Preview use case that the screen has rotated
                preview.targetRotation = displayRotation

                // 4. Tell the ImageCapture use case so your saved photos don't come out sideways
                if (::imageCapture.isInitialized) {
                    imageCapture.targetRotation = displayRotation
                }

                // 5. Finally, route the video feed to the new UI surface
                preview.setSurfaceProvider(previewView.surfaceProvider)
            }
        }
    }

    fun getUltraWideLabel() = "0.6"
    fun getTeleLabel(): String {
        val tele = teleCameraId ?: return "4"
        val wide = wideCameraId ?: return "4"
        return try {
            val mgr = cameraManager()
            val tF = mgr.focalMin(tele) ?: return "4"
            val wF = mgr.focalMin(wide) ?: return "4"
            "${(tF / wF).toInt().coerceAtLeast(2)}"
        } catch (e: Exception) {
            "4"
        }
    }

    init {
        setupOrientationListener()
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
        currentRotation =
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                context.display?.rotation ?: Surface.ROTATION_0
            } else {
                @Suppress("DEPRECATION")
                wm.defaultDisplay.rotation
            }
    }

    fun setInitialExtensionMode(mode: CameraViewExtensionMode) {
        activeExtensionMode = mode
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Photo
    // ─────────────────────────────────────────────────────────────────────────

    fun startPhoto(previewView: PreviewView) = startPhotoWithExtension(previewView)

    private fun startPhotoWithExtension(previewView: PreviewView) {
        isVideoMode = false
        isVideoReady = false
        videoBindingRevision++
        ensureExecutorAlive()
        isCameraBinding = true

        if (activeExtensionMode !is CameraViewExtensionMode.Normal) {
            currentLensLabel = "Wide"
            currentCameraId = wideCameraId
        } else {
            currentLensLabel = "Wide"
            currentCameraId = wideCameraId
        }
        withProvider { provider ->
            val selector = resolveSelector()
            if (!isPreviewBound) {
                preview =
                    buildPreview(false).also { it.setSurfaceProvider(previewView.surfaceProvider) }
                provider.unbindAll()
            } else {
                if (::imageCapture.isInitialized) {
                    runCatching { provider.unbind(imageCapture) }
                }

                //  Ensures if we rebind, we use the active UI surface
                if (::preview.isInitialized) {
                    preview.setSurfaceProvider(previewView.surfaceProvider)
                }
            }

            imageCapture = buildImageCapture()

            try {
                camera = provider.bindToLifecycle(
                    lifecycleOwner, selector, preview, imageCapture
                )
                isPreviewBound = true
                reapplyTorch()
                if (wideCameraId == null && lensFacing == CameraSelector.LENS_FACING_BACK)
                    detectPhysicalLensIds()
                observeCamera()
                if (isNightMode) {
                    mainHandler.postDelayed({
                        if (::camera.isInitialized) {
                            camera.cameraControl.setZoomRatio(1f)
                            Log.d(TAG, "Night mode: forced zoom reset to 1f after rebind")
                        }
                    }, 300)
                }
                isCameraBinding = false
                mainHandler.post { onCameraRebound?.invoke() }
            } catch (e: Exception) {
                Log.e(TAG, "Bind failed (${activeExtensionMode.label}): ${e.message} — fallback")
                isPreviewBound = false
                val failedName = activeExtensionMode.label
                activeExtensionMode = CameraViewExtensionMode.Normal
                savedManualConfig?.let { manualConfig = it; savedManualConfig = null }

                if (!::preview.isInitialized) {
                    preview =
                        buildPreview(false).also { it.setSurfaceProvider(previewView.surfaceProvider) }
                }
                provider.unbindAll()
                try {
                    camera = provider.bindToLifecycle(
                        lifecycleOwner, backOrFrontSelector(), preview, imageCapture
                    )
                    isPreviewBound = true
                    reapplyTorch()
                } catch (e2: Exception) {
                    Log.e(TAG, "Fallback also failed: ${e2.message}")
                }
                observeCamera()
                isCameraBinding = false
                mainHandler.post {
                    onCameraRebound?.invoke()
                    onExtensionModeChanged?.invoke(CameraViewExtensionMode.Normal)
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Video
    // ─────────────────────────────────────────────────────────────────────────

    fun startVideo(previewView: PreviewView) {
        ensureExecutorAlive()
        isVideoMode = true
        isVideoReady = false
        firstFrameConfirmed = false
        val bindingRevision = ++videoBindingRevision
        withProvider { provider ->
            if (bindingRevision != videoBindingRevision || !isVideoMode) return@withProvider
            preview = buildPreview(true).also { it.setSurfaceProvider(previewView.surfaceProvider) }
            videoCapture = ListingVideoProfile.buildCapture(currentRotation)

            rebindSafely(provider) {
                try {
                    camera = provider.bindToLifecycle(
                        lifecycleOwner,
                        backOrFrontSelector(),
                        preview,
                        videoCapture,
                    )
                    ListingVideoProfile.requireSupported(camera.cameraInfo)
                    ListingVideoProfile.requireBoundProfile(videoCapture)
                    currentLensLabel = "Wide"
                    camera.cameraControl.setZoomRatio(1f)
                    observeCamera()
                    mainHandler.postDelayed({
                        if (bindingRevision == videoBindingRevision && isVideoMode && ::videoCapture.isInitialized) {
                            isVideoReady = true
                            mainHandler.post { onVideoReady?.invoke() }
                        }
                    }, SURFACE_WARMUP)
                } catch (e: Exception) {
                    Log.e(TAG, "startVideo failed: ${e.message}")
                    isVideoReady = false
                    mainHandler.post { onRecordingError?.invoke(ListingVideoProfile.UNSUPPORTED_MESSAGE) }
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Extensions
    // ─────────────────────────────────────────────────────────────────────────

    fun probeExtensions(previewView: PreviewView, isPhotoMode: Boolean) {
        mainHandler.postDelayed({
            ExtensionViewAvailabilityManager.initialize(context, lensFacing) { available ->
                Log.d(TAG, "Extensions probed: ${available.map { it.label }}")
                mainHandler.post { onExtensionsReady?.invoke(available) }
            }
        }, 800)
    }

    fun setExtensionMode(
        mode: CameraViewExtensionMode,
        previewView: PreviewView,
        isPhotoMode: Boolean,
    ) {
        if (mode is CameraViewExtensionMode.Normal) {
            savedManualConfig?.let { manualConfig = it; savedManualConfig = null }
        } else {
            val result = ExtensionViewConflictResolver.resolve(manualConfig, mode)
            if (result.hadConflict) {
                savedManualConfig = manualConfig
                manualConfig = result.safeConfig
                result.reason?.let { mainHandler.post { onManualConflictResolved?.invoke(it) } }
            }
        }
        activeExtensionMode = mode
        if (isPhotoMode) startPhotoWithExtension(previewView) else startVideo(previewView)
        mainHandler.post { onExtensionModeChanged?.invoke(mode) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Resolution
    // ─────────────────────────────────────────────────────────────────────────

    fun setResolution(resolution: String, previewView: PreviewView, isPhotoMode: Boolean) {
        val strategy = when (resolution) {
            "200M" -> ResolutionStrategy(
                Size(16384, 12288),
                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
            )

            "50M" -> ResolutionStrategy(
                Size(8192, 6144),
                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
            )

            else -> ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY
        }
        pendingResSelector = ResolutionSelector.Builder().setResolutionStrategy(strategy).build()
        if (isPhotoMode) startPhoto(previewView) else startVideo(previewView)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capture routing
    // ─────────────────────────────────────────────────────────────────────────

    fun capturePhoto(ticket: CaptureTicket? = null) {
        if (!::imageCapture.isInitialized || !::camera.isInitialized) {
            // Settle the accepted shutter request instead of leaving its native
            // busy indicator and navigation guard waiting for a callback forever.
            mainHandler.post {
                onRecordingError?.invoke("The camera is still starting. Please try taking the photo again.")
            }
            return
        }
        Log.d(
            "CAPTURE_ROUTE",
            "capturePhoto called — isNightMode=$isNightMode activeMode=${activeExtensionMode.label}"
        )

        val frame = if (ticket != null && captureIdentity != null)
            PendingPhotoStore.create(context, captureIdentity!!, ticket, captureOptions().put("outputId", ticket.id)) else null
        try {
            when {
                isNightMode -> captureNight(frame)
                activeExtensionMode is CameraViewExtensionMode.Bokeh -> captureBokeh(frame)
                else -> captureToFile(frame)
            }
        } catch (failure: Exception) {
            // An explicit shutter failure is not an accepted photo. Retain any
            // bytes CameraX may have written rather than guessing they are disposable.
            frame?.let { runCatching { PendingPhotoStore.failed(it) } }
            captureFailed(frame, "Capture could not start. Please try again.")
        }
    }

    private fun captureFailed(frame: PendingPhotoStore.Frame?, message: String) {
        frame?.let { runCatching { PendingPhotoStore.failed(it) } }
        mainHandler.post {
            if (frame != null) onQueuedCaptureError?.invoke(frame.ticket, message) else onRecordingError?.invoke(message)
        }
    }

    fun setOutputFormat(format: ImageFormatStore.Format) {
        outputFormat = format
    }

    private data class ProcessedCapture(val uri: Uri, val width: Int, val height: Int)

    private fun publishCapturedFile(file: File, night: Boolean = false, frame: PendingPhotoStore.Frame? = null) {
        if (frame != null) {
            // The raw frame and immutable owner/lot/settings receipt must both
            // be durable before the next shutter is allowed. Never publish raw URI.
            try {
                enqueuedShots.add(frame.ticket.id)
                java.io.RandomAccessFile(file, "rw").use { it.fd.sync() }
                PendingPhotoStore.ready(frame)
                mainHandler.post { onCaptureSaved?.invoke(frame.ticket); queueFrame(frame) }
            } catch (_: Exception) { captureFailed(frame, "Photo frame could not be saved. Free storage and reopen this draft; any written bytes are kept.") }
            return
        }
        processingExecutor.execute {
            val result = processCapturedFile(file)
            mainHandler.post {
                if (result == null) {
                    if (night) onNightModeError?.invoke("Photo processing failed. Please take the photo again.")
                    else onRecordingError?.invoke("Photo processing failed. Please take the photo again.")
                } else {
                    if (night) {
                        onNightModeComplete?.invoke()
                        onNightModeUriReady?.invoke(result.uri)
                    } else onPhotoCaptured?.invoke(result.uri)
                    onPhotoProcessed?.invoke(result.uri, result.uri, result.width, result.height)
                }
            }
        }
    }

    private fun processCapturedFile(file: File): ProcessedCapture? = processCapturedFile(file, captureOptions())

    private fun processCapturedFile(file: File, options: org.json.JSONObject, keepInput: Boolean = false): ProcessedCapture? {
        val outputFormat = ImageFormatStore.Format.valueOf(options.getString("format"))
        val use12MPOutput = options.getBoolean("highResolution")
        val previewViewWidth = options.getInt("previewWidth")
        val previewViewHeight = options.getInt("previewHeight")
        val pendingContrast = options.getInt("contrast")
        val pendingColor = options.getInt("color")
        val pendingSharpness = options.getInt("sharpness")
        val activeCropRect = options.optJSONArray("crop")?.let { RectF(it.getDouble(0).toFloat(), it.getDouble(1).toFloat(), it.getDouble(2).toFloat(), it.getDouble(3).toFloat()) }
        // ── Determine output format and derive file extension / MIME ─────────
        val fmt = if (outputFormat == ImageFormatStore.Format.AVIF &&
            runCatching { android.graphics.Bitmap.CompressFormat.valueOf("AVIF") }.getOrNull() == null
        ) ImageFormatStore.Format.JPEG else outputFormat
        val extension = when (fmt) {
            ImageFormatStore.Format.WEBP -> "webp"
            ImageFormatStore.Format.AVIF -> "avif"
            else -> "jpg"
        }
        val mimeType = when (fmt) {
            ImageFormatStore.Format.WEBP -> "image/webp"
            ImageFormatStore.Format.AVIF -> "image/avif"
            else -> "image/jpeg"
        }

        val outputId = options.optString("outputId").takeIf { it.matches(Regex("[0-9a-f-]{36}")) } ?: java.util.UUID.randomUUID().toString()
        val outputFile = File(File(context.filesDir, "camera-photos").apply { mkdirs() }, "photo_$outputId.$extension")

        // -- Target file-size budget ----------------------------------------------
        //   12 MP option on: 1 MB.
        //   Standard JPEG: approximately 200 KiB. Standard WebP/AVIF: 300 KiB.
        //   Metadata and the watermark receipt may exceed the encoding target.
        val TARGET_SIZE_BYTES = when {
            use12MPOutput -> 1 * 1024 * 1024             // 1 MB when 12MP is ON
            fmt == ImageFormatStore.Format.JPEG -> STANDARD_PHOTO_MAX_JPEG_BYTES
            else -> STANDARD_PHOTO_MAX_OTHER_BYTES
        }

        try {
            // ── 1. Rotate upright from EXIF ───────────────────────────────────
            val originalExif = androidx.exifinterface.media.ExifInterface(file.path)
            val orientation = originalExif.getAttributeInt(
                androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
                androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL
            )
            val rotation = when (orientation) {
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeFile(file.path, bounds)
            val cropFraction = minOf(activeCropRect?.width() ?: 1f, activeCropRect?.height() ?: 1f).coerceIn(0.01f, 1f)
            val needed = (if (use12MPOutput) 6000 else STANDARD_PHOTO_MAX_SIDE) / cropFraction
            val decode = android.graphics.BitmapFactory.Options().apply {
                inSampleSize = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / (inSampleSize * 2) >= needed * 1.5f) inSampleSize *= 2
            }
            val raw = android.graphics.BitmapFactory.decodeFile(file.path, decode) ?: throw IllegalStateException("Unable to decode capture")

            var bitmap = if (rotation != 0f) {
                val matrix = android.graphics.Matrix().apply { postRotate(rotation) }
                val rotated = android.graphics.Bitmap.createBitmap(
                    raw, 0, 0, raw.width, raw.height, matrix, true
                )
                raw.recycle()
                rotated
            } else {
                raw
            }

            // ── 2. Aspect-ratio centre-crop to match preview (unchanged) ──────
            if (previewViewWidth > 0 && previewViewHeight > 0) {
                val previewRatio = previewViewWidth.toFloat() / previewViewHeight.toFloat()
                val bitmapRatio = bitmap.width.toFloat() / bitmap.height.toFloat()

                if (Math.abs(previewRatio - bitmapRatio) > 0.001f) {
                    var newW = bitmap.width
                    var newH = bitmap.height
                    if (bitmapRatio > previewRatio) {
                        newW = (bitmap.height * previewRatio).toInt()
                    } else {
                        newH = (bitmap.width / previewRatio).toInt()
                    }
                    val x = (bitmap.width - newW) / 2
                    val y = (bitmap.height - newH) / 2
                    try {
                        val cropped = android.graphics.Bitmap.createBitmap(bitmap, x, y, newW, newH)
                        if (cropped !== bitmap) {
                            bitmap.recycle(); bitmap = cropped
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Aspect ratio crop failed: ${e.message}")
                    }
                }
            }

            // ── 3. Box-focus crop (unchanged) ─────────────────────────────────
            activeCropRect?.let { crop ->
                val imgW = bitmap.width.toFloat()
                val imgH = bitmap.height.toFloat()
                val safeX = (imgW * crop.left).toInt().coerceIn(0, bitmap.width - 1)
                val safeY = (imgH * crop.top).toInt().coerceIn(0, bitmap.height - 1)
                val safeW = (imgW * crop.width()).toInt().coerceIn(1, bitmap.width - safeX)
                val safeH = (imgH * crop.height()).toInt().coerceIn(1, bitmap.height - safeY)
                try {
                    val cropped =
                        android.graphics.Bitmap.createBitmap(bitmap, safeX, safeY, safeW, safeH)
                    if (cropped !== bitmap) {
                        bitmap.recycle(); bitmap = cropped
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Box crop failed: ${e.message}")
                }
            }

            // ── 4. Pro effects: contrast / colour / sharpness (unchanged) ─────
            if (pendingContrast != 0 || pendingColor != 0 || pendingSharpness != 0) {
                bitmap = applyBitmapEffects(
                    bitmap,
                    contrast = pendingContrast,
                    color = pendingColor,
                    sharpness = pendingSharpness
                )
            }

            // -- 6. Resize -------------------------------------------------------------
            // Preserve orientation and aspect ratio with a 2400 px longest side.
            // The 12 MP option keeps its 6000 px longest side; neither is enlarged.
            val (targetW, targetH) = if (use12MPOutput) {
                fitInsideBox(bitmap.width, bitmap.height, 6000, 6000)
            } else {
                fitInsideBox(bitmap.width, bitmap.height, STANDARD_PHOTO_MAX_SIDE, STANDARD_PHOTO_MAX_SIDE)
            }
            if (targetW != bitmap.width || targetH != bitmap.height) {
                val resized = android.graphics.Bitmap.createScaledBitmap(bitmap, targetW, targetH, true)
                if (resized !== bitmap) { bitmap.recycle(); bitmap = resized }
                Log.d(TAG, "Resized to ${targetW}x${targetH} (12MP=${use12MPOutput})")
            }

            // Stamp once AFTER all capture crops/resizing, independent of upload opt-in.
            bitmap = CameraPhotoWatermark.stamp(context, bitmap)

            // ── 7. Compress to RAM then flush to disk once ────────────────────
            val stream = java.io.ByteArrayOutputStream()
            when (fmt) {
                ImageFormatStore.Format.JPEG -> {
                    // Preserve the high-resolution encoder; optimize standard JPEGs only.
                    var mozJpegQuality = STANDARD_PHOTO_MOZJPEG_QUALITY
                    var mozJpeg = if (use12MPOutput) null else
                        expo.modules.auctioncamera.compression.MozJpegEncoder.encode(bitmap, mozJpegQuality)
                    if (mozJpeg != null && mozJpeg.size > TARGET_SIZE_BYTES && mozJpegQuality > 40) {
                        mozJpegQuality = mozJpegQualityForTarget(mozJpegQuality, mozJpeg.size, TARGET_SIZE_BYTES)
                        // At most two encodes; keep the first result if retry fails.
                        mozJpeg = expo.modules.auctioncamera.compression.MozJpegEncoder.encode(bitmap, mozJpegQuality) ?: mozJpeg
                    }
                    if (mozJpeg != null) {
                        stream.write(mozJpeg)
                    } else {
                        // Unavailable/unsupported native encoder: retain the Android ladder.
                        var currentQuality = 95
                        bitmap.compress(
                            android.graphics.Bitmap.CompressFormat.JPEG,
                            currentQuality,
                            stream
                        )
                        while (stream.size() > TARGET_SIZE_BYTES && currentQuality > 50) {
                            stream.reset()
                            currentQuality -= 10
                            bitmap.compress(
                                android.graphics.Bitmap.CompressFormat.JPEG,
                                currentQuality,
                                stream
                            )
                        }
                    }
                }

                ImageFormatStore.Format.WEBP -> {
                    // Lossy WebP. WEBP_LOSSY is available API 14+.
                    // Quality ladder mirrors the JPEG path so file stays ≤ 200 KB.
                    @Suppress("DEPRECATION")
                    val webpFormat =
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R)
                            android.graphics.Bitmap.CompressFormat.WEBP_LOSSY
                        else
                            android.graphics.Bitmap.CompressFormat.WEBP

                    // Start lower and step faster if 12MP is ON ──
                    // 12MP has so much data that 75% WebP looks flawless but saves us from looping 4 times.
                    var currentQuality = if (use12MPOutput) 80 else 90
                    val step = if (use12MPOutput) 15 else 10
                    bitmap.compress(webpFormat, currentQuality, stream)
                    while (stream.size() > TARGET_SIZE_BYTES && currentQuality > 40) {
                        stream.reset()
                        currentQuality -= step
                        bitmap.compress(webpFormat, currentQuality, stream)
                    }
                    Log.d(
                        TAG, "WebP compressed at quality $currentQuality, " +
                                "${stream.size() / 1024} KB"
                    )
                }

                ImageFormatStore.Format.AVIF -> {


                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                        // ── FIX: AVIF is very heavy. Start at 70 for 12MP. ──
                        var currentQuality = if (use12MPOutput) 80 else 90
                        val step = if (use12MPOutput) 15 else 10

                        // Use valueOf to avoid direct reference if the compiler is stubborn
                        val avifFormat = try {
                            android.graphics.Bitmap.CompressFormat.valueOf("AVIF")
                        } catch (e: Exception) {
                            null
                        }

                        if (avifFormat != null) {
                            bitmap.compress(avifFormat, currentQuality, stream)
                            while (stream.size() > TARGET_SIZE_BYTES && currentQuality > 40) {
                                stream.reset()
                                currentQuality -= step
                                bitmap.compress(avifFormat, currentQuality, stream)
                            }
                        } else {
                            // Final fallback if AVIF enum isn't found despite API 31+
                            //  If the phone falls back to JPEG, we STILL must loop it to hit the target! ──
                            var fallbackQuality = 85
                            bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, fallbackQuality, stream)
                            while (stream.size() > TARGET_SIZE_BYTES && fallbackQuality > 40) {
                                stream.reset()
                                fallbackQuality -= 15
                                bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, fallbackQuality, stream)
                            }
                        }
                    }

                    // AVIF requires API 31 (Android 12). ImageFormatStore.save() already
                    // falls back to WEBP on older devices so this branch only runs on API 31+.
//                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
//                        var currentQuality = 80   // AVIF at 80 is visually indistinguishable from JPEG 95
//                        bitmap.compress(
//                            android.graphics.Bitmap.CompressFormat.AVIF,
//                            currentQuality, stream
//                        )
//                        while (stream.toByteArray().size > TARGET_SIZE_BYTES && currentQuality > 40) {
//                            stream.reset()
//                            currentQuality -= 10
//                            bitmap.compress(
//                                android.graphics.Bitmap.CompressFormat.AVIF,
//                                currentQuality, stream
//                            )
//                        }
//                        Log.d(TAG, "AVIF compressed at quality $currentQuality, " +
//                                "${stream.toByteArray().size / 1024} KB")
//                    } else {
//                        // Safety fallback (should never happen — see ImageFormatStore.save())
//                        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, stream)
//                    }
                }
            }

            val finalWidth = bitmap.width
            val finalHeight = bitmap.height

            outputFile.outputStream().use { out ->
                stream.writeTo(out)
                out.flush()
            }
            stream.close()
            bitmap.recycle()

//            // ── 8. EXIF copy (JPEG only — WebP/AVIF do not use EXIF) ──────────
//            if (fmt == ImageFormatStore.Format.JPEG) {
//                val newExif = androidx.exifinterface.media.ExifInterface(outputFile.path)
//                copyExifAttributes(originalExif, newExif)
//                newExif.setAttribute(
//                    androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
//                    androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL.toString()
//                )
//                newExif.saveAttributes()
//            }

            // ── 8. EXIF copy (Apply to all formats) ──────────
            try {
                val newExif = androidx.exifinterface.media.ExifInterface(outputFile.path)
                copyExifAttributes(originalExif, newExif)

                // Set the orientation to Normal since we already rotated the pixels
                newExif.setAttribute(
                    androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL.toString()
                )

                // Update EXIF with the new cropped/resized dimensions
                newExif.setAttribute(
                    androidx.exifinterface.media.ExifInterface.TAG_IMAGE_WIDTH,
                    finalWidth.toString()
                )
                newExif.setAttribute(
                    androidx.exifinterface.media.ExifInterface.TAG_IMAGE_LENGTH,
                    finalHeight.toString()
                )

                newExif.saveAttributes()
            } catch (e: UnsupportedOperationException) {
                // Some older versions of the Exif library might throw this on AVIF files.
                Log.w(
                    TAG,
                    "Writing EXIF to $extension is not fully supported on this device/library version."
                )
            } catch (e: Exception) {
                Log.e(TAG, "Failed to save EXIF: ${e.message}")
            }

            // Bind only the finished bytes, after EXIF, before any gallery/draft handoff.
            outputFile.writeBytes(PhotoWatermarkReceipt.add(outputFile.readBytes()))
            java.io.RandomAccessFile(outputFile, "rw").use { it.fd.sync() }

            // Keep the encoded extension/MIME aligned, including AVIF->JPEG fallback.
            // No caller ever saw the raw capture URI, so only the finished file is published.
            val galleryUri = saveToUserGallery(outputFile, mimeType)
            val finalGalleryUri = galleryUri ?: Uri.fromFile(outputFile)
            if (!keepInput && galleryUri != null) outputFile.delete()
            if (!keepInput) file.delete()
            return ProcessedCapture(if (keepInput) Uri.fromFile(outputFile) else finalGalleryUri, finalWidth, finalHeight)

        } catch (e: Exception) {
            Log.e(TAG, "Processing failed: ${e.message}")
            return null
        }
    }

    private fun applyBitmapEffects(
        src: android.graphics.Bitmap,
        contrast: Int,
        color: Int,
        sharpness: Int
    ): android.graphics.Bitmap {
        return try {
            var current = src

            if (contrast != 0 || color != 0) {
                val cm = android.graphics.ColorMatrix()

                if (contrast != 0) {
                    val scale = 1f + (contrast.toFloat() / 100f).coerceIn(-0.9f, 1.5f)
                    val translate = 128f * (1f - scale)
                    cm.postConcat(
                        android.graphics.ColorMatrix(
                            floatArrayOf(
                                scale, 0f, 0f, 0f, translate,
                                0f, scale, 0f, 0f, translate,
                                0f, 0f, scale, 0f, translate,
                                0f, 0f, 0f, 1f, 0f
                            )
                        )
                    )
                }

                if (color != 0) {
                    val sat = (1f + (color.toFloat() / 100f) * 1.5f).coerceAtLeast(0f)
                    val satMatrix = android.graphics.ColorMatrix()
                    satMatrix.setSaturation(sat)
                    cm.postConcat(satMatrix)
                }

                // Draw the ORIGINAL src pixels through the filter into a FRESH bitmap.
                // Previous bug: drew result onto itself → original + filtered blended = doubled effect.
                val filtered = android.graphics.Bitmap.createBitmap(
                    src.width, src.height, android.graphics.Bitmap.Config.ARGB_8888
                )
                android.graphics.Canvas(filtered).drawBitmap(
                    src, 0f, 0f,
                    android.graphics.Paint().apply {
                        colorFilter = android.graphics.ColorMatrixColorFilter(cm)
                        isAntiAlias = true
                    }
                )
                if (current !== src) current.recycle()
                current = filtered
            }

            val finalResult = if (sharpness != 0) {
                val sharpened = applySharpness(current, sharpness)
                if (sharpened !== current && current !== src) current.recycle()
                sharpened
            } else {
                current
            }

            if (finalResult !== src) src.recycle()
            finalResult

        } catch (e: Exception) {
            Log.w(TAG, "applyBitmapEffects failed: ${e.message}")
            src
        }
    }

    private fun applySharpness(
        src: android.graphics.Bitmap,
        sharpness: Int
    ): android.graphics.Bitmap {
        val strength = sharpness.toFloat() / 100f
        return try {
            val config = src.config ?: android.graphics.Bitmap.Config.ARGB_8888

            if (strength > 0) {
                val blurRadius = 1.5f + strength * 2f
                val blurred = android.graphics.Bitmap.createBitmap(src.width, src.height, config)
                val blurPaint = android.graphics.Paint().apply {
                    maskFilter = android.graphics.BlurMaskFilter(
                        blurRadius,
                        android.graphics.BlurMaskFilter.Blur.NORMAL
                    )
                }
                android.graphics.Canvas(blurred).drawBitmap(src, 0f, 0f, blurPaint)

                val result = src.copy(config, true)
                val canvas = android.graphics.Canvas(result)

                val alpha = (strength * 200).toInt().coerceIn(0, 200)
                val subPaint = android.graphics.Paint().apply {
                    xfermode =
                        android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.DARKEN)
                    this.alpha = alpha
                }
                canvas.drawBitmap(src, 0f, 0f, android.graphics.Paint())
                blurred.recycle()
                result

            } else {
                val blurRadius = (-strength) * 3f
                val result = android.graphics.Bitmap.createBitmap(src.width, src.height, config)
                val softPaint = android.graphics.Paint().apply {
                    maskFilter = android.graphics.BlurMaskFilter(
                        blurRadius.coerceAtLeast(0.5f),
                        android.graphics.BlurMaskFilter.Blur.NORMAL
                    )
                }
                android.graphics.Canvas(result).drawBitmap(src, 0f, 0f, softPaint)
                result
            }
        } catch (e: Exception) {
            Log.w(TAG, "applySharpness failed: ${e.message}")
            src
        }
    }

    private fun saveToUserGallery(file: File, mimeType: String = "image/jpeg"): Uri? {
        return try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                val cv = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, file.name)
                    put(MediaStore.Images.Media.MIME_TYPE, mimeType)
                    put(MediaStore.Images.Media.RELATIVE_PATH, "DCIM/Camera")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val uri = context.contentResolver.insert(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv
                ) ?: return null

                context.contentResolver.openOutputStream(uri)?.use { out ->
                    java.io.FileInputStream(file).use { it.copyTo(out) }
                }
                cv.clear()
                cv.put(MediaStore.Images.Media.IS_PENDING, 0)
                context.contentResolver.update(uri, cv, null, null)
                Log.d(TAG, "Photo saved to DCIM/Camera: ${file.name} [$mimeType]")

                uri
            } else {
                @Suppress("DEPRECATION")
                val dcim = android.os.Environment
                    .getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DCIM)
                val dest = File(File(dcim, "Camera").also { it.mkdirs() }, file.name)
                java.io.FileInputStream(file).use { it.copyTo(dest.outputStream()) }
                android.media.MediaScannerConnection.scanFile(
                    context, arrayOf(dest.absolutePath), arrayOf(mimeType), null
                )
                Log.d(TAG, "Photo saved to DCIM/Camera: ${file.name} [$mimeType]")
                Uri.fromFile(dest)
            }
        } catch (e: Exception) {
            Log.e(TAG, "saveToUserGallery failed: ${e.message}")
            null
        }
    }

    private fun copyExifAttributes(
        source: androidx.exifinterface.media.ExifInterface,
        dest: androidx.exifinterface.media.ExifInterface,
    ) {
        val tags = arrayOf(
            androidx.exifinterface.media.ExifInterface.TAG_MAKE,
            androidx.exifinterface.media.ExifInterface.TAG_MODEL,
            androidx.exifinterface.media.ExifInterface.TAG_DATETIME,
            androidx.exifinterface.media.ExifInterface.TAG_EXPOSURE_TIME,
            androidx.exifinterface.media.ExifInterface.TAG_F_NUMBER,
            androidx.exifinterface.media.ExifInterface.TAG_ISO_SPEED_RATINGS,
            androidx.exifinterface.media.ExifInterface.TAG_FOCAL_LENGTH,
            androidx.exifinterface.media.ExifInterface.TAG_WHITE_BALANCE,
            androidx.exifinterface.media.ExifInterface.TAG_FLASH,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_LATITUDE,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_LATITUDE_REF,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_LONGITUDE,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_LONGITUDE_REF,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_ALTITUDE,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_ALTITUDE_REF,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_TIMESTAMP,
            androidx.exifinterface.media.ExifInterface.TAG_GPS_DATESTAMP,
            androidx.exifinterface.media.ExifInterface.TAG_DIGITAL_ZOOM_RATIO,
            androidx.exifinterface.media.ExifInterface.TAG_EXPOSURE_PROGRAM,
            androidx.exifinterface.media.ExifInterface.TAG_APERTURE_VALUE,
            androidx.exifinterface.media.ExifInterface.TAG_SHUTTER_SPEED_VALUE,
            androidx.exifinterface.media.ExifInterface.TAG_SENSING_METHOD
        )

        for (tag in tags) {
            val value = source.getAttribute(tag)
            if (value != null) {
                dest.setAttribute(tag, value)
            }
        }
    }

    private fun captureToFile(frame: PendingPhotoStore.Frame? = null) {
        val captureStartMs = SystemClock.elapsedRealtime()
        CameraProfiler.beginSection("capture_photo")
        // --- Determine extension based on outputFormat ---
        val extension = when (outputFormat) {
            ImageFormatStore.Format.WEBP -> "webp"
            ImageFormatStore.Format.AVIF -> "avif"
            else -> "jpg"
        }
        val tempFile = frame?.raw ?: File(lotPhotosDir, "temp_photo_${java.util.UUID.randomUUID()}.$extension")
        val options = ImageCapture.OutputFileOptions.Builder(tempFile).build()

        imageCapture.takePicture(
            options, cameraExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    CameraProfiler.endSection("capture_photo")
                    Log.d(
                        "AuctionCameraTiming",
                        "image_saved extension=${activeExtensionMode.label} ms=${SystemClock.elapsedRealtime() - captureStartMs} bytes=${tempFile.length()}"
                    )

                    // Never expose an unprocessed/raw URI to drafts or upload.
                    publishCapturedFile(tempFile, frame = frame)
//                    cameraExecutor.execute {
//                        processCapturedFile(tempFile)
//                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    if (frame == null && tempFile.exists()) tempFile.delete()
                    CameraProfiler.endSection("capture_photo")
                    captureFailed(frame, "Capture failed: ${exception.message}")
                }
            }
        )
    }

    // ── Portrait / Bokeh capture ──────────────────────────────────────────────
    private fun captureBokeh(frame: PendingPhotoStore.Frame? = null) {
        Log.d("BOKEH_CAPTURE", "Starting Portrait capture")
        CameraProfiler.beginSection("capture_bokeh")
        // --- Determine extension based on outputFormat ---
        val extension = when (outputFormat) {
            ImageFormatStore.Format.WEBP -> "webp"
            ImageFormatStore.Format.AVIF -> "avif"
            else -> "jpg"
        }
        val tempFile = frame?.raw ?: File(lotPhotosDir, "temp_photo_${java.util.UUID.randomUUID()}.$extension")
        val options = ImageCapture.OutputFileOptions.Builder(tempFile).build()

        imageCapture.takePicture(
            options,
            cameraExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    CameraProfiler.endSection("capture_bokeh")
                    publishCapturedFile(tempFile, frame = frame)

//                    // 2. BACKGROUND PROCESSING: Do the heavy lifting in a background thread
//                    cameraExecutor.execute {
//                        processCapturedFile(tempFile)
//                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    if (frame == null && tempFile.exists()) tempFile.delete()
                    CameraProfiler.endSection("capture_bokeh")
                    Log.e("BOKEH_CAPTURE", "onError! msg=${exception.message}")
                    captureFailed(frame, "Portrait failed: ${exception.message}")
                }
            }
        )
    }

    // ── Night capture ─────────────────────────────────────────────────────────

    private fun captureNight(frame: PendingPhotoStore.Frame? = null) {
        CameraProfiler.beginSection("capture_night")
        // --- Determine extension based on outputFormat ---
        val extension = when (outputFormat) {
            ImageFormatStore.Format.WEBP -> "webp"
            ImageFormatStore.Format.AVIF -> "avif"
            else -> "jpg"
        }
        val tempFile = frame?.raw ?: File(lotPhotosDir, "temp_photo_${java.util.UUID.randomUUID()}.$extension")
        val options = ImageCapture.OutputFileOptions.Builder(tempFile).build()

        imageCapture.takePicture(
            options,
            cameraExecutor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    CameraProfiler.endSection("capture_night")
                    publishCapturedFile(tempFile, night = true, frame = frame)

//                    // 2. BACKGROUND PROCESSING: Do the heavy lifting in a background thread
//                    cameraExecutor.execute {
//                        processCapturedFile(tempFile)
//                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    if (frame == null && tempFile.exists()) tempFile.delete()
                    CameraProfiler.endSection("capture_night")
                    Log.e(TAG, "Night capture error: ${exception.message}")
                    if (frame != null) captureFailed(frame, "Night capture failed: ${exception.message}")
                    else mainHandler.post { onNightModeError?.invoke("Night capture failed: ${exception.message}") }
                }
            }
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Video recording — durable original, journalled before gallery publication/handoff.
    // ─────────────────────────────────────────────────────────────────────────

    fun startRecording() {
        if (!::videoCapture.isInitialized || !isVideoReady) {
            onRecordingError?.invoke("Camera not ready")
            return
        }
        if (isRecording()) return
        CameraProfiler.beginSection("video_recording")
        CameraProfiler.logMemory("video_start")
        val outputFile = try {
            ListingVideoProfile.requireSupported(camera.cameraInfo)
            ListingVideoProfile.requireBoundProfile(videoCapture)
            CameraVideoStorage.createOutputFile(context)
        } catch (error: Exception) {
            onRecordingError?.invoke(error.message ?: "Unable to prepare video recording.")
            return
        }
        recordingStartMs = System.currentTimeMillis()
        try {
            recording = videoCapture.output
            .prepareRecording(context, FileOutputOptions.Builder(outputFile).build())
            .apply {
                if (ContextCompat.checkSelfPermission(
                        context, Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED
                ) withAudioEnabled()
            }
            .start(ContextCompat.getMainExecutor(context)) { event ->
                when (event) {
                    is VideoRecordEvent.Start ->
                        mainHandler.post { onVideoRecordingStarted?.invoke() }

                    is VideoRecordEvent.Status ->
                        firstFrameConfirmed = true

                    is VideoRecordEvent.Finalize -> {
                        // Done/Next Lot stay locked until the durable original and final URI
                        // have both been handed to the current lot's metadata journal.
                        isStopping = true
                        recording = null
                        if (!event.hasError()) {
                            try {
                                onVideoFinalizing?.invoke(Uri.fromFile(outputFile))
                            } catch (error: Exception) {
                                isStopping = false
                                onRecordingError?.invoke("Video retained on this device. Tap Done again to save its lot details.")
                                return@start
                            }
                            ensureExecutorAlive()
                            cameraExecutor.execute {
                                val uri = CameraVideoStorage.publish(context, outputFile)
                                mainHandler.post {
                                    try {
                                        val journalSaved = onVideoRecorded?.invoke(uri) == true
                                        CameraVideoStorage.acknowledgeGalleryHandoff(context, outputFile, uri, journalSaved)
                                    } catch (error: Exception) {
                                        onRecordingError?.invoke("Video retained on this device. Tap Done again to save its lot details.")
                                    } finally {
                                        isStopping = false
                                    }
                                }
                            }
                        } else {
                            isStopping = false
                            suppressGalleryCopy = false
                            val reason = when (event.error) {
                                VideoRecordEvent.Finalize.ERROR_NO_VALID_DATA -> "Recording stopped too quickly."
                                VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE -> "Storage full."
                                VideoRecordEvent.Finalize.ERROR_ENCODING_FAILED -> "Encoder failed. Try reducing zoom."
                                else -> "Recording error (code ${event.error})."
                            }
                            outputFile.delete()
                            mainHandler.post { onRecordingError?.invoke(reason) }
                        }
                    }
                }
            }
        } catch (error: Exception) {
            isStopping = false
            recording = null
            outputFile.delete()
            onRecordingError?.invoke("Unable to start video recording. Check camera and microphone permissions.")
        }
    }

    fun stopRecording() {
        if (isStopping) return
        val elapsed = System.currentTimeMillis() - recordingStartMs
        val pending = recording ?: return
        isStopping = true
        recording = null
        if (!firstFrameConfirmed || elapsed < MIN_RECORDING_MS) {
            mainHandler.postDelayed(
                { pending.stop() },
                (MIN_RECORDING_MS - elapsed).coerceAtLeast(300L)
            )
            return
        }
        pending.stop()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Zoom
    // ─────────────────────────────────────────────────────────────────────────

    fun handleZoomSlot(previewView: PreviewView, slot: ZoomSlot, isPhotoMode: Boolean) {
        if (!::camera.isInitialized) return
        val state = camera.cameraInfo.zoomState.value
        val maxZoom = state?.maxZoomRatio ?: 10f
        val minZoom = state?.minZoomRatio ?: 1f
        fun zoomTo(ratio: Float) =
            camera.cameraControl.setZoomRatio(ratio.coerceIn(minZoom, maxZoom))

        if (activeExtensionMode is CameraViewExtensionMode.Bokeh) {
            val ratio = when (slot) {
                ZoomSlot.ULTRA_WIDE -> trueMinZoom
                ZoomSlot.WIDE -> 1f
                ZoomSlot.MID -> 2f
                ZoomSlot.TELE -> 4f
            }
            setZoom(ratio)
            return
        }

        if (isRecording()) {
            when (slot) {
                ZoomSlot.ULTRA_WIDE -> zoomTo(minZoom)
                ZoomSlot.WIDE -> zoomTo(1f)
                ZoomSlot.MID -> zoomTo(2f.coerceAtMost(maxZoom))
                ZoomSlot.TELE -> zoomTo(if (maxZoom >= 4f) 4f else maxZoom)
            }
            return
        }

        when (slot) {
            ZoomSlot.ULTRA_WIDE -> {
                when {
                    // FAST PATH: Logical camera supports seamless sub-1x zoom (S24 Ultra, Pixel, etc.)
                    // minZoom from the current logical camera already reaches 0.6x — use it directly.
                    // NEVER do a physical lens switch for this case; it causes a 1-2s freeze.
                    minZoom < 0.95f -> {
                        currentLensLabel = "UltraWide"
                        zoomTo(trueMinZoom)
                    }
                    // SLOW PATH: Old device where logical camera truly cannot reach UW zoom,
                    // so we must physically switch to the separate UW camera.
                    uwCameraId != null && currentCameraId != uwCameraId -> {
                        switchToPhysicalLens(
                            previewView,
                            uwCameraId!!,
                            "UltraWide",
                            1f,
                            isPhotoMode
                        )
                    }
                    // Fallback: just try to zoom to trueMinZoom
                    else -> {
                        currentLensLabel = "UltraWide"
                        zoomTo(trueMinZoom)
                    }
                }
            }

            ZoomSlot.WIDE -> {
                when {
                    // If we physically switched to UW camera, switch back to logical wide camera
                    uwCameraId != null && currentCameraId == uwCameraId && wideCameraId != null -> {
                        switchToPhysicalLens(previewView, wideCameraId!!, "Wide", 1f, isPhotoMode)
                    }
                    // Normal case: logical camera, just set zoom ratio
                    else -> {
                        currentLensLabel = "Wide"
                        zoomTo(1f)
                    }
                }
            }

            ZoomSlot.MID -> {
                when {
                    // If stuck on physical UW lens, switch back to logical wide first
                    uwCameraId != null && currentCameraId == uwCameraId && wideCameraId != null -> {
                        switchToPhysicalLens(previewView, wideCameraId!!, "Wide", 2f, isPhotoMode)
                    }

                    else -> {
                        currentLensLabel = "Wide"
                        zoomTo(2f.coerceAtMost(maxZoom))
                    }
                }
            }

            ZoomSlot.TELE -> {
                when {
                    // FAST PATH: Logical camera reaches 4x seamlessly
                    maxZoom >= 4f -> {
                        // If stuck on physical UW lens, switch back first
                        if (uwCameraId != null && currentCameraId == uwCameraId && wideCameraId != null) {
                            switchToPhysicalLens(
                                previewView,
                                wideCameraId!!,
                                "Wide",
                                4f,
                                isPhotoMode
                            )
                        } else {
                            currentLensLabel = "Wide"
                            zoomTo(4f)
                        }
                    }
                    // SLOW PATH: Requires physical tele lens switch
                    teleCameraId != null && currentCameraId != teleCameraId -> {
                        switchToPhysicalLens(
                            previewView,
                            teleCameraId!!,
                            "Telephoto",
                            1f,
                            isPhotoMode
                        )
                    }

                    else -> {
                        currentLensLabel = "Wide"
                        zoomTo(if (maxZoom >= 4f) 4f else maxZoom)
                    }
                }
            }
        }
    }

    /**
     * Returns true only when handleZoomSlot() will call switchToPhysicalLens()
     * for the given slot — meaning a full provider.unbindAll() + rebind will occur.
     *
     * Returns false for all logical setZoomRatio() calls (e.g. S24 Ultra 0.6x↔1x↔2x↔4x).
     * The activity uses this to decide whether to freeze the preview before calling handleZoomSlot.
     */
    fun requiresPhysicalLensSwitch(slot: ZoomSlot): Boolean {
        val maxZoom = getMaxZoomRatio().coerceAtMost(8f)
        val minZoom = getCamera()?.cameraInfo?.zoomState?.value?.minZoomRatio ?: 1f

        return when (slot) {
            ZoomSlot.ULTRA_WIDE -> {
                // Physical switch needed only if logical camera cannot reach sub-1x
                // AND we have a separate physical UW camera
                minZoom >= 0.95f && uwCameraId != null
            }

            ZoomSlot.WIDE -> {
                // Physical switch needed only if currently on a physically switched lens
                // (not a logical UW — logical UW just calls setZoomRatio back to 1f)
                val onPhysicalUW = currentLensLabel == "UltraWide" && minZoom >= 0.95f
                val onPhysicalTele = currentLensLabel == "Telephoto" && teleCameraId != null
                onPhysicalUW || onPhysicalTele
            }

            ZoomSlot.MID -> {
                // Physical switch needed only if currently on physical UW lens
                currentLensLabel == "UltraWide" && minZoom >= 0.95f
            }

            ZoomSlot.TELE -> {
                // Physical switch needed only if logical camera cannot reach 4x
                // AND we have a separate physical tele camera
                maxZoom < 4f && teleCameraId != null
            }
        }
    }


//
//    fun handleZoomSlot(previewView: PreviewView, slot: ZoomSlot, isPhotoMode: Boolean) {
//        if (!::camera.isInitialized) return
//        val state = camera.cameraInfo.zoomState.value
//        val maxZoom = state?.maxZoomRatio ?: 10f
//        val minZoom = state?.minZoomRatio ?: 1f
//        fun zoomTo(ratio: Float) =
//            camera.cameraControl.setZoomRatio(ratio.coerceIn(minZoom, maxZoom))
//
//        if (activeExtensionMode is CameraViewExtensionMode.Bokeh) {
//            val ratio = when (slot) {
//                ZoomSlot.ULTRA_WIDE -> trueMinZoom
//                ZoomSlot.WIDE -> 1f
//                ZoomSlot.MID -> 2f
//                ZoomSlot.TELE -> 4f
//            }
//            setZoom(ratio)
//            return
//        }
//
//        if (isRecording()) {
//            when (slot) {
//                ZoomSlot.ULTRA_WIDE -> zoomTo(minZoom)
//                ZoomSlot.WIDE -> zoomTo(1f)
//                ZoomSlot.MID -> zoomTo(2f.coerceAtMost(maxZoom))
//                ZoomSlot.TELE -> zoomTo(if (maxZoom >= 4f) 4f else maxZoom)
//            }
//            return
//        }
//
//        when (slot) {
//            ZoomSlot.ULTRA_WIDE -> when {
//                uwCameraId != null && currentCameraId != uwCameraId ->
//                    switchToPhysicalLens(previewView, uwCameraId!!, "UltraWide", 1f, isPhotoMode)
//
//                trueMinZoom < 0.95f -> {
//                    currentLensLabel = "UltraWide"; zoomTo(trueMinZoom)
//                }
//
//                else -> {}
//            }
//
//            ZoomSlot.WIDE -> when {
//                currentCameraId != null && currentCameraId != wideCameraId && wideCameraId != null ->
//                    switchToPhysicalLens(previewView, wideCameraId!!, "Wide", 1f, isPhotoMode)
//
//                else -> {
//                    currentLensLabel = "Wide"; zoomTo(1f)
//                }
//            }
//
//            ZoomSlot.MID -> {
//                if (currentCameraId != null && currentCameraId != wideCameraId && wideCameraId != null)
//                    switchToPhysicalLens(previewView, wideCameraId!!, "Wide", 2f, isPhotoMode)
//                else {
//                    currentLensLabel = "Wide"; zoomTo(2f.coerceAtMost(maxZoom))
//                }
//            }
//
//            ZoomSlot.TELE -> when {
//                teleCameraId != null && currentCameraId != teleCameraId ->
//                    switchToPhysicalLens(previewView, teleCameraId!!, "Telephoto", 1f, isPhotoMode)
//
//                else -> {
//                    currentLensLabel = "Wide"; zoomTo(if (maxZoom >= 4f) 4f else maxZoom)
//                }
//            }
//        }
//    }

    fun setZoom(requested: Float) {
        if (!::camera.isInitialized) return
        camera.cameraControl.setZoomRatio(
            requested.coerceIn(
                trueMinZoom,
                camera.cameraInfo.zoomState.value?.maxZoomRatio ?: 10f
            )
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Manual controls
    // ─────────────────────────────────────────────────────────────────────────

    fun setAutoMode(previewView: PreviewView, isPhotoMode: Boolean) {
        manualConfig = ManualConfig()
        rebindCurrentCamera(previewView, isPhotoMode)
    }

    fun setISO(iso: Int?, previewView: PreviewView, isPhotoMode: Boolean) {
        if (iso != null && !isManualSupported()) return
        val newConfig = manualConfig.copy(
            aeMode = if (iso != null || manualConfig.shutterSpeedNs != null)
                CaptureRequest.CONTROL_AE_MODE_OFF
            else
                CaptureRequest.CONTROL_AE_MODE_ON,
            iso = iso?.let {
                deviceLimits?.let { l -> it.coerceIn(l.minIso, l.maxIso) } ?: it
            }
        )
        val result = ExtensionViewConflictResolver.resolve(newConfig, activeExtensionMode)
        if (result.hadConflict) {
            result.reason?.let { mainHandler.post { onManualConflictResolved?.invoke(it) } }
            return
        }
        manualConfig = result.safeConfig
        if (::camera.isInitialized) ManualControls.applyDirect(camera, effectiveManualConfig())
    }

    fun setShutterSpeed(shutterNs: Long?, previewView: PreviewView, isPhotoMode: Boolean) {
        if (shutterNs != null && !isManualSupported()) return
        val newConfig = manualConfig.copy(
            aeMode = if (shutterNs != null || manualConfig.iso != null)
                CaptureRequest.CONTROL_AE_MODE_OFF
            else
                CaptureRequest.CONTROL_AE_MODE_ON,
            shutterSpeedNs = shutterNs?.let {
                deviceLimits?.let { l -> it.coerceIn(l.minShutterNs, l.maxShutterNs) } ?: it
            }
        )
        val result = ExtensionViewConflictResolver.resolve(newConfig, activeExtensionMode)
        if (result.hadConflict) {
            result.reason?.let { mainHandler.post { onManualConflictResolved?.invoke(it) } }
            return
        }
        manualConfig = result.safeConfig
        if (::camera.isInitialized) ManualControls.applyDirect(camera, effectiveManualConfig())
    }

    fun setFPSRange(min: Int, max: Int, previewView: PreviewView, isPhotoMode: Boolean) {
        val best = AeFpsController.getBestMatch(min, max)
        AeFpsController.setCustomRange(best.lower, best.upper)
        val newConfig = manualConfig.copy(aeFpsMin = best.lower, aeFpsMax = best.upper)
        val result = ExtensionViewConflictResolver.resolve(newConfig, activeExtensionMode)
        if (result.hadConflict) {
            result.reason?.let { mainHandler.post { onManualConflictResolved?.invoke(it) } }
            return
        }
        manualConfig = result.safeConfig
        if (::camera.isInitialized) ManualControls.applyDirect(camera, effectiveManualConfig())
    }

    @OptIn(ExperimentalCamera2Interop::class)
    fun setWhiteBalance(wb: WhiteBalance, previewView: PreviewView, isPhotoMode: Boolean) {
        val newConfig = manualConfig.copy(whiteBalance = wb)
        val result = ExtensionViewConflictResolver.resolve(newConfig, activeExtensionMode)
        if (result.hadConflict) {
            result.reason?.let { mainHandler.post { onManualConflictResolved?.invoke(it) } }
            return
        }
        manualConfig = result.safeConfig
        if (!::camera.isInitialized) return
        applyWBDirect(wb)
    }

    /*private fun applyWBDirect(wb: WhiteBalance) {
        if (!::camera.isInitialized) return
        applyCombinedCaptureOptions(wb, pendingContrast, pendingColor, pendingSharpness)
        applyPreviewEffects(pendingContrast, pendingColor, pendingSharpness)
        Log.d(TAG, "WB applied with effects: ${wb.label} (awbMode=${wb.awbMode})")
    }*/

    // 2. Update setExposureCompensation to save the pending value
    fun setExposureCompensation(ev: Float) {
        pendingEV = ev
        if (!::camera.isInitialized) return
        ExposureViewController.setEV(camera, ev)
        mainHandler.post { onEVChanged?.invoke(ev) }
    }

    fun setNightMode(enabled: Boolean) {
        isNightMode = enabled
    }

    fun switchCamera(previewView: PreviewView, isPhotoMode: Boolean) {
        isPreviewBound = false
        activeCropRect = null
        torchEnabled = false
        autoFlashEnabled = false
        probeActive = false
        currentLensLabel = "Wide"
        trueMinZoom = 1f
        trueMinZoomReady = false
        uwCameraId = null
        wideCameraId = null
        teleCameraId = null
        currentCameraId = null
        activeExtensionMode = CameraViewExtensionMode.Normal
        savedManualConfig = null
        LensManager.clearCache()
        ExtensionViewAvailabilityManager.reset()
        lensFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK)
            CameraSelector.LENS_FACING_FRONT
        else
            CameraSelector.LENS_FACING_BACK

        rebindCurrentCamera(previewView, isPhotoMode)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    private fun observeCamera() {
        camera.cameraInfo.zoomState.removeObservers(lifecycleOwner)
        camera.cameraInfo.zoomState.observe(lifecycleOwner) { s ->
            currentZoomRatio = s.zoomRatio
            mainHandler.post { onZoomChanged?.invoke(s.zoomRatio, s.minZoomRatio, s.maxZoomRatio) }
        }
        val isoR = Camera2Helper.getIsoRange(camera, context)
        val shutR = Camera2Helper.getExposureTimeRange(camera, context)
        val manual = Camera2Helper.supportsManualSensor(camera, context)
        deviceLimits = DeviceLimits(
            minIso = isoR?.lower ?: 50,
            maxIso = isoR?.upper ?: 3200,
            minShutterNs = shutR?.lower ?: 1_000_000L,
            maxShutterNs = shutR?.upper ?: 500_000_000L,
            supportsManualSensor = manual,
        )
        mainHandler.post {
            onDeviceLimitsReady?.invoke(deviceLimits)
            onFpsRangesReady?.invoke(AeFpsController.loadSupportedRanges(camera, context))
        }

        mainHandler.postDelayed({
            if (!::camera.isInitialized) return@postDelayed
            // FIX: Re-apply the user's pending EV to the hardware upon bind
            ExposureViewController.setEV(camera, pendingEV)
            onEVChanged?.invoke(pendingEV)
        }, 200)
//        mainHandler.postDelayed({
//            if (!::camera.isInitialized) return@postDelayed
//            val ev = ExposureViewController.getCurrentEV(camera)
//            onEVChanged?.invoke(ev)
//        }, 200)

        if (hasNonDefaultManualConfig()) {
            mainHandler.postDelayed({
                if (::camera.isInitialized) {
                    ManualControls.applyDirect(camera, effectiveManualConfig())
                    applyWBDirect(manualConfig.whiteBalance)
                    Log.d(TAG, "Restored manualConfig after rebind: $manualConfig")
                }
            }, 200)
        }

        if (!trueMinZoomReady) {
            probeActive = true
            mainHandler.postDelayed({
                if (!::camera.isInitialized || !probeActive) return@postDelayed
                val cxMin = camera.cameraInfo.zoomState.value?.minZoomRatio ?: 1f
                trueMinZoom = if (cxMin < 0.95f) cxMin else 1f
                trueMinZoomReady = true
                mainHandler.post { onTrueMinZoomDetected?.invoke(trueMinZoom) }
            }, 500)
        }
        if (pendingContrast != 0 || pendingColor != 0 || pendingSharpness != 0) {
            mainHandler.postDelayed({
                setImageEffects(
                    pendingContrast,
                    pendingColor,
                    pendingSharpness
                )
            }, 200)
        }
    }

    private fun hasNonDefaultManualConfig(): Boolean {
        return manualConfig.iso != null ||
                manualConfig.shutterSpeedNs != null ||
                manualConfig.whiteBalance != WhiteBalance.AUTO ||
                manualConfig.aeFpsMin != 30 ||
                manualConfig.aeFpsMax != 30
    }

    private fun effectiveManualConfig(): ManualConfig = if (isVideoMode) {
        manualConfig.copy(
            aeMode = CaptureRequest.CONTROL_AE_MODE_ON,
            iso = null,
            shutterSpeedNs = null,
            aeFpsMin = ListingVideoProfile.FRAMES_PER_SECOND,
            aeFpsMax = ListingVideoProfile.FRAMES_PER_SECOND,
        )
    } else manualConfig

    fun pause() {
        videoBindingRevision++
        isVideoReady = false
        isPreviewBound = false
        probeActive = false
        trueMinZoomReady = false
        currentCameraId = null
        currentLensLabel = "Wide"
        cachedProvider?.let { runCatching { it.unbindAll() } }
    }

    fun shutdown() {
        videoBindingRevision++
        isVideoReady = false
        probeActive = false
        if (::orientationListener.isInitialized) orientationListener.disable()
        recording?.stop()
        recording = null
        cameraExecutor.shutdown()
        // The shared serial worker owns durable queued shots across activities.
        try {
            if (!cameraExecutor.awaitTermination(2, TimeUnit.SECONDS))
                cameraExecutor.shutdownNow()
        } catch (e: InterruptedException) {
            cameraExecutor.shutdownNow()
        }
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun buildPreview(isVideo: Boolean = false): Preview {
        val builder = Preview.Builder()
            .setTargetRotation(currentRotation)
            // REMOVED the hardcoded ManualControls from Preview as well
            .also { if (!isVideo) pendingResSelector?.let { sel -> it.setResolutionSelector(sel) } }

        // Only apply Video Stabilization if we are actually recording video!
        if (isVideo) {
            builder.setTargetFrameRate(ListingVideoProfile.frameRate)
            try {
                Camera2Interop.Extender(builder).setCaptureRequestOption(
                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON
                )
            } catch (e: Exception) {
                Log.d(TAG, "Video stabilization not supported: ${e.message}")
            }
        }
        return builder.build()
    }

//    @OptIn(ExperimentalCamera2Interop::class)
//    private fun buildPreview(isVideo: Boolean = false): Preview {
//        val builder = Preview.Builder()
//            .setTargetRotation(currentRotation)
//            .also { ManualControls.applyToPreview(it, manualConfig) }
//            .also { pendingResSelector?.let { sel -> it.setResolutionSelector(sel) } }
//
//        // FIX: Only apply Video Stabilization if we are actually recording video!
//        if (isVideo) {
//            try {
//                Camera2Interop.Extender(builder).setCaptureRequestOption(
//                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
//                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON
//                )
//            } catch (e: Exception) {
//                Log.d(TAG, "Video stabilization not supported: ${e.message}")
//            }
//        }
//        return builder.build()
//    }

    @OptIn(ExperimentalCamera2Interop::class)
    fun syncFlashFromOutside(torchOn: Boolean, autoFlash: Boolean) {
        torchEnabled = torchOn
        autoFlashEnabled = autoFlash
        currentFlashMode = when {
            torchOn -> ImageCapture.FLASH_MODE_ON
            autoFlash -> ImageCapture.FLASH_MODE_AUTO
            else -> ImageCapture.FLASH_MODE_OFF
        }

        if (!::camera.isInitialized) return

        if (::imageCapture.isInitialized) {
            imageCapture.flashMode = currentFlashMode
        }

        if (hasFlash()) {
            camera.cameraControl.enableTorch(torchOn)
        }

        applyCombinedCaptureOptions(
            manualConfig.whiteBalance,
            pendingContrast,
            pendingColor,
            pendingSharpness
        )
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun buildImageCapture(): ImageCapture {
        val captureMode =
            if (activeExtensionMode is CameraViewExtensionMode.Bokeh ||
                activeExtensionMode is CameraViewExtensionMode.HDR
            ) {
                ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY
            } else {
                ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY
            }
        Log.d(
            "AuctionCameraTiming",
            "build_image_capture extension=${activeExtensionMode.label} captureMode=$captureMode"
        )
        val builder = ImageCapture.Builder()
            // Keep Normal mode low latency; quality-heavy extension modes still get
            // the extra capture time they need.
            .setCaptureMode(captureMode)
            .setJpegQuality(95)
            .setFlashMode(currentFlashMode)
            .setTargetRotation(currentRotation)
            // 2. REMOVED the hardcoded ManualControls to prevent stale settings overriding the capture
            .also { pendingResSelector?.let { sel -> it.setResolutionSelector(sel) } }

        try {
            Camera2Interop.Extender(builder)
                .setCaptureRequestOption(
                    CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                    CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON
                )
        } catch (e: Exception) {
            Log.d(TAG, "OIS not supported: ${e.message}")
        }

        return builder.build()
    }

//    @OptIn(ExperimentalCamera2Interop::class)
//    private fun buildImageCapture(): ImageCapture {
//        val builder = ImageCapture.Builder()
//            .setCaptureMode(
//                if (activeExtensionMode is CameraViewExtensionMode.Bokeh ||
//                    activeExtensionMode is CameraViewExtensionMode.HDR
//                )
//                    ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY
//                else
//                    ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY
//            )
//            .setJpegQuality(90)
//            .setFlashMode(currentFlashMode) // ← always use currentFlashMode directly
//            .setTargetRotation(currentRotation)
//            .also { ManualControls.applyToImageCapture(it, manualConfig) }
//            .also { pendingResSelector?.let { sel -> it.setResolutionSelector(sel) } }
//
//        try {
//            Camera2Interop.Extender(builder)
//                .setCaptureRequestOption(
//                    CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
//                    CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON
//                )
//        } catch (e: Exception) {
//            Log.d(TAG, "OIS not supported: ${e.message}")
//        }
//
//        return builder.build()
//    }

    private fun rebindSafely(provider: ProcessCameraProvider, block: () -> Unit) {
        provider.unbindAll()
        block()
    }

    private fun rebindCurrentCamera(previewView: PreviewView, isPhotoMode: Boolean) =
        if (isPhotoMode) startPhoto(previewView) else startVideo(previewView)

    private fun applyManualConfigSafe(
        requested: ManualConfig,
        previewView: PreviewView,
        isPhotoMode: Boolean,
    ) {
        val result = ExtensionViewConflictResolver.resolve(requested, activeExtensionMode)
        if (result.hadConflict) {
            result.reason?.let { mainHandler.post { onManualConflictResolved?.invoke(it) } }
            return
        }
        manualConfig = result.safeConfig
        rebindCurrentCamera(previewView, isPhotoMode)
    }

    private fun resolveSelector(): CameraSelector {
        if (activeExtensionMode.isSoftware) return backOrFrontSelector()
        currentCameraId?.let { id ->
            if (activeExtensionMode is CameraViewExtensionMode.Normal) return selectorForId(id)
        }
        if (activeExtensionMode !is CameraViewExtensionMode.Normal) {
            val ext = ExtensionViewAvailabilityManager.buildExtendedSelector(
                activeExtensionMode, lensFacing
            )
            Log.d(TAG, "resolveSelector — mode=${activeExtensionMode.label} extSelector=$ext")
            if (ext != null) return ext
            Log.w(TAG, "HDR/Extension selector returned null — falling back to normal")
        }
        return backOrFrontSelector()
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun selectorForId(id: String) = CameraSelector.Builder()
        .addCameraFilter { list ->
            list.filter { Camera2CameraInfo.from(it).cameraId == id }
        }.build()

    private fun switchToPhysicalLens(
        previewView: PreviewView,
        targetId: String,
        label: String,
        zoom: Float,
        isPhotoMode: Boolean,
    ) {
        if (isRecording()) return
        isVideoMode = !isPhotoMode
        activeCropRect = null
        if (currentCameraId == targetId) {
            camera.cameraControl.setZoomRatio(zoom)
            return
        }
        val bindingRevision = ++videoBindingRevision
        currentCameraId = targetId
        currentLensLabel = label
        ensureExecutorAlive()
        withProvider { provider ->
            preview =
                buildPreview(!isPhotoMode).also { it.setSurfaceProvider(previewView.surfaceProvider) }
            if (::camera.isInitialized && hasFlash()) {
                camera.cameraControl.enableTorch(false)
            }
            provider.unbindAll()
            try {
                if (isPhotoMode) {
                    imageCapture = buildImageCapture()
                    camera = provider.bindToLifecycle(
                        lifecycleOwner, selectorForId(targetId), preview, imageCapture
                    )
                    camera.cameraControl.setZoomRatio(zoom)
                    reapplyTorch()
                    observeCamera()
                } else {
                    videoCapture = ListingVideoProfile.buildCapture(currentRotation)
                    isVideoReady = false
                    firstFrameConfirmed = false
                    camera = provider.bindToLifecycle(
                        lifecycleOwner, selectorForId(targetId), preview, videoCapture
                    )
                    ListingVideoProfile.requireSupported(camera.cameraInfo)
                    ListingVideoProfile.requireBoundProfile(videoCapture)
                    camera.cameraControl.setZoomRatio(zoom)
                    observeCamera()
                    mainHandler.postDelayed({
                        if (bindingRevision == videoBindingRevision && isVideoMode && ::videoCapture.isInitialized) {
                            isVideoReady = true
                            mainHandler.post { onVideoReady?.invoke() }
                        }
                    }, SURFACE_WARMUP)
                }
            } catch (e: Exception) {
                Log.e(TAG, "switchToPhysicalLens failed: ${e.message}")
                try {
                    provider.unbindAll()
                    if (isPhotoMode) {
                        camera = provider.bindToLifecycle(
                            lifecycleOwner, backOrFrontSelector(), preview, imageCapture
                        )
                    } else {
                        videoCapture = ListingVideoProfile.buildCapture(currentRotation)
                        isVideoReady = false
                        camera = provider.bindToLifecycle(
                            lifecycleOwner, backOrFrontSelector(), preview, videoCapture
                        )
                        ListingVideoProfile.requireSupported(camera.cameraInfo)
                        ListingVideoProfile.requireBoundProfile(videoCapture)
                        mainHandler.postDelayed({
                            if (bindingRevision == videoBindingRevision && isVideoMode) {
                                isVideoReady = true
                                onVideoReady?.invoke()
                            }
                        }, SURFACE_WARMUP)
                    }
                    currentLensLabel = "Wide"
                    currentCameraId = wideCameraId
                    camera.cameraControl.setZoomRatio(1f)
                    observeCamera()
                } catch (ex: Exception) {
                    Log.e(TAG, "Fallback also failed: ${ex.message}")
                    if (!isPhotoMode) {
                        isVideoReady = false
                        mainHandler.post { onRecordingError?.invoke(ListingVideoProfile.UNSUPPORTED_MESSAGE) }
                    }
                }
            }
        }
    }

    private fun detectPhysicalLensIds() {
        val mgr = cameraManager()
        val backIds = mgr.cameraIdList.filter { id ->
            runCatching {
                mgr.getCameraCharacteristics(id)
                    .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            }.getOrDefault(false)
        }
        val mainFocal = backIds
            .mapNotNull { id -> runCatching { mgr.focalMin(id) }.getOrNull() }
            .maxOrNull() ?: 6f

        for (id in backIds) {
            try {
                val focal = mgr.focalMin(id) ?: continue
                if (mgr.getCameraCharacteristics(id).jpegMaxMp() < 1f) continue
                when {
                    focal / mainFocal < 0.75f -> {
                        uwCameraId = id
                        Log.d(TAG, "UW   id=$id f=${focal}mm")
                    }

                    focal / mainFocal < 1.35f -> {
                        wideCameraId = id
                        currentCameraId = id
                        Log.d(TAG, "Wide id=$id f=${focal}mm")
                    }

                    else -> {
                        teleCameraId = id
                        Log.d(TAG, "Tele id=$id f=${focal}mm")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Skip $id: ${e.message}")
            }
        }
    }

    private fun setupOrientationListener() {
        try {
            orientationListener = object : OrientationEventListener(context) {
                override fun onOrientationChanged(o: Int) {
                    if (o == ORIENTATION_UNKNOWN) return
                    val wm = context.getSystemService(Context.WINDOW_SERVICE)
                            as android.view.WindowManager
                    currentRotation = if (android.os.Build.VERSION.SDK_INT >=
                        android.os.Build.VERSION_CODES.R
                    ) {
                        context.display.rotation ?: Surface.ROTATION_0
                    } else {
                        @Suppress("DEPRECATION")
                        wm.defaultDisplay.rotation
                    }
                    if (::imageCapture.isInitialized) {
                        imageCapture.targetRotation = currentRotation
                    }
                }
            }
            orientationListener.enable()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun ensureExecutorAlive() {
        if (cameraExecutor.isShutdown || cameraExecutor.isTerminated)
            cameraExecutor = Executors.newSingleThreadExecutor()
    }

    private fun backOrFrontSelector() =
        CameraSelector.Builder().requireLensFacing(lensFacing).build()

    private fun cameraManager() =
        context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    private fun withProvider(block: (ProcessCameraProvider) -> Unit) {
        cachedProvider?.let { block(it); return }
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            runCatching { val p = future.get(); cachedProvider = p; block(p) }
        }, ContextCompat.getMainExecutor(context))
    }

    @OptIn(ExperimentalCamera2Interop::class)
    fun setAEAFRegion(normalizedRect: RectF) {
        activeCropRect = normalizedRect
        if (!::camera.isInitialized) return
        try {
            val c2 = Camera2CameraControl.from(camera.cameraControl)

            val sensorSize = Camera2CameraInfo.from(camera.cameraInfo)
                .getCameraCharacteristic(
                    CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE
                ) ?: return

            val sW = sensorSize.width().toFloat()
            val sH = sensorSize.height().toFloat()

            val sensorRect = android.hardware.camera2.params.MeteringRectangle(
                android.graphics.Rect(
                    (normalizedRect.left * sW).toInt().coerceIn(0, sensorSize.width()),
                    (normalizedRect.top * sH).toInt().coerceIn(0, sensorSize.height()),
                    (normalizedRect.right * sW).toInt().coerceIn(0, sensorSize.width()),
                    (normalizedRect.bottom * sH).toInt().coerceIn(0, sensorSize.height())
                ),
                android.hardware.camera2.params.MeteringRectangle.METERING_WEIGHT_MAX
            )

            val surfacePoint = androidx.camera.core.SurfaceOrientedMeteringPointFactory(1f, 1f)
                .createPoint(normalizedRect.centerX(), normalizedRect.centerY())
            val action = androidx.camera.core.FocusMeteringAction.Builder(
                surfacePoint,
                androidx.camera.core.FocusMeteringAction.FLAG_AF or androidx.camera.core.FocusMeteringAction.FLAG_AE
            ).setAutoCancelDuration(3, java.util.concurrent.TimeUnit.SECONDS).build()
            camera.cameraControl.startFocusAndMetering(action)

            if (!activeExtensionMode.isSoftware && activeExtensionMode !is CameraViewExtensionMode.Normal) {
                activeCropRect = normalizedRect
                return
            }

            val builder = CaptureRequestOptions.Builder()
                .setCaptureRequestOption(
                    CaptureRequest.CONTROL_AF_REGIONS,
                    arrayOf(sensorRect)
                )
                .setCaptureRequestOption(
                    CaptureRequest.CONTROL_AE_REGIONS,
                    arrayOf(sensorRect)
                )
                .setCaptureRequestOption(
                    CaptureRequest.CONTROL_AWB_REGIONS,
                    arrayOf(sensorRect)
                )

            ManualControls.applyToBuilder(builder, effectiveManualConfig())
            c2.captureRequestOptions = builder.build()

            activeCropRect = normalizedRect
            Log.d("AEAF", "Region set: $sensorRect")
        } catch (e: Exception) {
            Log.e("AEAF", "setAEAFRegion failed: ${e.message}")
        }
    }

    @OptIn(ExperimentalCamera2Interop::class)
    fun clearAEAFRegion() {
        activeCropRect = null
        if (!::camera.isInitialized) return
        if (isRecording()) {
            Log.d("AEAF", "clearAEAFRegion: video recording active, skipping low-level CaptureRequestOptions update to avoid freeze")
            return
        }
        try {
            val c2 = Camera2CameraControl.from(camera.cameraControl)
            if (!activeExtensionMode.isSoftware && activeExtensionMode !is CameraViewExtensionMode.Normal) {
                activeCropRect = null
                return
            }

            val builder = CaptureRequestOptions.Builder()
                .setCaptureRequestOption(
                    CaptureRequest.CONTROL_AF_REGIONS,
                    arrayOf<android.hardware.camera2.params.MeteringRectangle>()
                )
                .setCaptureRequestOption(
                    CaptureRequest.CONTROL_AE_REGIONS,
                    arrayOf<android.hardware.camera2.params.MeteringRectangle>()
                )

            ManualControls.applyToBuilder(builder, effectiveManualConfig())
            c2.captureRequestOptions = builder.build()
            activeCropRect = null
        } catch (e: Exception) {
            Log.e("AEAF", "clearAEAFRegion failed: ${e.message}")
        }
    }

    fun applyProSettingsBatch(
        isoProgress: Int,
        shutterProgress: Int,
        fpsMin: Int,
        fpsMax: Int,
        wbIndex: Int,
        shutterValues: List<Long>,
        previewView: PreviewView,
        isPhotoMode: Boolean,
        deviceLimits: DeviceLimits?,
    ) {
        val iso: Int? = if (isoProgress == 0) null else {
            deviceLimits?.let { lim ->
                logScaleInternal(isoProgress, 100, lim.minIso, lim.maxIso)
                    .toInt().let { (it / 50) * 50 }.coerceIn(lim.minIso, lim.maxIso)
            }
        }
        val shutterNs: Long? = if (shutterProgress == 0) null else {
            val idx = (shutterProgress - 1).coerceIn(0, shutterValues.lastIndex)
            val raw = shutterValues[idx]
            deviceLimits?.let { lim -> raw.coerceIn(lim.minShutterNs, lim.maxShutterNs) } ?: raw
        }
        val wb = WhiteBalance.entries.getOrNull(wbIndex) ?: WhiteBalance.AUTO
        val best = AeFpsController.getBestMatch(fpsMin, fpsMax)
        AeFpsController.setCustomRange(best.lower, best.upper)

        val newConfig = ManualConfig(
            aeMode = if (iso != null || shutterNs != null)
                CaptureRequest.CONTROL_AE_MODE_OFF
            else
                CaptureRequest.CONTROL_AE_MODE_ON,
            iso = iso,
            shutterSpeedNs = shutterNs,
            aeFpsMin = best.lower,
            aeFpsMax = best.upper,
            whiteBalance = wb
        )

        val result = ExtensionViewConflictResolver.resolve(newConfig, activeExtensionMode)
        if (result.hadConflict) {
            result.reason?.let { mainHandler.post { onManualConflictResolved?.invoke(it) } }
            return
        }
        manualConfig = result.safeConfig

        if (::camera.isInitialized) {
            ManualControls.applyDirect(camera, effectiveManualConfig())
            applyWBDirect(wb)   // ← single clean call using awbMode from enum
            Log.d(
                TAG, "applyProSettingsBatch: iso=$iso shutter=$shutterNs " +
                        "fps=${best.lower}-${best.upper} wb=${wb.label}(${wb.awbMode})"
            )
        }
    }

    private fun logScaleInternal(p: Int, max: Int, min: Int, maxV: Int): Float =
        (min * (maxV.toFloat() / min).toDouble().pow(p.toDouble() / max)).toFloat()

    private fun CameraManager.focalMin(id: String) = runCatching {
        getCameraCharacteristics(id)
            .get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
            ?.minOrNull()
    }.getOrNull()

    private fun CameraCharacteristics.jpegMaxMp() =
        get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?.getOutputSizes(ImageFormat.JPEG)
            ?.maxByOrNull { it.width * it.height }
            ?.let { (it.width * it.height) / 1_000_000f } ?: 0f
}
