package expo.modules.auctioncamera.ui.camera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RectF
import android.graphics.drawable.BitmapDrawable
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.media.AudioManager
import android.media.MediaActionSound
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.viewModels
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.AppCompatImageView
import androidx.appcompat.widget.AppCompatTextView
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import expo.modules.auctioncamera.CameraMode
import expo.modules.auctioncamera.CaptureMode
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.WhiteBalance
import expo.modules.auctioncamera.ZoomSlot
import expo.modules.auctioncamera.controls.AeFpsController
import expo.modules.auctioncamera.databinding.ActivityCameraViewBinding
import expo.modules.auctioncamera.model.DeviceLimits
import expo.modules.auctioncamera.ui.base.BaseActivity
import expo.modules.auctioncamera.utils.TapToFocus
import expo.modules.auctioncamera.viewextensions.AEAFRegionOverlay
import expo.modules.auctioncamera.viewextensions.CameraViewEngine
import expo.modules.auctioncamera.viewextensions.CameraViewExtensionMode
import expo.modules.auctioncamera.viewextensions.CameraViewModel
import expo.modules.auctioncamera.viewextensions.CaptureTicket
import expo.modules.auctioncamera.viewextensions.PhotoWorkQueue
import expo.modules.auctioncamera.viewextensions.ExtensionViewConflictResolver
import expo.modules.auctioncamera.viewextensions.HapticCaptureHelper
import expo.modules.auctioncamera.viewextensions.ImageFormatStore
import expo.modules.auctioncamera.viewextensions.LotJsonSerializer
import expo.modules.auctioncamera.viewextensions.LotMode
import expo.modules.auctioncamera.viewextensions.OutputQualityStore
import expo.modules.auctioncamera.viewextensions.ProSettings
import expo.modules.auctioncamera.viewextensions.ProSettingsStore
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.pow

/**
 * PRIMARY NATIVE CAMERA VIEW
 * This activity takes over the screen from React Native to provide a highly optimized,
 * zero-lag native camera experience using Android CameraX and Camera2 interop.
 */
class CameraViewActivity : BaseActivity() {

    companion object {
        private const val KEY_BOX_MODE_ACTIVE = "key_box_mode_active"
        private const val MAX_QUEUED_TAPS = 5
        private const val BURST_TAP_MIN_GAP_MS = 150L
    }

    private var selectedImageFormat = ImageFormatStore.Format.JPEG
    private var cameraBound = false
    private lateinit var binding: ActivityCameraViewBinding
    private val viewModel: CameraViewModel by viewModels()
    private lateinit var engine: CameraViewEngine
    private lateinit var scaleDetector: ScaleGestureDetector
    private val OFF = 0
    private val ON = 1
    private val AUTO = 2
    private var flashState = AUTO
    private var userSelectedFlashState = AUTO
    private var isPinching = false
    private var downX = 0f
    private var downY = 0f
    private var currentZoom = 1f
    private var flashEnabled = false
    private var currentCameraMode = CameraMode.PHOTO
    private var currentCaptureMode: CaptureMode? = null
    private var isVideoReady = false
    private var isRecording = false
    private var pendingStartRecording = false
    private var recordingSeconds = 0
    private var isRecordButtonLocked = false
    private var recordingTimer: Runnable? = null
    private var lastPhotoUri: Uri? = null
    private var lastVideoUri: Uri? = null
    private var lastShutterTapAtMs: Long = 0L
    private var isProMode = false
    private var zoomSynced = false
    private var hasConfirmedUltraWide = false
    private var isUserDraggingEV = false
    private var proControlsInitialized = false
    private var btn06Label = "0.6"
    private var btn4Label = "4"
    private var zoomUIUpdatePending = false
    private var deviceLimits: DeviceLimits? = null
    private var selectedResolution = "12M"
    private val CHIP_NORMAL = "Normal"
    private val CHIP_HDR = "HDR"
    private val CHIP_NIGHT = "Night"
    private val CHIP_PORTRAIT = "Portrait"
    private val extensionChipMap = mutableMapOf<String, AppCompatTextView>()
    private val AMBER get() = ContextCompat.getColor(this, R.color.orange)
    private var pendingCameraSwitch = false
    private var thumbLoadJob: kotlinx.coroutines.Job? = null

    private var processingCount = 0
    private val queuedShots = linkedMapOf<String, CaptureTicket>()
    private var activeShutterId: String? = null
    private var shutterDeadline: Runnable? = null
    private val recoveryTick = object : Runnable {
        override fun run() {
            if (!::binding.isInitialized || isDestroyed || isFinishing) return
            if (::engine.isInitialized) engine.resumePendingPhotos()
            binding.root.postDelayed(this, 1_000)
        }
    }

    private fun releaseShutter(ticket: CaptureTicket) {
        if (activeShutterId != ticket.id) return
        activeShutterId = null
        shutterDeadline?.let { binding.root.removeCallbacks(it) }
        captureInFlight.set(false)
        clearPreviewFreeze()
        binding.root.post { drainQueuedTaps() }
    }
    private var pulseAnimator: android.animation.ObjectAnimator? = null

    // track orientation for freeze-frames
    private var lastDisplayRotation = android.view.Surface.ROTATION_0
    private val thumbCache = object : android.util.LruCache<String, android.graphics.Bitmap>(8) {
        override fun entryRemoved(
            evicted: Boolean,
            key: String,
            oldValue: android.graphics.Bitmap,
            newValue: android.graphics.Bitmap?
        ) {
            super.entryRemoved(evicted, key, oldValue, newValue)
            if (evicted && !oldValue.isRecycled) {
                oldValue.recycle() // Instantly free RAM when old thumbnails are pushed out
            }
        }
    }
    private var hasProcessedLotRestore = false
    private var isDualRecording = false
    private var flashPopup: PopupWindow? = null
    private val captureInFlight = java.util.concurrent.atomic.AtomicBoolean(false)
    /**
     * Taps made while the shutter is busy (2026-10-26). They were silently lost, so a
     * quick series of taps saved one photo. Each now waits and is taken in order as soon
     * as the shutter frees, in the lot it was made in; a second touch within
     * BURST_TAP_MIN_GAP_MS is a bounce or double tap and is not a new shot.
     */
    private data class QueuedTap(val mode: CaptureMode, val isExtra: Boolean, val lotNumber: Int)
    private val queuedTaps = ArrayDeque<QueuedTap>()
    private var lastUserTapAtMs = 0L
    private var isBoxModeActive = false
    private var selectedWbIndex = 0
    private var previousLotNumber = 1
    private val sound = runCatching {
        MediaActionSound().apply { load(MediaActionSound.SHUTTER_CLICK) }
    }.getOrNull()

    /** The click follows the phone's sound setting: Silent and Vibrate stay quiet, unless the region requires it. */
    private fun playShutterSound() {
        val required = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && MediaActionSound.mustPlayShutterSound()
        if (!required && getSystemService(AudioManager::class.java)?.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
        runCatching { sound?.play(MediaActionSound.SHUTTER_CLICK) }
    }
    private var isUserDraggingZoom = false
    private var suppressZoomUICallback = false
    private val clearSuppressRunnable = Runnable { suppressZoomUICallback = false }
    private var intendedZoom: Float? = null
    private var pendingZoomRestore: Float? = null
    private var currentEVLevel = 0f
    private var previewFreezeDrawable: BitmapDrawable? = null
    private val clearPreviewFreezeRunnable = Runnable { clearPreviewFreeze() }
    private val delayedClearPreviewFreezeRunnable = Runnable { maybeClearPreviewFreezeFromStream() }
    private var previewFreezeStartedAtMs = 0L

    // --- FIX: Current highlighted zoom button track karne ke liye ---
    private var currentHighlightedBtn: View? = null

    private val shutterValues = listOf(
        250_000L,
        500_000L,
        1_000_000L,
        2_000_000L,
        4_000_000L,
        8_000_000L,
        10_000_000L,
        16_666_667L,
        20_000_000L,
        33_333_333L,
        50_000_000L,
        66_666_667L,
        100_000_000L,
        125_000_000L,
        166_666_667L,
        250_000_000L,
        500_000_000L,
        1_000_000_000L,
        2_000_000_000L,
        4_000_000_000L
    )
    private val shutterLabels = listOf(
        "1/4000", "1/2000", "1/1000", "1/500", "1/250", "1/125", "1/100",
        "1/60", "1/50", "1/30", "1/20", "1/15", "1/10", "1/8",
        "1/6", "1/4", "1/2", "1s", "2s", "4s"
    )

    private val requestedPerms
        get() = mutableListOf(
            Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO
        ).apply {
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P)
                add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }.toTypedArray()

    // Microphone access adds sound to video; it must never block taking photos.
    private val captureRequiredPerms
        get() = requestedPerms.filterNot { it == Manifest.permission.RECORD_AUDIO }

    private fun hasCapturePermissions(): Boolean = captureRequiredPerms.all {
        checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
    }

    private fun getCurrentDisplayRotationSafe(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: android.view.Surface.ROTATION_0
        } else {
            @Suppress("DEPRECATION")
            val wm =
                getSystemService(android.content.Context.WINDOW_SERVICE) as android.view.WindowManager
            wm.defaultDisplay.rotation
        }
    }

    private fun startThumbnailPulse() {
        if (!::binding.isInitialized || isFinishing || isDestroyed ||
            !lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) return
        if (pulseAnimator == null) {
            pulseAnimator = android.animation.ObjectAnimator.ofFloat(binding.galleryPreview, "alpha", 1f, 0.4f).apply {
                duration = 600
                repeatCount = android.animation.ValueAnimator.INFINITE
                repeatMode = android.animation.ValueAnimator.REVERSE
            }
        }
        if (pulseAnimator?.isRunning == false) {
            pulseAnimator?.start()
        }
    }

    private fun stopThumbnailPulse() {
        pulseAnimator?.cancel()
        pulseAnimator = null
        if (::binding.isInitialized) binding.galleryPreview.alpha = 1f
    }

    private fun getRotationDegrees(rotation: Int): Int = when (rotation) {
        android.view.Surface.ROTATION_0 -> 0
        android.view.Surface.ROTATION_90 -> 90
        android.view.Surface.ROTATION_180 -> 180
        android.view.Surface.ROTATION_270 -> 270
        else -> 0
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        expo.modules.auctioncamera.CameraActivityRegistry.attach(intent.getStringExtra(expo.modules.auctioncamera.CameraPayloadStore.EXTRA_HANDOFF_ID), this)
        val initialPayload = try {
            expo.modules.auctioncamera.CameraPayloadStore.input(this, intent).also {
                viewModel.repository.configureCapture(it)
            }
        } catch (error: Exception) {
            Log.e("AuctionCameraTiming", "Camera draft handoff could not be restored", error)
            setResult(RESULT_CANCELED, Intent().putExtra(expo.modules.auctioncamera.CameraPayloadStore.EXTRA_ERROR_CODE, "E_CAMERA_INPUT"))
            finish()
            return
        }
        // Restore before observers can initialize an empty builder and checkpoint it.
        val restoredLifecycleSession = try {
            val restored = (savedInstanceState != null || viewModel.repository.hasPendingJournal()) && viewModel.restoreSessionIfAvailable()
            if (!restored && initialPayload != null && initialPayload.isNotEmpty() && initialPayload != "[]") {
                viewModel.loadFromPayload(initialPayload)
            } else if (!restored) {
                if (viewModel.captureMode.value == null) viewModel.setCaptureMode(CaptureMode.BUNDLE)
                viewModel.setInitialLotNumber(viewModel.currentLotNumber.value ?: 1)
            }
            restored
        } catch (error: Exception) {
            Log.e("AuctionCameraTiming", "The saved camera structure does not match this draft", error)
            setResult(RESULT_CANCELED, Intent().putExtra(expo.modules.auctioncamera.CameraPayloadStore.EXTRA_ERROR_CODE, "E_CAMERA_INPUT"))
            finish()
            return
        }
        binding = ActivityCameraViewBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setupEdgeToEdge()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (waitForCapture()) return
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        })

        lastDisplayRotation = getCurrentDisplayRotationSafe()
        isBoxModeActive = savedInstanceState?.getBoolean(KEY_BOX_MODE_ACTIVE, false) ?: false
        scaleDetector = buildScaleDetector()
        setupLotNavigation()
        setupCaptureModeButtons()
        setupCameraModeButtons()
        setupZoom()
        setupGalleryClick()
        setupResolutionToggle()
        observeViewModel()
        setupFocusLogic()
        applyBoxFocusUi()
        setupEffectSliders()
        setupImageFormatPicker()
        if (hasCapturePermissions()) startCamera()
        if (requestedPerms.any { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED })
            requestPermissions(requestedPerms, 1001)

        if (restoredLifecycleSession) {
            Log.d("AuctionCameraTiming", "restored lifecycle camera session")
        }
    }

    private fun setupEdgeToEdge() {
        val isPortrait = binding.root.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        if (isPortrait) {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            // Leaving the immersive landscape camera restores the existing portrait bars.
            WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT

            ViewCompat.setOnApplyWindowInsetsListener(binding.main) { _, insets ->
                val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())

                val left = systemBars.left
                val top = systemBars.top
                val right = systemBars.right
                val bottom = systemBars.bottom

                binding.safeLeft?.setGuidelineBegin(left)
                binding.safeTop?.setGuidelineBegin(top)
                binding.safeRight?.setGuidelineEnd(right)
                binding.safeBottom?.setGuidelineEnd(bottom)

                insets
            }
            window.decorView.requestApplyInsets()
        } else {
            // Keep the preview edge-to-edge, but never place camera actions beneath a
            // landscape navigation/gesture bar. Hidden transient bars report a zero
            // visible inset on some Samsung devices, so we also use the stable inset
            // and a conservative fallback sized for a standard navigation rail.
            WindowCompat.setDecorFitsSystemWindows(window, false)
            window.statusBarColor = android.graphics.Color.BLACK
            window.navigationBarColor = android.graphics.Color.BLACK
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isNavigationBarContrastEnforced = false
            }
            hideLandscapeSystemBars()
            // Re-apply after the newly inflated rotation view has attached to the same window.
            binding.root.post { hideLandscapeSystemBars() }

            val minimumEndSafeArea = (48 * resources.displayMetrics.density).toInt()
            ViewCompat.setOnApplyWindowInsetsListener(binding.main) { view, insets ->
                val visibleBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                val stableNavigation = insets.getInsetsIgnoringVisibility(
                    WindowInsetsCompat.Type.navigationBars()
                )
                val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
                val gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
                val mandatoryGestures = insets.getInsets(
                    WindowInsetsCompat.Type.mandatorySystemGestures()
                )
                val tappableElements = insets.getInsets(WindowInsetsCompat.Type.tappableElement())
                val safeEnd = maxOf(
                    visibleBars.right,
                    stableNavigation.right,
                    cutout.right,
                    gestures.right,
                    mandatoryGestures.right,
                    tappableElements.right,
                    minimumEndSafeArea
                )

                view.setPadding(
                    maxOf(visibleBars.left, cutout.left),
                    maxOf(visibleBars.top, cutout.top),
                    0,
                    maxOf(visibleBars.bottom, cutout.bottom)
                )
                binding.safeRight?.setGuidelineEnd(safeEnd)
                insets
            }
            window.decorView.requestApplyInsets()
        }
    }

    private fun hideLandscapeSystemBars() {
        if (!::binding.isInitialized || binding.root.resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE) return
        WindowCompat.getInsetsController(window, window.decorView).apply {
            show(WindowInsetsCompat.Type.statusBars())
            hide(WindowInsetsCompat.Type.navigationBars())
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideLandscapeSystemBars()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(KEY_BOX_MODE_ACTIVE, isBoxModeActive)
        if (::binding.isInitialized) viewModel.persistSessionForBackground()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                triggerBundleCaptureFromHardware()
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun triggerBundleCaptureFromHardware() {
        if (!::binding.isInitialized) return
        val mode = viewModel.repository.fixedMode(viewModel.currentLotNumber.value ?: 1)?.toCaptureMode() ?: CaptureMode.BUNDLE
        val button = when (mode) {
            CaptureMode.BUNDLE -> binding.textViewBundle
            CaptureMode.ITEM -> binding.textViewItem
            CaptureMode.PHOTO -> binding.textViewPhoto
        }
        onCaptureModeButtonTapped(mode, button)
    }

    override fun onResume() {
        super.onResume()
        if (!::binding.isInitialized) return
        binding.root.removeCallbacks(recoveryTick)
        binding.root.post(recoveryTick)
        viewModel.refresh()
        binding.galleryPreview.post { if (processingCount > 0) startThumbnailPulse() }
        if (!::engine.isInitialized) return

        if (!cameraBound) {
            cameraBound = true
            binding.previewView.post {
                if (isFinishing || isDestroyed) return@post
                zoomSynced = false; hasConfirmedUltraWide = false
                highlight(binding.zoom1)
                when (currentCameraMode) {
                    CameraMode.VIDEO -> {
                        isVideoReady = false; engine.startVideo(binding.previewView)
                    }

                    else -> engine.startPhoto(binding.previewView)
                }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        queuedTaps.clear()
        if (::binding.isInitialized) binding.root.removeCallbacks(recoveryTick)
        stopThumbnailPulse()
        if (::binding.isInitialized) viewModel.persistSessionForBackground()
        clearPreviewFreeze()
        if (!::engine.isInitialized) return
        cameraBound = false
        // Save current zoom so it can be restored when we return from image preview
        pendingZoomRestore = currentZoom
//        if (!isChangingConfigurations) {
//            dismissFlashPopup() // Just close the menu, do NOT wipe the flash state!
//        }
        if (engine.isRecording()) {
            engine.stopRecording(); stopRecordingUI()
        }
        engine.pause()
    }

    override fun onDestroy() {
        if (::binding.isInitialized) {
            binding.root.removeCallbacks(recoveryTick)
            shutterDeadline?.let { binding.root.removeCallbacks(it) }
        }
        runCatching { sound?.release() }
        expo.modules.auctioncamera.CameraActivityRegistry.detach(intent.getStringExtra(expo.modules.auctioncamera.CameraPayloadStore.EXTRA_HANDOFF_ID), this)
        stopThumbnailPulse()
        clearPreviewFreeze()
        super.onDestroy()
        if (::engine.isInitialized) engine.shutdown()
    }

    override fun onRequestPermissionsResult(rc: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(rc, perms, results)
        if (rc != 1001) return
        if (results.isEmpty()) {
            if (!::engine.isInitialized || !hasCapturePermissions()) {
                toast("Camera permission request was cancelled")
                finish()
            }
            return
        }
        if (hasCapturePermissions()) {
            startCamera()
        } else {
            toast("Camera access and permission to save photos are required")
            finish()
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Observers
    // ─────────────────────────────────────────────────────────────────────────

    private fun observeViewModel() {
        viewModel.currentLotPhotoCount.observe(this) { count ->
            val photoCount = (viewModel.currentLotUris.value ?: emptyList())
                .count { !LotGalleryActivity.isVideoUri(it) }
            binding.galleryCount.text = photoCount.toString()
            binding.galleryCount.visibility = if (photoCount > 0) View.VISIBLE else View.GONE
        }

        viewModel.currentLotUris.observe(this) { uris ->
            if (uris.isNullOrEmpty()) {
                binding.galleryPreview.setImageDrawable(null)
                binding.galleryCount.visibility = View.GONE
                try {
                    binding.galleryVideoBadge.visibility = View.GONE
                } catch (_: Exception) {
                }
                return@observe
            }
            binding.galleryCount.text = uris.size.toString()
            binding.galleryCount.visibility = View.VISIBLE
            try {
                binding.galleryVideoBadge.visibility = View.GONE
            } catch (_: Exception) {
            }
            val thumbUri = uris.last()
            val cacheKey = thumbUri.toString()
            val cached = thumbCache.get(cacheKey)
            if (cached != null) {
                binding.galleryPreview.setImageBitmap(cached)
            } else {
                loadGalleryThumb(thumbUri)
            }
        }

        viewModel.mainCount.observe(this) { updateCounterBar() }
        viewModel.extraCount.observe(this) { updateCounterBar() }
        viewModel.totalCount.observe(this) { updateCounterBar() }
        viewModel.currentLotNumber.observe(this) { lotNum ->
            binding.textViewLot.text = viewModel.repository.lotLabel(lotNum)
            updateFixedLotControls(lotNum)

            if (hasProcessedLotRestore && lotNum == previousLotNumber) return@observe

            if (isProMode && proControlsInitialized) {
                val pro = binding.includePro
                val selectedFps = when {
                    pro.fps15.currentTextColor == AMBER -> 15 to 15
                    pro.fps60.currentTextColor == AMBER -> 60 to 60
                    else -> 30 to 30
                }
                val wbLabel = WhiteBalance.entries.getOrNull(selectedWbIndex)?.label ?: "Auto"
                viewModel.saveProSettingsForLot(
                    previousLotNumber,
                    ProSettings(
                        isoProgress = pro.isoSeekBar.progress,
                        shutterProgress = pro.shutterSeekBar.progress,
                        fpsMin = selectedFps.first,
                        fpsMax = selectedFps.second,
                        wbLabel = wbLabel,
                        wbIndex = selectedWbIndex,
                        contrast = progressToEffect(pro.seekContrast.progress),
                        color = progressToEffect(pro.seekColor.progress),
                        sharpness = progressToEffect(pro.seekSharpness.progress)
                    )
                )
            }

//            val hasSettings = viewModel.hasProSettingsForLot(lotNum)
//
//            if (!hasSettings) {
//                selectedWbIndex = 0
//                if (isProMode) {
//                    resetProControlsToAuto()
//                    if (::engine.isInitialized) engine.setAutoMode(binding.previewView, isPhoto())
//                } else if (::engine.isInitialized) {
//                    engine.setAutoMode(binding.previewView, isPhoto())
//                    engine.setImageEffects(0, 0, 0)
//                    applyPreviewLayerFilter(0, 0)
//                }
//            } else {
//                val savedSettings = viewModel.getProSettingsForLot(lotNum)
//                selectedWbIndex = savedSettings.wbIndex
//                applyProSettingsToUI(savedSettings, applyToEngine = true)
//                if (!isProMode && ::engine.isInitialized) {
//                    applyProSettingsToEngine(savedSettings)
//                }
//            }

            val hasSettings = viewModel.hasProSettingsForLot(lotNum)

            if (!hasSettings) {
                // No lot-specific settings for this lot yet.
                // Fall back to the user's persisted global Pro settings rather
                // than silently resetting to AUTO — that's the bug the client
                // reported: "settings change back to default when I switch lots".
                val persisted = ProSettingsStore.load(this)
                if (persisted != null) {
                    // Carry global settings forward into the new lot
                    selectedWbIndex = persisted.wbIndex
                    viewModel.saveProSettingsForLot(lotNum, persisted)
                    applyProSettingsToUI(persisted, applyToEngine = true)
                    if (!isProMode && ::engine.isInitialized) {
                        applyProSettingsToEngine(persisted)
                    }
                } else {
                    // User has never saved any Pro settings → reset to AUTO
                    selectedWbIndex = 0
                    if (isProMode) {
                        resetProControlsToAuto()
                        if (::engine.isInitialized) engine.setAutoMode(
                            binding.previewView,
                            isPhoto()
                        )
                    } else if (::engine.isInitialized) {
                        engine.setAutoMode(binding.previewView, isPhoto())
                        engine.setImageEffects(0, 0, 0)
                        applyPreviewLayerFilter(0, 0)
                    }
                }
            } else {
                val savedSettings = viewModel.getProSettingsForLot(lotNum)
                selectedWbIndex = savedSettings.wbIndex
                applyProSettingsToUI(savedSettings, applyToEngine = true)
                if (!isProMode && ::engine.isInitialized) {
                    applyProSettingsToEngine(savedSettings)
                }
            }

            previousLotNumber = lotNum
            hasProcessedLotRestore = true
        }
        viewModel.currentProSettings.observe(this) { settings ->
            if (isProMode && binding.includePro.root.visibility == View.VISIBLE) {
                applyProSettingsToUI(settings, applyToEngine = false)
            } else if (::engine.isInitialized) {
                val isDefault = settings.isoProgress == 0 &&
                        settings.shutterProgress == 0 &&
                        settings.wbIndex == 0 &&
                        settings.fpsMin == 30 &&
                        settings.fpsMax == 30 &&
                        settings.contrast == 0 &&
                        settings.color == 0 &&
                        settings.sharpness == 0
                if (!isDefault) {
                    applyProSettingsToEngine(settings)
                } else {
                    engine.setAutoMode(binding.previewView, isPhoto())
                    engine.setImageEffects(0, 0, 0)
                    applyPreviewLayerFilter(0, 0)
                }
            }
        }
        viewModel.viewedLotMode.observe(this) { mode ->
            if (mode == null) {
                binding.textViewSetViews.text = "Not set"
                binding.textViewSetViews.setTextColor(getColor(R.color.orange))
                clearCaptureModeHighlights()
            } else {
                updateModeSubtitle(mode)
                highlightCaptureModeButton(mode)
            }
        }

        viewModel.modeMismatch.observe(this) { pair ->
            showModeMismatchDialog(pair.first, pair.second)
        }
        viewModel.nextLotConfirm.observe(this) { showNextLotConfirmDialog() }

        viewModel.viewedLotMode.observe(this) { mode ->
            updateModeSubtitle(mode)
            when {
                mode != null -> highlightCaptureModeButton(mode)
                viewModel.isViewingPastLot() -> {
                    clearCaptureModeHighlights()
                }

                else -> {
                    val active = viewModel.captureMode.value
                    if (active != null) highlightCaptureModeButton(active)
                    else clearCaptureModeHighlights()
                }
            }
        }
    }

    private fun updateCounterBar() {
        val main = viewModel.mainCount.value ?: 0
        val extra = viewModel.extraCount.value ?: 0
        val total = viewModel.totalCount.value ?: 0
        try {
            binding.includeMainExtra.tvMainCount.text = main.toString()
            binding.includeMainExtra.tvExtraCount.text = extra.toString()
            binding.includeMainExtra.tvTotalCount.text = total.toString()
        } catch (_: Exception) {
        }
    }

    private fun updateModeSubtitle(mode: CaptureMode?) {
        binding.textViewSetViews.text = when (mode) {
            CaptureMode.BUNDLE -> "Bundle"
            CaptureMode.ITEM -> "Per Item"
            CaptureMode.PHOTO -> "Per Photo"
            null -> "Not set"
        }
        binding.textViewSetViews.setTextColor(if (mode != null) AMBER else Color.WHITE)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dialogs
    // ─────────────────────────────────────────────────────────────────────────

    private fun showModeMismatchDialog(existingMode: LotMode, requestedMode: LotMode) {
        val existingLabel = lotModeLabel(existingMode)
        val requestedLabel = lotModeLabel(requestedMode)

        val targetCaptureMode = when (requestedMode) {
            LotMode.SINGLE_LOT -> CaptureMode.BUNDLE
            LotMode.PER_ITEM -> CaptureMode.ITEM
            LotMode.PER_PHOTO -> CaptureMode.PHOTO
        }

        AlertDialog.Builder(this)
            .setTitle("Mode Mismatch")
            .setMessage(
                "This lot uses \"$existingLabel\" mode.\n" +
                        "Switching to \"$requestedLabel\" requires a new lot."
            )
            .setNegativeButton("CANCEL") { d, _ -> d.dismiss() }
            .setPositiveButton("NEW LOT") { d, _ ->
                d.dismiss()
                viewModel.handleNewLotFromMismatch(targetCaptureMode)
                applyCaptureModeSelection(targetCaptureMode)
            }
            .setCancelable(true)
            .show()
    }

    private fun applyCaptureModeSelection(mode: CaptureMode) {
        currentCaptureMode = mode
        highlightCaptureModeButton(mode)
        updateModeSubtitle(mode)
        viewModel.setLotMode(
            when (mode) {
                CaptureMode.BUNDLE -> LotMode.SINGLE_LOT
                CaptureMode.ITEM -> LotMode.PER_ITEM
                CaptureMode.PHOTO -> LotMode.PER_PHOTO
            }
        )
    }

    private fun showNextLotConfirmDialog() {
        val lotNum = viewModel.currentLotNumber.value ?: 1
        AlertDialog.Builder(this)
            .setTitle("Move to Next Lot?")
            .setMessage("You are currently on Lot $lotNum. Do you want to move to Lot ${lotNum + 1}?")
            .setNegativeButton("CANCEL") { d, _ -> d.dismiss() }
            .setPositiveButton("NEXT LOT") { d, _ ->
                d.dismiss()
                viewModel.confirmNextLot()
            }
            .setCancelable(true).show()
    }

    private fun lotModeLabel(m: LotMode) = when (m) {
        LotMode.SINGLE_LOT -> "Bundle"
        LotMode.PER_ITEM -> "Per Item"
        LotMode.PER_PHOTO -> "Per Photo"
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Camera init
    // ─────────────────────────────────────────────────────────────────────────

    private fun startCamera() {
        if (::engine.isInitialized || !hasCapturePermissions() || isFinishing || isDestroyed) return
        engine = CameraViewEngine(this, this)
        val captureGeneration = viewModel.repository.captureGeneration
        engine.setCaptureIdentity(viewModel.repository.captureIdentitySnapshot(), captureGeneration)
        fun currentCaptureScope() = !isDestroyed && !isFinishing && captureGeneration == viewModel.repository.captureGeneration
        engine.onCaptureSaved = { ticket ->
            if (currentCaptureScope()) {
                queuedShots[ticket.id] = ticket
                processingCount = queuedShots.size
                releaseShutter(ticket)
                schedulePreviewFreezeClear()
                startThumbnailPulse()
            }
        }
        engine.onQueuedPhotoReady = { uri, ticket ->
            if (!currentCaptureScope() || ticket.lotNumber != viewModel.currentLotNumber.value) false
            else {
                val duplicate = viewModel.repository.getEffectiveLots().any { row -> (row.files + row.extraFiles).any { it.uri == uri.toString() } }
                if (!duplicate) viewModel.onPhotoCaptured(uri, ticketMode = ticket.mode, ticketExtra = ticket.isExtra)
                else viewModel.persistSessionForBackground()
                lastPhotoUri = uri; lastVideoUri = null
                binding.galleryCount.visibility = View.VISIBLE
                loadGalleryThumb(uri)
                viewModel.repository.isCapturePersisted()
            }
        }
        engine.onQueuedPhotoSettled = { ticket, error ->
            if (currentCaptureScope()) {
                queuedShots.remove(ticket.id)
                processingCount = queuedShots.size
                if (processingCount == 0) stopThumbnailPulse()
                if (error != null) toast(error)
                engine.resumePendingPhotos()
                binding.root.post { drainQueuedTaps() }
            }
        }
        engine.onQueuedCaptureError = { ticket, message ->
            if (currentCaptureScope()) { releaseShutter(ticket); toast(message) }
        }
        binding.previewView.scaleType = androidx.camera.view.PreviewView.ScaleType.FILL_CENTER
        binding.previewView.implementationMode =
            androidx.camera.view.PreviewView.ImplementationMode.COMPATIBLE
        binding.previewView.previewStreamState.removeObservers(this)
        binding.previewView.previewStreamState.observe(this) { state ->
            if (state == androidx.camera.view.PreviewView.StreamState.STREAMING) {
                maybeClearPreviewFreezeFromStream()
            }
        }
        zoomSynced = false
        selectedImageFormat = ImageFormatStore.load(this)
        engine.setOutputFormat(selectedImageFormat)
        engine.set12MPOutput(OutputQualityStore.load(this))
//        engine.onDeviceLimitsReady = { limits ->
//            deviceLimits = limits; viewModel.setDeviceLimits(limits)
//            runOnUiThread {
//                val ok = limits?.supportsManualSensor == true
//                binding.btnProMode.visibility =
//                    if (ok && currentCameraMode != CameraMode.VIDEO) View.VISIBLE else View.GONE
//                if (ok && limits != null && !proControlsInitialized) {
//                    proControlsInitialized = true; resetProControlsToAuto()
//                }
//            }
//        }

        engine.onDeviceLimitsReady = { limits ->
            deviceLimits = limits; viewModel.setDeviceLimits(limits)
            runOnUiThread {
                val ok = limits?.supportsManualSensor == true
                binding.btnProMode.visibility =
                    if (ok && currentCameraMode != CameraMode.VIDEO) View.VISIBLE else View.GONE
                if (ok && limits != null && !proControlsInitialized) {
                    proControlsInitialized = true

                    // Load persisted global Pro settings on first camera bind.
                    // ProSettingsStore.load() returns null only when the user has
                    // never saved custom settings — fall back to auto in that case.
                    val persisted = ProSettingsStore.load(this)
                    if (persisted != null) {
                        // Show the saved values in the UI controls
                        applyProSettingsToUI(persisted, applyToEngine = true)
                        // Also push them into the current lot so lot-switching logic
                        // sees them as the starting point
                        val lotNum = viewModel.currentLotNumber.value ?: 1
                        viewModel.saveProSettingsForLot(lotNum, persisted)
                    } else {
                        resetProControlsToAuto()
                    }
                }
            }
        }

        engine.onPreviewFilterChanged = { contrast, color ->
            runOnUiThread { applyPreviewLayerFilter(contrast, color) }
        }

        engine.onZoomChanged = { ratio, min, max ->
            currentZoom = ratio
            runOnUiThread {
                val trueMin = engine.getTrueMinZoom().coerceAtMost(min)
                val cappedMax = max.coerceAtMost(8f)

                val isPortrait = currentCameraMode == CameraMode.PORTRAIT
                val isNightNoUW = currentCameraMode == CameraMode.NIGHT
                        && (!engine.hasUltraWideLens() || engine.isFrontCamera())
                val isRestrictedMode = isPortrait || isNightNoUW

                if (!zoomSynced) {
                    zoomSynced = true
                    syncZoomButtonsToDevice(min, cappedMax)
                }

                val effectiveSliderMin = if (isRestrictedMode) 1f else trueMin
                binding.zoomSliderView?.minZoom = effectiveSliderMin
                binding.zoomSliderView?.maxZoom = cappedMax

                if (isRestrictedMode) {
                    binding.zoom06.visibility = View.GONE
                }

                val displayRatio = if (isRestrictedMode) ratio.coerceAtLeast(1f) else ratio

                if (!isUserDraggingZoom && !suppressZoomUICallback) {
                    binding.zoomSliderView?.currentZoom = displayRatio
                    binding.zoomRatioLabel?.text = "${"%.1f".format(displayRatio)}x"
                    updateZoomUI(displayRatio)
                }
            }
        }

//        engine.onPhotoCaptured = { uri ->
//            lastPhotoUri = uri;
//            lastVideoUri = null
//            captureInFlight.set(false)
//            runOnUiThread {
//                schedulePreviewFreezeClear()
//                viewModel.onPhotoCaptured(uri)
//                binding.galleryCount.visibility = View.VISIBLE
//            }
//        }

        // The engine publishes this URI only after processing and durable storage.
        engine.onPhotoCaptured = { tempUri ->
            lastPhotoUri = tempUri
            lastVideoUri = null

            // Keep the capture lock until the durable result is available.
            captureInFlight.set(false)

            runOnUiThread {
                val uiStartMs = SystemClock.elapsedRealtime()
                schedulePreviewFreezeClear()

                processingCount++
                viewModel.onPhotoCaptured(tempUri)
                binding.galleryCount.visibility = View.VISIBLE
                val tapDeltaMs =
                    if (lastShutterTapAtMs > 0L) SystemClock.elapsedRealtime() - lastShutterTapAtMs else -1L
                Log.d(
                    "AuctionCameraTiming",
                    "thumbnail_update deltaFromTapMs=$tapDeltaMs uiMs=${SystemClock.elapsedRealtime() - uiStartMs}"
                )

                startThumbnailPulse()
            }
        }

        // 2. THIS FIRES 1-2 SECONDS LATER (In the background)
//        engine.onPhotoProcessed = { oldTempUri, finalGalleryUri ->
//            runOnUiThread {
//                // This will automatically trigger the LiveData observer to refresh the UI!
//                viewModel.updatePhotoUri(oldTempUri, finalGalleryUri)
//
//                // (Notice we removed the manual loadGalleryThumb(oldTempUri) call because
//                // the ViewModel LiveData handles the refresh for us automatically now).
//            }
//        }
        engine.onPhotoProcessed = { oldTempUri, finalGalleryUri, width, height ->
            runOnUiThread {
                val processedUiStartMs = SystemClock.elapsedRealtime()
                processingCount = (processingCount - 1).coerceAtLeast(0)
                if (processingCount == 0) stopThumbnailPulse()
                loadGalleryThumb(oldTempUri)
                // Tell the ViewModel to swap the temporary Uri for the permanent one
                viewModel.updatePhotoUri(oldTempUri, finalGalleryUri, width, height)
                Log.d(
                    "AuctionCameraTiming",
                    "processed_update uiMs=${SystemClock.elapsedRealtime() - processedUiStartMs} size=${width}x$height"
                )
            }
        }

        engine.onVideoRecordingStarted = { runOnUiThread { onRecordingStarted() } }
        engine.onVideoReady = {
            runOnUiThread {
                isVideoReady = true
                if (pendingStartRecording) {
                    pendingStartRecording = false; engine.startRecording()
                }
            }
        }
        engine.onVideoFinalizing = { uri -> viewModel.onVideoRecorded(uri) }
        engine.onVideoRecorded = { uri -> onRecordingSaved(uri) }
//        engine.onEVChanged = { ev ->
//            runOnUiThread { viewModel.setCurrentEV(ev); updateEVLabel(ev); syncEVSeekBar(ev) }
//        }

        engine.onEVChanged = { ev ->
            runOnUiThread {
                currentEVLevel = ev // Save it for rotation
                viewModel.setCurrentEV(ev)
                updateEVLabel(ev)
                syncEVSeekBar(ev)
            }
        }

        engine.onTrueMinZoomDetected = { trueMin ->
            runOnUiThread {
                if (engine.isFrontCamera()) {
                    binding.zoom06.visibility = View.GONE; return@runOnUiThread
                }
                val isRestrictedMode = currentCameraMode == CameraMode.PORTRAIT
                        || (currentCameraMode == CameraMode.NIGHT
                        && (!engine.hasUltraWideLens() || engine.isFrontCamera()))
                if (!hasConfirmedUltraWide && trueMin < 0.95f) {
                    hasConfirmedUltraWide = true
                    btn06Label = "%.1f".format(trueMin)
                    binding.zoom06.text = btn06Label
                    if (!isRestrictedMode) binding.zoom06.visibility = View.VISIBLE
                } else if (!hasConfirmedUltraWide) {
                    hasConfirmedUltraWide = true
                    btn06Label = "%.1f".format(trueMin)
                    binding.zoom06.text = btn06Label
                    if (!isRestrictedMode) binding.zoom06.visibility = View.VISIBLE
                }
                if (isRestrictedMode) {
                    binding.zoom06.visibility = View.GONE
                }
                binding.zoomSliderView?.minZoom = if (isRestrictedMode) 1f else trueMin
            }
        }

        engine.onFpsRangesReady = { _ ->
            runOnUiThread {
                val presets = AeFpsController.getSupportedPresets()
                binding.includePro.fps15.visibility =
                    if (presets.any { it.min == 15 }) View.VISIBLE else View.GONE
                binding.includePro.fps30.visibility =
                    if (presets.any { it.min == 30 }) View.VISIBLE else View.GONE
                binding.includePro.fps60.visibility =
                    if (presets.any { it.min == 60 }) View.VISIBLE else View.GONE
            }
        }

        engine.onExtensionsReady = { list -> runOnUiThread { buildExtensionChips(list) } }
        engine.onExtensionModeChanged = { mode ->
            runOnUiThread {
                viewModel.setExtensionMode(mode)
                val targetChip = when {
                    currentCameraMode == CameraMode.NIGHT -> CHIP_NIGHT
                    currentCameraMode == CameraMode.PORTRAIT -> CHIP_PORTRAIT
                    mode is CameraViewExtensionMode.HDR -> CHIP_HDR
                    currentCameraMode == CameraMode.PHOTO
                            && engine.getActiveExtensionMode() is CameraViewExtensionMode.Normal -> CHIP_NORMAL

                    else -> currentActiveChipKey()
                }
                syncExtensionChipsByKey(targetChip)
                syncProPanelForExtension(mode)
                showEV(true)
            }
        }

        engine.onManualConflictResolved = { reason ->
            runOnUiThread {
                binding.includePro.apply {
                    isoSeekBar.progress = 0; shutterSeekBar.progress = 0
                    isoLabel.text = "ISO  AUTO"; isoLabel.setTextColor(AMBER)
                    shutterLabel.text = "SS   AUTO"; shutterLabel.setTextColor(AMBER)
                }
                try {
                    Snackbar.make(binding.root, reason, Snackbar.LENGTH_LONG).show()
                } catch (e: Exception) {
                    toast(reason)
                }
            }
        }

        engine.onNightModeUriReady = { uri ->
            captureInFlight.set(false)
            runOnUiThread {
                schedulePreviewFreezeClear()
                viewModel.onPhotoCaptured(uri)
            }
        }

        engine.onCameraRebound = {
            runOnUiThread {
                if (isFinishing || isDestroyed || !::engine.isInitialized) return@runOnUiThread
                if (!engine.isFrontCamera()) {
                    flashState = userSelectedFlashState
                    applyFlashState(flashState)
                }
                val torchOn = (flashState == ON)
                val autoFlash = (flashState == AUTO)
                engine.syncFlashFromOutside(torchOn, autoFlash)
                if (currentCameraMode == CameraMode.PORTRAIT) applyPortraitFlash()

                val hasFlash = engine.hasFlash()
                binding.btnFlash.isEnabled = hasFlash
                binding.btnFlash.alpha = if (hasFlash) 1f else 0.4f
                showEV(engine.isEVSupported())
                if (!engine.isFrontCamera() && deviceLimits?.supportsManualSensor == true
                    && currentCameraMode != CameraMode.VIDEO
                ) {
                    binding.btnProMode.visibility = View.VISIBLE
                } else {
                    binding.btnProMode.visibility = View.GONE
                }

                engine.probeExtensions(binding.previewView, isPhoto())
                if (isBoxModeActive) {
                    binding.aeafOverlay.forceNotifyCurrentRegion()
                }

                // Restore zoom after returning from image preview
                val zoomToRestore = pendingZoomRestore
                if (zoomToRestore != null) {
                    pendingZoomRestore = null
                    suppressZoomUICallback = true
                    binding.previewView.removeCallbacks(clearSuppressRunnable)
                    binding.previewView.postDelayed(clearSuppressRunnable, 1500)
                    currentZoom = zoomToRestore
                    engine.setZoom(zoomToRestore)
                    binding.zoomSliderView?.currentZoom = zoomToRestore
                    binding.zoomRatioLabel?.text = "${"%.1f".format(zoomToRestore)}x"
                    updateZoomUI(zoomToRestore)
                }
            }
        }
        engine.onRecordingError = { err ->
            runOnUiThread {
                captureInFlight.set(false)
                clearPreviewFreeze()
                if (processingCount == 0) stopThumbnailPulse()
                stopRecordingUI()
                val isTransient = err.lowercase().let {
                    it.contains("camera is closed") || it.contains("camera closed") ||
                            it.contains("camera disconnected") || it.contains("capture failed")
                }
                if (!isTransient) toast(err)
            }
        }
        engine.onNightModeError = { err ->
            runOnUiThread {
                captureInFlight.set(false)
                clearPreviewFreeze()
                if (processingCount == 0) stopThumbnailPulse()
                toast("Night failed: $err")
            }
        }
        engine.setInitialExtensionMode(CameraViewExtensionMode.Normal)
        engine.startPhoto(binding.previewView)
        binding.previewView.postDelayed({ engine.probeExtensions(binding.previewView, true) }, 300)
        setupEVSlider()
        setupFlashAndFrontCamera()
        setupTapToFocus()
        setupPinchToZoom()
        setupProMode()
    }


    override fun onConfigurationChanged(newConfig: Configuration) {
        // --- Calculate rotation delta and mathematically rotate the frozen frame ---
        val currentRotation = getCurrentDisplayRotationSafe()
        val oldDeg = getRotationDegrees(lastDisplayRotation)
        val newDeg = getRotationDegrees(currentRotation)

        var delta = newDeg - oldDeg
        // Fix wraparound for Landscape Left to/from Portrait transitions
        if (delta == -270) delta = 90
        if (delta == 270) delta = -90

        lastDisplayRotation = currentRotation

        val transitionFrame = runCatching {
            val rawFrame = binding.previewView.bitmap ?: return@runCatching null
            if (delta != 0) {
                val matrix = android.graphics.Matrix().apply { postRotate(delta.toFloat()) }
                val rotated = Bitmap.createBitmap(
                    rawFrame,
                    0,
                    0,
                    rawFrame.width,
                    rawFrame.height,
                    matrix,
                    true
                )
                if (rotated != rawFrame) rawFrame.recycle() // Free memory instantly
                rotated
            } else {
                rawFrame // If no degree change detected, use original
            }
        }.getOrNull()

        super.onConfigurationChanged(newConfig)

        // 1. Prevent memory/window leaks from the old layout
        dismissFlashPopup()
        stopThumbnailPulse()
        clearPreviewFreeze()
        recordingTimer?.let { binding.previewView.removeCallbacks(it) }

        // 2. Remove old LiveData observers so they don't update detached views
        viewModel.currentLotPhotoCount.removeObservers(this)
        viewModel.currentLotUris.removeObservers(this)
        viewModel.mainCount.removeObservers(this)
        viewModel.extraCount.removeObservers(this)
        viewModel.totalCount.removeObservers(this)
        viewModel.currentLotNumber.removeObservers(this)
        viewModel.currentProSettings.removeObservers(this)
        viewModel.viewedLotMode.removeObservers(this)
        viewModel.modeMismatch.removeObservers(this)
        viewModel.nextLotConfirm.removeObservers(this)
        binding.previewView.previewStreamState.removeObservers(this)

//        binding = ActivityCameraViewBinding.inflate(layoutInflater)
//        setContentView(binding.root)


        val configContext = createConfigurationContext(newConfig)
        val themedContext = androidx.appcompat.view.ContextThemeWrapper(
            configContext,
            theme
        )
        val inflater = layoutInflater.cloneInContext(themedContext)
        binding = ActivityCameraViewBinding.inflate(inflater)
        setContentView(binding.root)
        setupEdgeToEdge()
        // Clear stale view references
        extensionChipMap.clear()
        currentHighlightedBtn = null

        // 4. Re-initialize all UI components
        setupLotNavigation()
        setupCaptureModeButtons()
        setupCameraModeButtons()
        setupZoom()
        setupGalleryClick()
        setupResolutionToggle()
        setupFocusLogic()
        applyBoxFocusUi()
        setupEffectSliders()
        setupImageFormatPicker()
        setupEVSlider()
        setupFlashAndFrontCamera()
        setupTapToFocus()
        setupPinchToZoom()
        setupProMode()

        // 5. Re-attach View Observers
        observeViewModel()

        // 6. Restore the active UI states
        restoreUiState()
        if (processingCount > 0) startThumbnailPulse()

        // 7. Swap the Camera Engine over to the newly inflated PreviewView
        if (::engine.isInitialized) {
            binding.previewView.scaleType = androidx.camera.view.PreviewView.ScaleType.FILL_CENTER
            binding.previewView.implementationMode =
                androidx.camera.view.PreviewView.ImplementationMode.COMPATIBLE

            binding.previewView.previewStreamState.observe(this) { state ->
                if (state == androidx.camera.view.PreviewView.StreamState.STREAMING) {
                    maybeClearPreviewFreezeFromStream()
                }
            }

            engine.updatePreviewSurface(binding.previewView)

            // Delay extension probe slightly to ensure surface is ready
            binding.previewView.postDelayed({
                engine.probeExtensions(binding.previewView, isPhoto())
            }, 500)
        }

        // 8. If video was recording during rotation, resume the timer UI
        if (isRecording && recordingTimer != null) {
            binding.previewView.postDelayed(recordingTimer!!, 1000)
        }

        // --- STEP 9: Apply the frozen frame to the NEW layout to hide the black flash ---
        if (transitionFrame != null) {
            binding.previewView.post {
                val drawable = BitmapDrawable(resources, transitionFrame)
                drawable.setBounds(0, 0, binding.previewView.width, binding.previewView.height)
                binding.previewView.overlay.add(drawable)

                // Smoothly fade it out instead of snapping off
                val animator = android.animation.ObjectAnimator.ofInt(drawable, "alpha", 255, 0)
                animator.duration = 200
                animator.startDelay = 600
                animator.start()

                binding.previewView.postDelayed({
                    binding.previewView.overlay.remove(drawable)
                    transitionFrame.recycle() // Safely recycle! No memory leak.
                }, 800)
            }
        }
        // --------------------------------------------------------------------------------
    }

    private fun restoreUiState() {
        // Restore Capture Mode Highlights
        currentCaptureMode?.let { highlightCaptureModeButton(it) }
        updateModeSubtitle(currentCaptureMode)

        // Restore Flash
        applyFlashState(flashState)

        // Restore Resolution Chip
        val mp = binding.includeItemMP
        listOf(
            mp.res12M to "12M",
            mp.res50M to "50M",
            mp.res200M to "200M"
        ).forEach { (chip, lbl) ->
            chip.setTextColor(if (lbl == selectedResolution) AMBER else Color.WHITE)
            chip.setBackgroundResource(if (lbl == selectedResolution) R.drawable.bg_zoom_selected else R.drawable.bg_zoom_pill)
        }
        binding.resToggle.text = selectedResolution

        // Restore EV Slider limits and progress
        syncEVSeekBar(currentEVLevel)
        updateEVLabel(currentEVLevel)
        if (::engine.isInitialized) showEV(engine.isEVSupported())

        // Restore Pro Mode UI
        val proAllowed = ::engine.isInitialized && !engine.isFrontCamera() &&
                deviceLimits?.supportsManualSensor == true &&
                currentCameraMode != CameraMode.VIDEO
        binding.btnProMode.visibility = if (proAllowed) View.VISIBLE else View.GONE
        binding.includePro.root.visibility = if (isProMode) View.VISIBLE else View.GONE
        binding.btnProMode.setTextColor(if (isProMode) AMBER else Color.WHITE)
        if (isProMode) {
            val lotNum = viewModel.currentLotNumber.value ?: 1
            if (viewModel.hasProSettingsForLot(lotNum)) {
                val settings = viewModel.getProSettingsForLot(lotNum)
                applyProSettingsToUI(
                    settings,
                    applyToEngine = false
                ) // Engine is already applying it
            }
        }

        // Restore Video Recording UI Elements
        if (isRecording) {
            binding.recordingTimer.visibility = View.VISIBLE
            binding.recordingDot.visibility = View.VISIBLE
            binding.imageViewRecordVideo.setImageResource(R.drawable.ic_pause)
            binding.recordingTimer.text =
                "%02d:%02d".format(recordingSeconds / 60, recordingSeconds % 60)
            binding.extensionModeBar.visibility = View.GONE
            binding.buttonFrontCamera.visibility = View.GONE
            binding.btnProMode.visibility = View.GONE
        }

        // Restore Zoom Bar & Selected Ratio
        if (::engine.isInitialized) {
            syncZoomButtonsToDevice(
                engine.getTrueMinZoom(),
                engine.getMaxZoomRatio().coerceAtMost(8f)
            )
            binding.zoomSliderView?.currentZoom = currentZoom
            binding.zoomRatioLabel?.text = "${"%.1f".format(currentZoom)}x"
            updateZoomUI(currentZoom)
        }
    }


    private fun applyPreviewLayerFilter(contrast: Int, color: Int) {
        if (contrast == 0 && color == 0) {
            binding.previewView.setLayerType(View.LAYER_TYPE_NONE, null)
            return
        }

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

        binding.previewView.setLayerType(
            View.LAYER_TYPE_HARDWARE,
            android.graphics.Paint().apply {
                colorFilter = android.graphics.ColorMatrixColorFilter(cm)
            }
        )
    }

    private fun applyProSettingsToEngine(settings: ProSettings) {
        if (!::engine.isInitialized) return
        engine.applyProSettingsBatch(
            isoProgress = settings.isoProgress,
            shutterProgress = settings.shutterProgress,
            fpsMin = settings.fpsMin,
            fpsMax = settings.fpsMax,
            wbIndex = settings.wbIndex,
            shutterValues = shutterValues,
            previewView = binding.previewView,
            isPhotoMode = isPhoto(),
            deviceLimits = deviceLimits
        )
        engine.setImageEffects(
            settings.contrast * 10,
            settings.color * 10,
            settings.sharpness * 10
        )
    }

    private fun reapplyCurrentLotProEffects() {
        if (!::engine.isInitialized || currentCameraMode == CameraMode.VIDEO) return
        val lotNum = viewModel.currentLotNumber.value ?: 1
        val settings = viewModel.getProSettingsForLot(lotNum)
        applyProSettingsToEngine(settings)
        applyPreviewLayerFilter(settings.contrast * 10, settings.color * 10)
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Visual feedback
    // ─────────────────────────────────────────────────────────────────────────

    private fun animateModeButtonTap(view: View) {
        view.animate().scaleX(0.87f).scaleY(0.87f).setDuration(70)
            .withEndAction { view.animate().scaleX(1f).scaleY(1f).setDuration(90).start() }.start()
    }

    private var freezeFadeAnimator: android.animation.ValueAnimator? = null

    private fun freezePreviewFrame() {
        if (binding.previewView.width <= 0 || binding.previewView.height <= 0) return
        val frame = runCatching { binding.previewView.bitmap }.getOrNull() ?: return
        if (isLikelyBlackFrame(frame)) {
            if (!frame.isRecycled) frame.recycle()
            if (previewFreezeDrawable != null) {
                binding.previewView.removeCallbacks(clearPreviewFreezeRunnable)
                binding.previewView.postDelayed(clearPreviewFreezeRunnable, 1800)
            }
            return
        }

        freezeFadeAnimator?.cancel()
        previewFreezeDrawable?.let { binding.previewView.overlay.remove(it) }

        previewFreezeDrawable = BitmapDrawable(resources, frame).also { drawable ->
            drawable.setBounds(0, 0, binding.previewView.width, binding.previewView.height)
            drawable.alpha = 255
            binding.previewView.overlay.add(drawable)
        }
        previewFreezeStartedAtMs = android.os.SystemClock.elapsedRealtime()
        binding.previewView.removeCallbacks(clearPreviewFreezeRunnable)
        binding.previewView.postDelayed(clearPreviewFreezeRunnable, 1800)
    }

    private fun maybeClearPreviewFreezeFromStream() {
        if (captureInFlight.get()) return
        if (previewFreezeDrawable == null) return
        val heldForMs = android.os.SystemClock.elapsedRealtime() - previewFreezeStartedAtMs
        if (heldForMs < 220L) return
        clearPreviewFreeze()
    }

    private fun schedulePreviewFreezeClear(delayMs: Long = 180L) {
        binding.previewView.removeCallbacks(delayedClearPreviewFreezeRunnable)
        binding.previewView.postDelayed(delayedClearPreviewFreezeRunnable, delayMs)
    }

    private fun isLikelyBlackFrame(bitmap: Bitmap): Boolean {
        if (bitmap.width <= 0 || bitmap.height <= 0) return true
        val sampleXs = intArrayOf(bitmap.width / 4, bitmap.width / 2, (bitmap.width * 3) / 4)
        val sampleYs = intArrayOf(bitmap.height / 4, bitmap.height / 2, (bitmap.height * 3) / 4)
        var total = 0
        var count = 0
        for (y in sampleYs) {
            for (x in sampleXs) {
                val px = bitmap.getPixel(
                    x.coerceIn(0, bitmap.width - 1),
                    y.coerceIn(0, bitmap.height - 1)
                )
                val r = (px shr 16) and 0xff
                val g = (px shr 8) and 0xff
                val b = px and 0xff
                total += (r * 30 + g * 59 + b * 11) / 100
                count++
            }
        }
        val avgLuma = if (count > 0) total / count else 0
        return avgLuma < 16
    }

    private fun clearPreviewFreeze() {
        if (!::binding.isInitialized) return
        binding.previewView.removeCallbacks(clearPreviewFreezeRunnable)
        binding.previewView.removeCallbacks(delayedClearPreviewFreezeRunnable)
        val drawable = previewFreezeDrawable ?: return
        previewFreezeDrawable = null

        freezeFadeAnimator?.cancel()
        freezeFadeAnimator = android.animation.ValueAnimator.ofInt(255, 0).apply {
            duration = 180
            addUpdateListener { anim ->
                drawable.alpha = anim.animatedValue as Int
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    binding.previewView.overlay.remove(drawable)
                }
            })
            start()
        }
    }

    private inline fun withPreviewFreeze(action: () -> Unit) {
        freezePreviewFrame()
        action()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Gallery thumb
    // ─────────────────────────────────────────────────────────────────────────

    private fun loadGalleryThumb(uri: Uri) {
        thumbLoadJob?.cancel()
        thumbLoadJob = lifecycleScope.launch {
            val cacheKey = uri.toString()
            val bmp = withContext(Dispatchers.IO) {
                try {
                    if (LotGalleryActivity.isVideoUri(uri)) {
                        MediaMetadataRetriever().let { r ->
                            try {
                                if (uri.scheme == "file") r.setDataSource(uri.path)
                                else r.setDataSource(this@CameraViewActivity, uri)
                                r.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                            } finally {
                                r.release()
                            }
                        }
                    } else {
                        val raw = when (uri.scheme) {
                            "file" -> {
                                val path = uri.path ?: return@withContext null
                                val opts = android.graphics.BitmapFactory.Options().apply {
                                    inJustDecodeBounds = true
                                    android.graphics.BitmapFactory.decodeFile(path, this)
                                    inSampleSize = calcSampleSize(outWidth, outHeight)
                                    inJustDecodeBounds = false
                                }
                                android.graphics.BitmapFactory.decodeFile(path, opts)
                            }

                            "content" -> {
                                val opts = android.graphics.BitmapFactory.Options().apply {
                                    inJustDecodeBounds = true
                                }
                                contentResolver.openInputStream(uri)?.use {
                                    android.graphics.BitmapFactory.decodeStream(it, null, opts)
                                }
                                opts.inSampleSize = calcSampleSize(opts.outWidth, opts.outHeight)
                                opts.inJustDecodeBounds = false
                                contentResolver.openInputStream(uri)?.use {
                                    android.graphics.BitmapFactory.decodeStream(it, null, opts)
                                }
                            }

                            else -> null
                        }
                        raw?.let { correctBitmapOrientation(it, uri) }
                    }
                } catch (e: Exception) {
                    Log.e("GalleryThumb", "decode failed: ${e.message}")
                    null
                }
            }
            if (!isFinishing && !isDestroyed && bmp != null) {
                thumbCache.put(cacheKey, bmp)
                binding.galleryPreview.setImageBitmap(bmp)
            }
        }
    }

    private fun correctBitmapOrientation(
        bmp: android.graphics.Bitmap,
        uri: Uri
    ): android.graphics.Bitmap {
        return try {
            val exif = when (uri.scheme) {
                "file" -> androidx.exifinterface.media.ExifInterface(uri.path!!)
                "content" -> contentResolver.openInputStream(uri)
                    ?.let { androidx.exifinterface.media.ExifInterface(it) } ?: return bmp

                else -> return bmp
            }

            val rotation = when (
                exif.getAttributeInt(
                    androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
                    androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL
                )
            ) {
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }

            if (rotation == 0f) return bmp

            val matrix = android.graphics.Matrix().apply { postRotate(rotation) }
            android.graphics.Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, matrix, true)
                .also { if (it != bmp) bmp.recycle() }
        } catch (e: Exception) {
            Log.e("GalleryThumb", "EXIF rotation failed: ${e.message}")
            bmp
        }
    }

    private fun calcSampleSize(w: Int, h: Int): Int {
        var s = 1
        if (w > 200 || h > 200) while ((w / s / 2) >= 200 && (h / s / 2) >= 200) s *= 2
        return s
    }

    private fun turnOffFlash() {
        if (!flashEnabled && flashState == OFF) return
        dismissFlashPopup()
        applyFlashState(OFF)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lot navigation
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupLotNavigation() {
        binding.imageLeftArrow.setOnClickListener {
            if (!waitForCapture()) viewModel.goToPrevLot()
        }
        binding.imageRightArrow.setOnClickListener {
            if (!waitForCapture()) viewModel.goToNextLot()
        }

        binding.textViewDone.setOnClickListener {
            if (waitForCapture()) return@setOnClickListener
            val returnStartMs = SystemClock.elapsedRealtime()
            viewModel.repository.finaliseCurrentLot(viewModel.currentLotNumber.value ?: 1)
            viewModel.finalisePendingExtraPhotos()
            val allLots = viewModel.repository.getAllLots()

            val json = try { viewModel.repository.exportCapture() } catch (_: Exception) {
                toast("Draft could not be saved. Free device storage and tap Done again. Your photos are still in the camera.")
                return@setOnClickListener
            }
            Log.d(
                "AuctionCameraTiming",
                "return_payload lots=${allLots.size} bytes=${json.length} buildMs=${SystemClock.elapsedRealtime() - returnStartMs}"
            )

            val resultIntent = try {
                expo.modules.auctioncamera.CameraPayloadStore.resultIntent(this, intent, json)
            } catch (error: Exception) {
                Log.e("AuctionCameraTiming", "Camera result handoff could not be saved", error)
                toast("Draft could not be handed back. Free device storage and tap Done again. Your photos are still saved.")
                return@setOnClickListener
            }
            setResult(RESULT_OK, resultIntent)
            viewModel.clearSession()
            finish()
        }
    }

    private fun waitForCapture(): Boolean {
        if (pendingStartRecording || isRecordButtonLocked || (::engine.isInitialized && engine.isRecording())) {
            toast(if (::engine.isInitialized && engine.isStopping()) "Please wait for the video to finish saving." else "Stop recording before leaving this lot.")
            return true
        }
        if (::engine.isInitialized && engine.hasPendingPhotos() && processingCount == 0) engine.resumePendingPhotos(retryCompleted = true)
        if (!captureInFlight.get() && processingCount == 0 && (!::engine.isInitialized || !engine.hasPendingPhotos())) return false
        toast("Please wait for the photo to finish saving.")
        return true
    }

    private fun setupCaptureModeButtons() {
        currentCaptureMode = null
        clearCaptureModeHighlights()
        updateModeSubtitle(null)

        binding.textViewBundle.setOnClickListener {
            onCaptureModeButtonTapped(CaptureMode.BUNDLE, binding.textViewBundle)
//            turnOffProMode()
        }
        binding.textViewItem.setOnClickListener {
            onCaptureModeButtonTapped(CaptureMode.ITEM, binding.textViewItem)
//            turnOffProMode()
        }
        binding.textViewPhoto.setOnClickListener {
            onCaptureModeButtonTapped(CaptureMode.PHOTO, binding.textViewPhoto)
//            turnOffProMode()
        }
        binding.textViewBundleExtra?.setOnClickListener {
            onCaptureModeButtonTapped(
                CaptureMode.BUNDLE,
                it,
                isExtra = true
            )
        }
    }

    private fun onCaptureModeButtonTapped(mode: CaptureMode, btn: View, isExtra: Boolean = false, fromQueue: Boolean = false) {
        binding.cameraHeader.collapseExposure()
        if (captureInFlight.get() || PhotoWorkQueue.activeCount() >= 3) {
            // Only a tap in the mode being shot can wait; changing mode still needs the shutter free.
            if (!fromQueue && (isExtra || viewModel.captureMode.value == mode)) queueTap(mode, isExtra, btn)
            return
        }
        if (!fromQueue) lastUserTapAtMs = SystemClock.elapsedRealtime()
        if ((processingCount > 0 || (::engine.isInitialized && engine.hasPendingPhotos())) && !isExtra && viewModel.captureMode.value != mode) {
            toast("Finish saving these shots before changing capture mode."); return
        }
        if (viewModel.repository.isStructureLocked && !isExtra && viewModel.getLotExistingMode() != mode) {
            toast("This imported lot keeps its saved capture mode. Use its highlighted capture button.")
            return
        }
        if (!::engine.isInitialized) return
        if (currentCameraMode == CameraMode.VIDEO) return
        animateModeButtonTap(btn)

        val lotExistingMode = viewModel.getLotExistingMode()
        if (!isExtra && lotExistingMode != null && lotExistingMode != mode) {
            val existingLabel = when (lotExistingMode) {
                CaptureMode.BUNDLE -> "Bundle"
                CaptureMode.ITEM -> "Per Item"
                CaptureMode.PHOTO -> "Per Photo"
            }
            val attemptedLabel = when (mode) {
                CaptureMode.BUNDLE -> "Bundle"
                CaptureMode.ITEM -> "Per Item"
                CaptureMode.PHOTO -> "Per Photo"
            }
            val lotNum = viewModel.currentLotNumber.value ?: 1

            AlertDialog.Builder(this)
                .setTitle("Mode Mismatch")
                .setMessage(
                    "Lot $lotNum uses \"$existingLabel\" mode.\n\n" +
                            "Switching to \"$attemptedLabel\" will move you to the next " +
                            "available lot that accepts \"$attemptedLabel\" images."
                )
                .setNegativeButton("CANCEL") { d, _ -> d.dismiss() }
                .setPositiveButton("NEXT LOT") { d, _ ->
                    d.dismiss()
                    viewModel.handleNewLotFromLock(mode)
                    applyCaptureModeUI(mode)
                    fireCapture(mode)
                }
                .setCancelable(true)
                .show()
            return
        }

        if (!isExtra) viewModel.setCaptureMode(mode)
        fireCapture(mode, isExtra)
    }

    private fun queueTap(mode: CaptureMode, isExtra: Boolean, btn: View) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastUserTapAtMs < BURST_TAP_MIN_GAP_MS) return
        if (queuedTaps.size >= MAX_QUEUED_TAPS) { toast("Photos are still being taken. Tap again in a moment."); return }
        lastUserTapAtMs = now
        queuedTaps.addLast(QueuedTap(mode, isExtra, viewModel.currentLotNumber.value ?: 1))
        animateModeButtonTap(btn)
        HapticCaptureHelper.hapticPulse(this)
    }

    private fun drainQueuedTaps() {
        if (!::binding.isInitialized || isFinishing || isDestroyed) return
        if (captureInFlight.get() || PhotoWorkQueue.activeCount() >= 3) return
        val next = queuedTaps.removeFirstOrNull() ?: return
        // Never move a waiting tap into another lot.
        if (next.lotNumber != (viewModel.currentLotNumber.value ?: 1)) { queuedTaps.clear(); return }
        val button = if (next.isExtra) binding.textViewBundleExtra ?: binding.textViewBundle else when (next.mode) {
            CaptureMode.BUNDLE -> binding.textViewBundle
            CaptureMode.ITEM -> binding.textViewItem
            CaptureMode.PHOTO -> binding.textViewPhoto
        }
        onCaptureModeButtonTapped(next.mode, button, next.isExtra, fromQueue = true)
    }

    private fun fireCapture(mode: CaptureMode, isExtra: Boolean = false) {
        binding.cameraHeader.collapseExposure()
        if (PhotoWorkQueue.activeCount() >= 3) { toast("Three photos are saving. The next shot will be ready shortly."); return }
        if (viewModel.repository.hasReachedFixedPhotoLimit(viewModel.currentLotNumber.value ?: 1)) {
            toast("This lot already has 200 photos. Remove a photo before taking another; your saved photos are unchanged.")
            return
        }
        if (viewModel.repository.isStructureLocked) {
            val index = (viewModel.currentLotNumber.value ?: 1) - 1
            val saved = viewModel.repository.getEffectiveLots().getOrNull(index)?.let { it.files.size + it.extraFiles.size } ?: 0
            if (saved + queuedShots.values.count { it.lotNumber == index + 1 } >= 200) { toast("This lot already has 200 saved or pending photos."); return }
        }
        if (!::engine.isInitialized) return
        if (engine.isRecording()) return
        if (!captureInFlight.compareAndSet(false, true)) return

        val allowed = viewModel.requestCapture(mode, isExtra)
        if (!allowed) {
            captureInFlight.set(false)
            return
        }
        lastShutterTapAtMs = SystemClock.elapsedRealtime()
        Log.d(
            "AuctionCameraTiming",
            "shutter_tap mode=$mode extra=$isExtra cameraMode=$currentCameraMode extension=${engine.getActiveExtensionMode().label}"
        )
        playShutterSound()
        HapticCaptureHelper.hapticPulse(this)

        engine.previewViewWidth = binding.previewView.width
        engine.previewViewHeight = binding.previewView.height
        val ticket = CaptureTicket(if (isExtra) viewModel.captureMode.value ?: mode else mode,
            isExtra, lastShutterTapAtMs, viewModel.currentLotNumber.value ?: 1)
        shutterDeadline?.let { binding.root.removeCallbacks(it) }
        activeShutterId = ticket.id
        try {
            engine.capturePhoto(ticket)
            binding.previewView.post { if (activeShutterId == ticket.id) freezePreviewFrame() }
        } catch (error: Exception) {
            captureInFlight.set(false)
            clearPreviewFreeze()
            if (processingCount == 0) stopThumbnailPulse()
            Log.e("AuctionCameraTiming", "Photo capture could not start", error)
            toast("Photo capture could not start. Please try again; your saved photos are unchanged.")
            return
        }
        shutterDeadline = Runnable {
            if (activeShutterId == ticket.id && captureInFlight.get()) {
                releaseShutter(ticket)
                toast("The camera did not finish this shot. Any saved frame is kept; reopen the camera to recover it.")
            }
        }.also { binding.root.postDelayed(it, 20_000) }
    }

    private fun applyCaptureModeUI(mode: CaptureMode) {
        currentCaptureMode = mode
        highlightCaptureModeButton(mode)
        updateModeSubtitle(mode)
    }

    private fun updateFixedLotControls(lotNumber: Int) {
        if (!viewModel.repository.isStructureLocked) return
        val mode = viewModel.repository.fixedMode(lotNumber)?.toCaptureMode()
        currentCaptureMode = mode
        for ((button, candidate) in listOf(binding.textViewBundle to CaptureMode.BUNDLE,
            binding.textViewItem to CaptureMode.ITEM, binding.textViewPhoto to CaptureMode.PHOTO)) {
            button.isEnabled = candidate == mode
            button.alpha = if (button.isEnabled) 1f else 0.35f
        }
        binding.imageLeftArrow.isEnabled = lotNumber > 1
        binding.imageRightArrow.isEnabled = viewModel.repository.canNavigateTo(lotNumber + 1)
        binding.imageLeftArrow.alpha = if (binding.imageLeftArrow.isEnabled) 1f else 0.35f
        binding.imageRightArrow.alpha = if (binding.imageRightArrow.isEnabled) 1f else 0.35f
    }

    private fun clearCaptureModeHighlights() {
        listOf(binding.textViewBundle, binding.textViewItem, binding.textViewPhoto).forEach {
            it.setTextColor(Color.WHITE)
            it.compoundDrawableTintList = ColorStateList.valueOf(Color.WHITE)
        }
    }

    @SuppressLint("UseCompatTextViewDrawableApis")
    private fun highlightCaptureModeButton(mode: CaptureMode) {
        clearCaptureModeHighlights()
        val tv = when (mode) {
            CaptureMode.BUNDLE -> binding.textViewBundle
            CaptureMode.ITEM -> binding.textViewItem
            CaptureMode.PHOTO -> binding.textViewPhoto
        }
        tv.setTextColor(AMBER)
        tv.compoundDrawableTintList = ColorStateList.valueOf(AMBER)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Camera mode — video record button
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupCameraModeButtons() {

        binding.imageViewRecordVideo.setOnClickListener {
            binding.cameraHeader.collapseExposure()
            if (!::engine.isInitialized) return@setOnClickListener
            if (captureInFlight.get() || processingCount > 0) {
                toast("Please wait for the photo to finish saving.")
                return@setOnClickListener
            }
            if (isRecordButtonLocked) return@setOnClickListener
            if (engine.isStopping()) return@setOnClickListener

            when {
                engine.isRecording() -> {
                    engine.stopRecording()
                    isRecording = false
                    pendingStartRecording = false
                    binding.recordingTimer.visibility = View.GONE
                    binding.recordingDot.visibility = View.GONE
                    recordingTimer?.let { binding.previewView.removeCallbacks(it) }
                    recordingTimer = null
                    recordingSeconds = 0
                    binding.imageViewRecordVideo.setImageResource(R.drawable.ic_record_video)
                    binding.imageViewRecordVideo.clearColorFilter()
                    currentCaptureMode?.let { highlightCaptureModeButton(it) }
                }

                currentCameraMode == CameraMode.VIDEO && isVideoReady -> {
                    if (currentCaptureMode == null) {
                        toast("Select Bundle, Item, or Photo first")
                        return@setOnClickListener
                    }
                    turnOffProMode()
                    binding.btnProMode.visibility = View.GONE
                    isRecordButtonLocked = true
                    binding.imageViewRecordVideo.setColorFilter(Color.RED)
                    engine.startRecording()
                }

                currentCameraMode == CameraMode.VIDEO && !isVideoReady -> {
                    if (currentCaptureMode == null) {
                        toast("Select Bundle, Item, or Photo first")
                        return@setOnClickListener
                    }
                    if (isProMode) {
                        isProMode = false
                        binding.includePro.root.visibility = View.GONE
                        binding.btnProMode.setTextColor(Color.WHITE)
                        engine.setAutoMode(binding.previewView, false)
                        resetProControlsToAuto()
                    }
                    binding.btnProMode.visibility = View.GONE
                    pendingStartRecording = true
                    binding.imageViewRecordVideo.setColorFilter(Color.RED)
                }

                else -> {
                    turnOffFlash()
                    if (engine.getActiveExtensionMode() !is CameraViewExtensionMode.Normal) {
                        engine.setNightMode(false)
                        withPreviewFreeze {
                            engine.setExtensionMode(
                                CameraViewExtensionMode.Normal,
                                binding.previewView,
                                false
                            )
                        }
                    }
                    if (isProMode) {
                        isProMode = false
                        binding.includePro.root.visibility = View.GONE
                        binding.btnProMode.setTextColor(Color.WHITE)
                        engine.setAutoMode(binding.previewView, false)
                        resetProControlsToAuto()
                    }
                    currentCameraMode = CameraMode.VIDEO
                    pendingStartRecording = true
                    isVideoReady = false
                    showEV(false)
                    engine.setNightMode(false)
                    withPreviewFreeze { engine.startVideo(binding.previewView) }
                    binding.extensionModeBar.visibility = View.GONE
                    binding.buttonFrontCamera.visibility = View.GONE
                    currentZoom = 1f; engine.setZoom(1f); highlight(binding.zoom1)
                    syncExtensionChipsByKey(CHIP_NORMAL)
                    binding.btnProMode.visibility = View.GONE
                }
            }
        }
    }

    private fun buildExtensionChips(available: List<CameraViewExtensionMode>) {
        binding.extensionChipContainer.removeAllViews()
        extensionChipMap.clear()

        val hasBokeh = available.any { it is CameraViewExtensionMode.Bokeh }
        val hasHdr = available.any { it is CameraViewExtensionMode.HDR }

        val chips = mutableListOf(CHIP_NORMAL to "Normal")
        if (hasHdr) chips.add(CHIP_HDR to "HDR")
        chips.add(CHIP_NIGHT to "Night")
        if (hasBokeh) chips.add(CHIP_PORTRAIT to "Portrait")

//        binding.extensionModeBar.visibility = View.VISIBLE
        binding.extensionModeBar.visibility = View.GONE

        for ((key, label) in chips) {
            val chip = AppCompatTextView(this).apply {
                text = label; textSize = 11f; setPadding(24, 8, 24, 8)
                setTextColor(Color.WHITE)
                setBackgroundResource(R.drawable.bg_zoom_pill)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { marginEnd = 10 }
                setOnClickListener { onExtensionChipTapped(key) }
            }
            extensionChipMap[key] = chip
            binding.extensionChipContainer.addView(chip)
        }

        syncExtensionChipsByKey(currentActiveChipKey())
    }

    private fun onExtensionChipTapped(key: String) {
        if (currentCameraMode == CameraMode.VIDEO) {
            toast("Switch off video mode first"); return
        }
        if (waitForCapture()) return
        val currentKey = currentActiveChipKey()
        // Keep current mode on repeated taps; avoid accidental fallback to Normal.
        if (currentKey == key) return
        val targetKey = key

        when (targetKey) {
            CHIP_NORMAL -> {
                binding.btnFlash.visibility = View.VISIBLE
                currentCameraMode = CameraMode.PHOTO
                engine.setNightMode(false)
                currentZoom = 1f
                engine.setZoom(1f)
                highlight(binding.zoom1)

                val trueMin = engine.getTrueMinZoom()
                val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)
                binding.zoomSliderView?.minZoom = trueMin
                binding.zoomSliderView?.maxZoom = trueMax
                binding.zoomSliderView?.currentZoom = 1f
                binding.zoomRatioLabel?.text = "1.0x"

                withPreviewFreeze {
                    engine.setExtensionMode(
                        CameraViewExtensionMode.Normal,
                        binding.previewView,
                        true
                    )
                }
                syncExtensionChipsByKey(CHIP_NORMAL)
                showEV(true)
                if (engine.hasUltraWideLens() && !engine.isFrontCamera()) {
                    binding.zoom06.visibility = View.VISIBLE
                }
                binding.zoomSliderView?.minZoom = trueMin
            }

            CHIP_HDR -> {
                binding.btnFlash.visibility = View.VISIBLE
                currentCameraMode = CameraMode.PHOTO
                engine.setNightMode(false)
                currentZoom = 1f
                engine.setZoom(1f)
                highlight(binding.zoom1)

                // FIX: Slider properly reset karo
                val trueMin = engine.getTrueMinZoom()
                val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)
                binding.zoomSliderView?.minZoom = trueMin
                binding.zoomSliderView?.maxZoom = trueMax
                binding.zoomSliderView?.currentZoom = 1f
                binding.zoomRatioLabel?.text = "1.0x"

                withPreviewFreeze {
                    engine.setExtensionMode(CameraViewExtensionMode.HDR, binding.previewView, true)
                }
                syncExtensionChipsByKey(CHIP_HDR)
                showEV(true)
                if (engine.hasUltraWideLens() && !engine.isFrontCamera()) {
                    binding.zoom06.visibility = View.VISIBLE
                }
                binding.zoomSliderView?.minZoom = trueMin
            }

            CHIP_NIGHT -> {
                binding.btnFlash.visibility = View.VISIBLE
                currentCameraMode = CameraMode.NIGHT
                engine.setNightMode(true)
                currentZoom = 1f
                // Allow ultrawide in night mode if device supports it
                if (engine.hasUltraWideLens() && !engine.isFrontCamera()) {
                    binding.zoom06.visibility = View.VISIBLE
                    binding.zoom06.text = btn06Label
                    val trueMin = engine.getTrueMinZoom()
                    binding.zoomSliderView?.minZoom = trueMin
                } else {
                    binding.zoom06.visibility = View.GONE
                    binding.zoomSliderView?.minZoom = 1f
                }
                binding.zoomSliderView?.maxZoom = engine.getMaxZoomRatio().coerceAtMost(8f)
                binding.zoomSliderView?.currentZoom = 1f
                binding.zoomRatioLabel?.text = "1.0x"
                highlight(binding.zoom1)

                suppressZoomUICallback = true
                binding.previewView.removeCallbacks(clearSuppressRunnable)
                binding.previewView.postDelayed(clearSuppressRunnable, 2500)
                withPreviewFreeze {
                    engine.handleZoomSlot(
                        binding.previewView,
                        ZoomSlot.WIDE,
                        true
                    )
                }
                if (engine.getActiveExtensionMode() !is CameraViewExtensionMode.Normal)
                    withPreviewFreeze {
                        engine.setExtensionMode(
                            CameraViewExtensionMode.Normal,
                            binding.previewView,
                            true
                        )
                    }

                syncExtensionChipsByKey(CHIP_NIGHT)
                showEV(true)
            }

            CHIP_PORTRAIT -> {
                currentCameraMode = CameraMode.PORTRAIT
                engine.setNightMode(false)
                binding.zoom06.visibility = View.GONE
                binding.zoomSliderView?.minZoom = 1f
                currentZoom = 1f
                engine.setZoom(1f)
                highlight(binding.zoom1)
                val trueMin = engine.getTrueMinZoom()
                val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)
                binding.zoomSliderView?.minZoom = trueMin
                binding.zoomSliderView?.maxZoom = trueMax
                binding.zoomSliderView?.currentZoom = 1f
                binding.zoomRatioLabel?.text = "1.0x"
                withPreviewFreeze {
                    engine.setExtensionMode(
                        CameraViewExtensionMode.Bokeh,
                        binding.previewView,
                        true
                    )
                }
                syncExtensionChipsByKey(CHIP_PORTRAIT)
                showEV(true)
            }
        }
    }

    private fun currentActiveChipKey() = when {
        currentCameraMode == CameraMode.NIGHT -> CHIP_NIGHT
        currentCameraMode == CameraMode.PORTRAIT -> CHIP_PORTRAIT
        engine.getActiveExtensionMode() is CameraViewExtensionMode.HDR -> CHIP_HDR
        else -> CHIP_NORMAL
    }

    private fun syncExtensionChipsByKey(activeKey: String) {
        extensionChipMap.forEach { (key, chip) ->
            val isActive = key == activeKey
            chip.setTextColor(if (isActive) AMBER else Color.WHITE)
            chip.setBackgroundResource(
                if (isActive) R.drawable.bg_click_solid_color else R.drawable.bg_zoom_pill
            )
        }
    }

    private fun setupGalleryClick() {
        val openGallery: () -> Unit = open@{
            if (waitForCapture()) return@open
            val uris = viewModel.getDisplayedLotUris()
            if (uris.isEmpty()) return@open

            if (uris.size == 1 && LotGalleryActivity.isVideoUri(uris[0])) {
                val videoUri = uris[0]
                try {
                    val file =
                        if (videoUri.scheme == "file") java.io.File(videoUri.path!!) else null
                    val contentUri: Uri = if (file != null)
                        androidx.core.content.FileProvider.getUriForFile(
                            this, "${packageName}.fileprovider", file
                        )
                    else videoUri
                    startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(contentUri, "video/mp4")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    })
                    return@open
                } catch (e: Exception) {
                    Log.e("Gallery", "Video open failed: ${e.message}")
                }
            }

            LotGalleryActivity.launch(
                ctx = this,
                lotNumber = viewModel.currentLotNumber.value ?: 1,
                uris = uris,
                startIndex = 0
            )
        }
        binding.galleryPreviewContainer.setOnClickListener { openGallery() }
        binding.galleryPreview.setOnClickListener { openGallery() }
        binding.galleryCount.setOnClickListener { openGallery() }
    }

    private fun dismissFlashPopup() {
        try {
            flashPopup?.dismiss()
        } catch (_: Exception) {
        }
        flashPopup = null
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun setupFlashAndFrontCamera() {
        binding.btnFlash.setOnClickListener {
            if (!::engine.isInitialized || !engine.hasFlash()) return@setOnClickListener
            if (flashPopup?.isShowing == true) {
                dismissFlashPopup()
            } else {
                showFlashPopup()
            }
        }
        binding.buttonFrontCamera.setOnClickListener {
            if (!::engine.isInitialized) return@setOnClickListener
            dismissFlashPopup()

            if (engine.isRecording()) {
                engine.stopRecording()
                stopRecordingUI()
                pendingCameraSwitch = false
                binding.previewView.postDelayed({ performCameraSwitch() }, 400)
                return@setOnClickListener
            }

            if (isDualRecording) {
                toast("Stop dual recording first")
                return@setOnClickListener
            }

            performCameraSwitch()
        }
        applyFlashState(flashState)
    }

    private fun showFlashPopup() {
        val popupView = layoutInflater.inflate(R.layout.item_flash_options, null)
        popupView.measure(
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        )
        val popupWidth = popupView.measuredWidth

        syncFlashPopupHighlight(popupView)

        val autoOption = popupView.findViewById<View>(R.id.flashOptionAuto)
        autoOption.visibility = if (isRecording || currentCameraMode == CameraMode.VIDEO) {
            View.GONE
        } else {
            View.VISIBLE
        }

        if ((isRecording || currentCameraMode == CameraMode.VIDEO) && flashState == AUTO) {
            applyFlashState(OFF)
        }

        val popup = PopupWindow(
            popupView,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            true
        )
        popup.isOutsideTouchable = true
        popup.isFocusable = true
        popup.elevation = 16f
        flashPopup = popup

        val anchor = binding.btnFlash
        val loc = IntArray(2)
        anchor.getLocationOnScreen(loc)
        val x = loc[0] + anchor.width - popupWidth
        val y = loc[1] + anchor.height + 4

        popup.showAtLocation(binding.root, Gravity.NO_GRAVITY, x, y)

        popupView.findViewById<View>(R.id.flashOptionOff).setOnClickListener {
            applyFlashState(OFF)
            userSelectedFlashState = OFF
            dismissFlashPopup()
        }
        popupView.findViewById<View>(R.id.flashOptionOn).setOnClickListener {
            applyFlashState(ON)
            userSelectedFlashState = ON
            dismissFlashPopup()
        }
        popupView.findViewById<View>(R.id.flashOptionAuto).setOnClickListener {
            applyFlashState(AUTO)
            userSelectedFlashState = AUTO
            dismissFlashPopup()
        }
    }

    private fun syncFlashPopupHighlight(popupView: View) {
        val amber = ContextCompat.getColor(this, R.color.orange)
        val white = Color.WHITE
        val iconOff = popupView.findViewById<AppCompatImageView>(R.id.flashIconOff)
        val iconOn = popupView.findViewById<AppCompatImageView>(R.id.flashIconOn)
        val iconAuto = popupView.findViewById<AppCompatImageView>(R.id.flashIconAuto)
        val labelOff = popupView.findViewById<TextView>(R.id.flashLabelOff)
        val labelOn = popupView.findViewById<TextView>(R.id.flashLabelOn)
        val labelAuto = popupView.findViewById<TextView>(R.id.flashLabelAuto)

        listOf(iconOff, iconOn, iconAuto).forEach { it.setColorFilter(white) }
        listOf(labelOff, labelOn, labelAuto).forEach { it.setTextColor(white) }

        when (flashState) {
            OFF -> {
                iconOff.setColorFilter(amber); labelOff.setTextColor(amber)
            }

            ON -> {
                iconOn.setColorFilter(amber); labelOn.setTextColor(amber)
            }

            AUTO -> {
                iconAuto.setColorFilter(amber); labelAuto.setTextColor(amber)
            }
        }
    }

    private fun applyFlashState(state: Int) {
        flashState = state
        when (state) {
            OFF -> {
                flashEnabled = false
                binding.btnFlash.setImageResource(R.drawable.ic_flash_off)
                binding.btnFlash.clearColorFilter()
            }

            ON -> {
                flashEnabled = true
                binding.btnFlash.setImageResource(R.drawable.ic_flash_on)
                binding.btnFlash.setColorFilter(ContextCompat.getColor(this, R.color.orange))
            }

            AUTO -> {
                flashEnabled = true
                binding.btnFlash.setImageResource(R.drawable.ic_flash_auto)
                binding.btnFlash.setColorFilter(ContextCompat.getColor(this, R.color.orange))
            }
        }
        if (::engine.isInitialized) {
            engine.syncFlashFromOutside(flashState == ON, flashState == AUTO)
        }

        if (currentCameraMode == CameraMode.PORTRAIT) applyPortraitFlash()
    }

    @OptIn(ExperimentalCamera2Interop::class)
    private fun applyPortraitFlash() {
        try {
            val camera2Control = Camera2CameraControl.from(engine.getCamera()!!.cameraControl)

            when (flashState) {
                ON -> {
                    camera2Control.captureRequestOptions = CaptureRequestOptions.Builder()
                        .setCaptureRequestOption(
                            CaptureRequest.FLASH_MODE,
                            CameraMetadata.FLASH_MODE_TORCH
                        )
                        .setCaptureRequestOption(
                            CaptureRequest.CONTROL_AE_MODE,
                            CameraMetadata.CONTROL_AE_MODE_ON
                        )
                        .build()
                }

                AUTO -> {
                    camera2Control.captureRequestOptions = CaptureRequestOptions.Builder()
                        .setCaptureRequestOption(
                            CaptureRequest.FLASH_MODE,
                            CameraMetadata.FLASH_MODE_SINGLE
                        )
                        .setCaptureRequestOption(
                            CaptureRequest.CONTROL_AE_MODE,
                            CameraMetadata.CONTROL_AE_MODE_ON_AUTO_FLASH
                        )
                        .build()
                }

                OFF -> {
                    camera2Control.captureRequestOptions = CaptureRequestOptions.Builder()
                        .setCaptureRequestOption(
                            CaptureRequest.FLASH_MODE,
                            CameraMetadata.FLASH_MODE_OFF
                        )
                        .setCaptureRequestOption(
                            CaptureRequest.CONTROL_AE_MODE,
                            CameraMetadata.CONTROL_AE_MODE_ON
                        )
                        .build()
                }
            }
        } catch (e: Exception) {
            Log.e("Flash", "Portrait flash failed: ${e.message}")
        }
    }

    private fun performCameraSwitch() {
        if (!engine.isFrontCamera()) {
            userSelectedFlashState = flashState
        }

        // --- ADD THIS LINE: Ensure Pro menu closes when flipping to front cam ---
        turnOffProMode()
        applyPreviewLayerFilter(0, 0)
        turnOffFlash()
        proControlsInitialized = false
        zoomSynced = false
        hasConfirmedUltraWide = false
        btn06Label = "0.6"
        btn4Label = "4"
        binding.zoom06.visibility = View.GONE
        binding.zoom06.text = "0.6"
//        binding.extensionModeBar.visibility = View.VISIBLE
        binding.extensionModeBar.visibility = View.GONE
        binding.buttonFrontCamera.visibility = View.VISIBLE
        binding.btnProMode.visibility = View.GONE
        binding.btnFlash.isEnabled = false
        binding.btnFlash.alpha = 0.4f
        highlight(binding.zoom1)
        // Slider reset
        binding.zoomSliderView?.minZoom = 1f
        binding.zoomSliderView?.currentZoom = 1f
        extensionChipMap.clear()
        currentCameraMode = CameraMode.PHOTO
        showEV(false)
        withPreviewFreeze { engine.switchCamera(binding.previewView, isPhoto()) }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Resolution
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupResolutionToggle() {
        val mp = binding.includeItemMP
        mp.root.visibility = View.VISIBLE
        fun applyResUI(s: String) {
            selectedResolution = s; binding.resToggle.text = s
            listOf(
                mp.res12M to "12M",
                mp.res50M to "50M",
                mp.res200M to "200M"
            ).forEach { (chip, lbl) ->
                chip.setTextColor(
                    if (lbl == s) ContextCompat.getColor(this, R.color.orange) else Color.WHITE
                )
                chip.setBackgroundResource(if (lbl == s) R.drawable.bg_zoom_selected else R.drawable.bg_zoom_pill)
            }
        }
        mp.res12M.setOnClickListener {
            applyResUI("12M")
            if (::engine.isInitialized)
                engine.setResolution("12M", binding.previewView, isPhoto())
            mp.resolutionOptionsScroll.visibility = View.GONE
        }
        mp.res50M.setOnClickListener {
            applyResUI("50M")
            if (::engine.isInitialized)
                engine.setResolution("50M", binding.previewView, isPhoto())
            mp.resolutionOptionsScroll.visibility = View.GONE
        }
        mp.res200M.setOnClickListener {
            applyResUI("200M")
            if (::engine.isInitialized) engine.setResolution("200M", binding.previewView, isPhoto())
            mp.resolutionOptionsScroll.visibility = View.GONE
        }
        binding.resToggle.setOnClickListener {
            mp.resolutionOptionsScroll.visibility =
                if (mp.resolutionOptionsScroll.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        applyResUI("12M"); mp.resolutionOptionsScroll.visibility = View.GONE
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EV slider
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupEVSlider() {
        binding.evSeekBar.max = 40; binding.evSeekBar.progress = 20
        binding.evSeekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, p: Int, fromUser: Boolean) {
                if (!fromUser) return
                val (lo, hi) = engine.getExposureRange() ?: return
                val ev = lo + (p.toFloat() / 40f) * (hi - lo)
                updateEVLabel(ev); engine.setExposureCompensation(ev)
            }

            override fun onStartTrackingTouch(sb: SeekBar) {
                isUserDraggingEV = true
            }

            override fun onStopTrackingTouch(sb: SeekBar) {
                isUserDraggingEV = false
            }
        })
    }

    private fun syncEVSeekBar(ev: Float) {
        if (!::engine.isInitialized || isUserDraggingEV) return
        val (lo, hi) = engine.getExposureRange() ?: return
        if (hi - lo > 0f)
            binding.evSeekBar.progress = ((ev - lo) / (hi - lo) * 40).toInt().coerceIn(0, 40)
    }

    private fun updateEVLabel(ev: Float) {
        binding.evLabel.text = "EV ${if (ev >= 0) "+" else ""}${"%.1f".format(ev)}"
    }

    private fun showEV(show: Boolean) {
        val v =
            if (show && ::engine.isInitialized && engine.isEVSupported()) View.VISIBLE else View.GONE
        binding.evSeekBar.visibility = v
        binding.evLabel.visibility = v
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pro mode
    // ─────────────────────────────────────────────────────────────────────────

    private fun setupProMode() {
        val pro = binding.includePro
        pro.isoSeekBar.max = 100
        binding.btnProMode.setOnClickListener {
            if (isRecording) {
                toast("Stop recording before changing Pro settings")
                return@setOnClickListener
            }
            isProMode = !isProMode
            binding.includePro.root.visibility = if (isProMode) View.VISIBLE else View.GONE
            binding.btnProMode.setTextColor(if (isProMode) AMBER else Color.WHITE)

            if (isProMode) {
                val lotNum = viewModel.currentLotNumber.value ?: 1
                val settings = viewModel.getProSettingsForLot(lotNum)
                if (viewModel.hasProSettingsForLot(lotNum)) {
                    applyProSettingsToUI(settings, applyToEngine = true)
                } else {
                    resetProControlsToAuto()
                }
                syncProPanelForExtension(engine.getActiveExtensionMode())
            }
        }

        pro.isoLabel.setOnClickListener {
            pro.isoSeekBar.progress = 0
            saveCurrentProSettings()
        }

        pro.isoSeekBar.setOnSeekBarChangeListener(
            seekListener(
            onChange = { p, fromUser ->
                if (isRecording) return@seekListener
                if (p == 0) {
                    pro.isoLabel.text = "ISO  AUTO"
                    pro.isoLabel.setTextColor(AMBER)
                    if (fromUser) engine.setISO(null, binding.previewView, isPhoto())
                } else {
                    val lim = deviceLimits ?: return@seekListener
                    val iso = logScale(p, 100, lim.minIso, lim.maxIso).toInt().round(50)
                        .coerceIn(lim.minIso, lim.maxIso)
                    pro.isoLabel.text = "ISO  $iso"
                    pro.isoLabel.setTextColor(Color.WHITE)
                    if (fromUser) engine.setISO(iso, binding.previewView, isPhoto())
                }
                if (!fromUser) {
                    val lim = deviceLimits
                    if (p == 0) {
                        engine.setISO(null, binding.previewView, isPhoto())
                    } else if (lim != null) {
                        val iso = logScale(p, 100, lim.minIso, lim.maxIso).toInt().round(50)
                            .coerceIn(lim.minIso, lim.maxIso)
                        engine.setISO(iso, binding.previewView, isPhoto())
                    }
                }
            },
            onStop = { saveCurrentProSettings() }
        ))

        pro.shutterSeekBar.max = shutterValues.size
        pro.shutterLabel.setOnClickListener {
            pro.shutterSeekBar.progress = 0
            saveCurrentProSettings()
        }

        pro.shutterSeekBar.setOnSeekBarChangeListener(
            seekListener(
            onChange = { p, fromUser ->
                if (isRecording) return@seekListener
                if (p == 0) {
                    pro.shutterLabel.text = "SS   AUTO"
                    pro.shutterLabel.setTextColor(AMBER)
                    if (fromUser) {
                        engine.setShutterSpeed(null, binding.previewView, isPhoto())
                        saveCurrentProSettings()
                    }
                } else {
                    val idx = (p - 1).coerceIn(0, shutterValues.lastIndex)
                    pro.shutterLabel.text = "SS   ${shutterLabels[idx]}s"
                    pro.shutterLabel.setTextColor(Color.WHITE)
                    if (fromUser) {
                        engine.setShutterSpeed(
                            shutterValues[idx],
                            binding.previewView,
                            isPhoto()
                        )
                    }
                }
            },
            onStop = { saveCurrentProSettings() }
        ))

        listOf(pro.fps15 to (15 to 15), pro.fps30 to (30 to 30), pro.fps60 to (60 to 60))
            .forEach { (chip, range) ->
                chip.setOnClickListener {
                    if (!::engine.isInitialized) return@setOnClickListener
                    listOf(pro.fps15, pro.fps30, pro.fps60).forEach {
                        it.setTextColor(Color.WHITE)
                        it.setBackgroundResource(R.drawable.bg_zoom_pill)
                    }
                    chip.setTextColor(AMBER)
                    chip.setBackgroundResource(R.drawable.bg_zoom_selected)
                    pro.fpsLabel.text = "FPS  ${range.first}"
                    engine.setFPSRange(range.first, range.second, binding.previewView, isPhoto())
                    saveCurrentProSettings()
                }
            }
        WhiteBalance.entries.forEachIndexed { index, wb ->
            AppCompatTextView(this).apply {
                text = wb.label
                textSize = 11f
                setPadding(16, 6, 16, 6)
                setTextColor(Color.WHITE)
                setBackgroundResource(R.drawable.bg_zoom_pill)
                tag = index
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { marginEnd = 8 }
                setOnClickListener {
                    if (!::engine.isInitialized) return@setOnClickListener
                    (0 until pro.wbChips.childCount).forEach { i ->
                        (pro.wbChips.getChildAt(i) as? AppCompatTextView)?.apply {
                            setTextColor(Color.WHITE)
                            setBackgroundResource(R.drawable.bg_zoom_pill)
                        }
                    }
                    setTextColor(AMBER)
                    setBackgroundResource(R.drawable.bg_zoom_selected)
                    pro.wbLabel.text = "WB   ${wb.label}"
                    selectedWbIndex = index
                    engine.setWhiteBalance(wb, binding.previewView, isPhoto())
                    saveCurrentProSettings()
                }
                pro.wbChips.addView(this)
            }
        }
    }

//    private fun saveCurrentProSettings() {
//        val pro = binding.includePro
//        val selectedFps = when {
//            pro.fps15.currentTextColor == AMBER -> 15 to 15
//            pro.fps60.currentTextColor == AMBER -> 60 to 60
//            else -> 30 to 30
//        }
//        val wbLabel = WhiteBalance.entries.getOrNull(selectedWbIndex)?.label ?: "Auto"
//        val lotNum = viewModel.currentLotNumber.value ?: 1
//        viewModel.saveProSettingsForLot(
//            lotNum,
//            ProSettings(
//                isoProgress     = pro.isoSeekBar.progress,
//                shutterProgress = pro.shutterSeekBar.progress,
//                fpsMin          = selectedFps.first,
//                fpsMax          = selectedFps.second,
//                wbLabel         = wbLabel,
//                wbIndex         = selectedWbIndex,
//                contrast        = progressToEffect(pro.seekContrast.progress),
//                color           = progressToEffect(pro.seekColor.progress),
//                sharpness       = progressToEffect(pro.seekSharpness.progress)
//            )
//        )
//    }

    private fun saveCurrentProSettings() {
        val pro = binding.includePro
        val selectedFps = when {
            pro.fps15.currentTextColor == AMBER -> 15 to 15
            pro.fps60.currentTextColor == AMBER -> 60 to 60
            else -> 30 to 30
        }
        val wbLabel = WhiteBalance.entries.getOrNull(selectedWbIndex)?.label ?: "Auto"
        val settings = ProSettings(
            isoProgress = pro.isoSeekBar.progress,
            shutterProgress = pro.shutterSeekBar.progress,
            fpsMin = selectedFps.first,
            fpsMax = selectedFps.second,
            wbLabel = wbLabel,
            wbIndex = selectedWbIndex,
            contrast = progressToEffect(pro.seekContrast.progress),
            color = progressToEffect(pro.seekColor.progress),
            sharpness = progressToEffect(pro.seekSharpness.progress)
        )
        val lotNum = viewModel.currentLotNumber.value ?: 1
        viewModel.saveProSettingsForLot(lotNum, settings)

        // Persist globally so settings survive app restarts
        ProSettingsStore.save(this, settings)
    }

    private fun applyProSettingsToUI(settings: ProSettings, applyToEngine: Boolean = false) {
        val pro = binding.includePro
        selectedWbIndex = settings.wbIndex

        pro.isoSeekBar.progress = settings.isoProgress
        if (settings.isoProgress == 0) {
            pro.isoLabel.text = "ISO  AUTO"
            pro.isoLabel.setTextColor(AMBER)
        } else {
            val lim = deviceLimits
            if (lim != null) {
                val iso = logScale(settings.isoProgress, 100, lim.minIso, lim.maxIso)
                    .toInt().round(50).coerceIn(lim.minIso, lim.maxIso)
                pro.isoLabel.text = "ISO  $iso"
                pro.isoLabel.setTextColor(Color.WHITE)
            }
        }

        pro.shutterSeekBar.progress = settings.shutterProgress
        if (settings.shutterProgress == 0) {
            pro.shutterLabel.text = "SS   AUTO"
            pro.shutterLabel.setTextColor(AMBER)
        } else {
            val idx = (settings.shutterProgress - 1).coerceIn(0, shutterValues.lastIndex)
            pro.shutterLabel.text = "SS   ${shutterLabels[idx]}s"
            pro.shutterLabel.setTextColor(Color.WHITE)
        }

        listOf(pro.fps15 to 15, pro.fps30 to 30, pro.fps60 to 60).forEach { (chip, fps) ->
            val isSelected = fps == settings.fpsMin
            chip.setTextColor(if (isSelected) AMBER else Color.WHITE)
            chip.setBackgroundResource(
                if (isSelected) R.drawable.bg_zoom_selected else R.drawable.bg_zoom_pill
            )
        }
        pro.fpsLabel.text = "FPS  ${settings.fpsMin}"

        (0 until pro.wbChips.childCount).forEach { i ->
            val chip = pro.wbChips.getChildAt(i) as? AppCompatTextView ?: return@forEach
            val chipIndex = chip.tag as? Int ?: return@forEach
            val isSelected = chipIndex == settings.wbIndex
            chip.setTextColor(if (isSelected) AMBER else Color.WHITE)
            chip.setBackgroundResource(
                if (isSelected) R.drawable.bg_zoom_selected else R.drawable.bg_zoom_pill
            )
        }
        pro.wbLabel.text = "WB   ${settings.wbLabel}"

        pro.seekContrast.progress = effectToProgress(settings.contrast)
        pro.seekColor.progress = effectToProgress(settings.color)
        pro.seekSharpness.progress = effectToProgress(settings.sharpness)

        pro.labelContrast.text =
            if (settings.contrast >= 0) " +${settings.contrast}" else "  ${settings.contrast}"
        pro.labelColor.text =
            if (settings.color >= 0) " +${settings.color}" else "  ${settings.color}"
        pro.labelSharpness.text =
            if (settings.sharpness >= 0) " +${settings.sharpness}" else "  ${settings.sharpness}"

        val pro2 = binding.includePro
        clearPresetHighlights()
        when {
            settings.contrast == 3 && settings.color == 3 && settings.sharpness == 2 ->
                highlightPreset(pro2.presetLow)

            settings.contrast == 6 && settings.color == 5 && settings.sharpness == 5 ->
                highlightPreset(pro2.presetModerate)

            settings.contrast == 9 && settings.color == 8 && settings.sharpness == 8 ->
                highlightPreset(pro2.presetHeavy)
        }

        if (applyToEngine && ::engine.isInitialized) {
            applyProSettingsToEngine(settings)
        }
    }

    private fun resetProControlsToAuto() {
        selectedWbIndex = 0
        binding.includePro.apply {
            isoSeekBar.progress = 0
            shutterSeekBar.progress = 0
            isoLabel.text = "ISO  AUTO"
            isoLabel.setTextColor(AMBER)
            shutterLabel.text = "SS   AUTO"
            shutterLabel.setTextColor(AMBER)
            fpsLabel.text = "FPS  30"

            listOf(fps15, fps60).forEach {
                it.setTextColor(Color.WHITE)
                it.setBackgroundResource(R.drawable.bg_zoom_pill)
            }
            fps30.setTextColor(AMBER)
            fps30.setBackgroundResource(R.drawable.bg_zoom_selected)
            wbLabel.text = "WB   Auto"
            (0 until wbChips.childCount).forEach { i ->
                (wbChips.getChildAt(i) as? AppCompatTextView)?.apply {
                    setTextColor(Color.WHITE)
                    setBackgroundResource(R.drawable.bg_zoom_pill)
                }
            }
            (wbChips.getChildAt(0) as? AppCompatTextView)?.apply {
                setTextColor(AMBER)
                setBackgroundResource(R.drawable.bg_zoom_selected)
            }

            seekContrast.progress = 100
            seekColor.progress = 100
            seekSharpness.progress = 100
            labelContrast.text = "  0"
            labelColor.text = "  0"
            labelSharpness.text = "  0"
        }
        clearPresetHighlights()

        if (::engine.isInitialized) {
            engine.setImageEffects(0, 0, 0)
        }
    }

    private fun syncProPanelForExtension(mode: CameraViewExtensionMode) {
        val locked = ExtensionViewConflictResolver.isProModeLocked(mode)
        binding.includePro.apply {
            isoSeekBar.isEnabled = !locked; isoSeekBar.alpha = if (locked) 0.35f else 1f
            isoLabel.alpha = if (locked) 0.35f else 1f
            shutterSeekBar.isEnabled = !locked; shutterSeekBar.alpha = if (locked) 0.35f else 1f
            shutterLabel.alpha = if (locked) 0.35f else 1f
            runCatching {
                proLockHintLabel.visibility = if (locked) View.VISIBLE else View.GONE
                if (locked) proLockHintLabel.text =
                    ExtensionViewConflictResolver.proModeLockReason(mode)
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ZOOM — All fixes here
    // ─────────────────────────────────────────────────────────────────────────

    private fun zoomClick(slot: ZoomSlot, btn: View) {
        (binding.bottomPanel as? expo.modules.auctioncamera.viewextensions.CameraActionLayout)?.collapseLenses()
        if (!::engine.isInitialized) return

        val trueMin = engine.getTrueMinZoom()
        val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)

        val isRestrictedMode = currentCameraMode == CameraMode.PORTRAIT
                || (currentCameraMode == CameraMode.NIGHT
                && (!engine.hasUltraWideLens() || engine.isFrontCamera()))

        if (isRestrictedMode && slot == ZoomSlot.ULTRA_WIDE) {
            val expectedRatio = 1.0f
            suppressZoomUICallback = true
            binding.previewView.removeCallbacks(clearSuppressRunnable)
            binding.previewView.postDelayed(clearSuppressRunnable, 1000)
            currentZoom = expectedRatio
            binding.zoomSliderView?.minZoom = 1f
            binding.zoomSliderView?.maxZoom = trueMax
            binding.zoomSliderView?.currentZoom = expectedRatio
            binding.zoomRatioLabel?.text = "${"%.1f".format(expectedRatio)}x"
            highlight(binding.zoom1)
            engine.getCamera()?.cameraControl?.setZoomRatio(expectedRatio)
            return
        }

        val expectedRatio = when (slot) {
            ZoomSlot.ULTRA_WIDE -> trueMin
            ZoomSlot.WIDE -> 1.0f
            ZoomSlot.MID -> 2.0f.coerceAtMost(trueMax)
            ZoomSlot.TELE -> 4.0f.coerceAtMost(trueMax)
        }

        suppressZoomUICallback = true
        binding.previewView.removeCallbacks(clearSuppressRunnable)
        binding.previewView.postDelayed(clearSuppressRunnable, 1000)

        currentZoom = expectedRatio
        val sliderMin = if (isRestrictedMode) 1f else trueMin
        binding.zoomSliderView?.minZoom = sliderMin
        binding.zoomSliderView?.maxZoom = trueMax
        binding.zoomSliderView?.currentZoom = expectedRatio
        binding.zoomRatioLabel?.text = "${"%.1f".format(expectedRatio)}x"
        highlight(btn)

        if (engine.isRecording()) {
            engine.setZoom(expectedRatio)
            return
        }

        // Single source of truth — engine knows its own physical lens state
        if (engine.requiresPhysicalLensSwitch(slot)) {
            // Slow path: full provider rebind will occur, freeze to hide black flash
            withPreviewFreeze { engine.handleZoomSlot(binding.previewView, slot, isPhoto()) }
        } else {
            // Fast path: instant logical setZoomRatio — no freeze, clear any stale freeze
            engine.handleZoomSlot(binding.previewView, slot, isPhoto())
            clearPreviewFreeze()
        }
    }

    private fun setupZoom() {
//        fun zoomClick(slot: ZoomSlot, btn: View) {
//            if (!::engine.isInitialized) return
//
//            val trueMin = engine.getTrueMinZoom()
//            val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)
//
//            val isRestrictedMode = currentCameraMode == CameraMode.PORTRAIT
//                    || (currentCameraMode == CameraMode.NIGHT && (!engine.hasUltraWideLens() || engine.isFrontCamera()))
//
//            if (isRestrictedMode && slot == ZoomSlot.ULTRA_WIDE) {
//                val expectedRatio = 1.0f
//                suppressZoomUICallback = true
//                binding.previewView.removeCallbacks(clearSuppressRunnable)
//                binding.previewView.postDelayed(clearSuppressRunnable, 1000)
//                currentZoom = expectedRatio
//                binding.zoomSliderView?.minZoom = 1f
//                binding.zoomSliderView?.maxZoom = trueMax
//                binding.zoomSliderView?.currentZoom = expectedRatio
//                binding.zoomRatioLabel?.text = "${"%.1f".format(expectedRatio)}x"
//                highlight(binding.zoom1)
//                engine.getCamera()?.cameraControl?.setZoomRatio(expectedRatio)
//                return
//            }
//
//            val expectedRatio = when (slot) {
//                ZoomSlot.ULTRA_WIDE -> trueMin
//                ZoomSlot.WIDE       -> 1.0f
//                ZoomSlot.MID        -> 2.0f.coerceAtMost(trueMax)
//                ZoomSlot.TELE       -> 4.0f.coerceAtMost(trueMax)
//            }
//
//            suppressZoomUICallback = true
//            binding.previewView.removeCallbacks(clearSuppressRunnable)
//            binding.previewView.postDelayed(clearSuppressRunnable, 1000)
//
//            currentZoom = expectedRatio
//
//            val sliderMin = if (isRestrictedMode) 1f else trueMin
//
//            binding.zoomSliderView?.minZoom = sliderMin
//            binding.zoomSliderView?.maxZoom = trueMax
//            binding.zoomSliderView?.currentZoom = expectedRatio
//            binding.zoomRatioLabel?.text = "${"%.1f".format(expectedRatio)}x"
//            highlight(btn)
//
//            if (engine.isRecording()) {
//                engine.setZoom(expectedRatio)
//                return
//            }
//            val previousLens = engine.getCurrentLensLabel()
//
//            withPreviewFreeze { engine.handleZoomSlot(binding.previewView, slot, isPhoto()) }
//
//            if (previousLens == engine.getCurrentLensLabel()) {
//                clearPreviewFreeze()
//            }
//        }

        binding.zoomSliderView?.onStartTracking = {
            isUserDraggingZoom = true
            suppressZoomUICallback = true
            binding.previewView.removeCallbacks(clearSuppressRunnable)
        }
        binding.zoomSliderView?.onStopTracking = {
            isUserDraggingZoom = false
        }

        binding.zoomSliderView?.onZoomChanged = { zoom ->
            isUserDraggingZoom = true
            suppressZoomUICallback = true
            currentZoom = zoom
            binding.zoomRatioLabel?.text = "${"%.1f".format(zoom)}x"

            val isRestrictedNow = currentCameraMode == CameraMode.PORTRAIT
                    || (currentCameraMode == CameraMode.NIGHT && (!engine.hasUltraWideLens() || engine.isFrontCamera()))
            val btn = when {
                !isRestrictedNow && zoom < 0.95f
                        && binding.zoom06.visibility == View.VISIBLE -> binding.zoom06

                zoom < 1.8f -> binding.zoom1
                zoom < 2.8f -> binding.zoom2
                else -> binding.zoom4
            }
            highlightIfChanged(btn)
        }

        binding.zoomSliderView?.onZoomSettled = settledLambda@{ zoom ->
            isUserDraggingZoom = false
            currentZoom = zoom
            if (!::engine.isInitialized) return@settledLambda

            val trueMin = engine.getTrueMinZoom()
            val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)
            val isRestrictedMode = currentCameraMode == CameraMode.PORTRAIT
                    || (currentCameraMode == CameraMode.NIGHT && (!engine.hasUltraWideLens() || engine.isFrontCamera()))
            val effectiveMin = if (isRestrictedMode) 1f else trueMin
            val clamped = zoom.coerceIn(effectiveMin, trueMax)

//            fun suppressAndSwitch(slot: ZoomSlot, btn: View) {
//                suppressZoomUICallback = true
//                binding.previewView.removeCallbacks(clearSuppressRunnable)
//                binding.previewView.postDelayed(clearSuppressRunnable, 1200)
//
//                val previousLens = engine.getCurrentLensLabel()
//                withPreviewFreeze { engine.handleZoomSlot(binding.previewView, slot, isPhoto()) }
//
//                if (previousLens == engine.getCurrentLensLabel()) {
//                    clearPreviewFreeze()
//                }
//
//                highlight(btn)
//            }

            fun suppressAndSwitch(slot: ZoomSlot, btn: View) {
                suppressZoomUICallback = true
                binding.previewView.removeCallbacks(clearSuppressRunnable)
                binding.previewView.postDelayed(clearSuppressRunnable, 1200)

                val previousLens = engine.getCurrentLensLabel()

                // Only freeze preview if a physical lens switch will actually occur.
                // For logical zoom (UW on S24 Ultra), setZoomRatio is instant — no freeze needed.
                val needsPhysicalSwitch = when (slot) {
                    ZoomSlot.ULTRA_WIDE -> engine.getTrueMinZoom() >= 0.95f && engine.hasUltraWideLens()
                    ZoomSlot.WIDE -> false  // always logical
                    ZoomSlot.MID -> false  // always logical
                    ZoomSlot.TELE -> engine.hasTeleLens() && engine.getMaxZoomRatio() < 4f
                }

                if (needsPhysicalSwitch) {
                    withPreviewFreeze {
                        engine.handleZoomSlot(
                            binding.previewView,
                            slot,
                            isPhoto()
                        )
                    }
                } else {
                    engine.handleZoomSlot(binding.previewView, slot, isPhoto())
                }

                if (previousLens == engine.getCurrentLensLabel()) {
                    clearPreviewFreeze()
                }

                highlight(btn)
            }

            when {
                isRestrictedMode && clamped <= 1.0f -> {
                    engine.getCamera()?.cameraControl?.setZoomRatio(1f)
                    binding.zoomSliderView?.currentZoom = 1f
                    binding.zoomRatioLabel?.text = "1.0x"
                    highlight(binding.zoom1)
                }

                !isRestrictedMode
                        && clamped < 0.95f
                        && binding.zoom06.visibility == View.VISIBLE -> {
                    suppressAndSwitch(ZoomSlot.ULTRA_WIDE, binding.zoom06)
                }

                clamped < 1.8f -> {
                    if (!isRestrictedMode
                        && engine.getCurrentLensLabel() != "Wide"
                        && engine.hasTeleLens().not()
                    ) {
                        suppressAndSwitch(ZoomSlot.WIDE, binding.zoom1)
                    } else {
                        engine.getCamera()?.cameraControl?.setZoomRatio(clamped)
                        highlight(binding.zoom1)
                    }
                }

                clamped < 2.8f -> {
                    engine.getCamera()?.cameraControl?.setZoomRatio(clamped)
                    highlight(binding.zoom2)
                }

                !isRestrictedMode
                        && engine.hasTeleLens()
                        && clamped >= 3.5f
                        && binding.zoom4.visibility == View.VISIBLE -> {
                    suppressAndSwitch(ZoomSlot.TELE, binding.zoom4)
                }

                else -> {
                    engine.getCamera()?.cameraControl?.setZoomRatio(clamped)
                    highlight(binding.zoom4)
                }
            }
        }

        binding.btnZoomOut?.setOnClickListener {
            if (!::engine.isInitialized) return@setOnClickListener
            val trueMin = engine.getTrueMinZoom()
            val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)
            val isRestrictedMode = currentCameraMode == CameraMode.PORTRAIT
                    || (currentCameraMode == CameraMode.NIGHT && (!engine.hasUltraWideLens() || engine.isFrontCamera()))
            val effectiveMin = if (isRestrictedMode) 1f else trueMin
            currentZoom = (currentZoom - 0.1f).coerceIn(effectiveMin, trueMax)
            binding.zoomSliderView?.currentZoom = currentZoom
            binding.zoomRatioLabel?.text = "${"%.1f".format(currentZoom)}x"
            engine.getCamera()?.cameraControl?.setZoomRatio(currentZoom)
            updateZoomUI(currentZoom)
        }

        binding.btnZoomIn?.setOnClickListener {
            if (!::engine.isInitialized) return@setOnClickListener
            val trueMin = engine.getTrueMinZoom()
            val trueMax = engine.getMaxZoomRatio().coerceAtMost(8f)
            val isRestrictedMode = currentCameraMode == CameraMode.PORTRAIT
                    || (currentCameraMode == CameraMode.NIGHT && (!engine.hasUltraWideLens() || engine.isFrontCamera()))
            val effectiveMin = if (isRestrictedMode) 1f else trueMin
            currentZoom = (currentZoom + 0.1f).coerceIn(effectiveMin, trueMax)
            binding.zoomSliderView?.currentZoom = currentZoom
            binding.zoomRatioLabel?.text = "${"%.1f".format(currentZoom)}x"
            engine.getCamera()?.cameraControl?.setZoomRatio(currentZoom)
            updateZoomUI(currentZoom)
        }

//        binding.zoom06.setOnClickListener { zoomClick(ZoomSlot.ULTRA_WIDE, binding.zoom06) }
//        binding.zoom1.setOnClickListener { zoomClick(ZoomSlot.WIDE, binding.zoom1) }
//        binding.zoom2.setOnClickListener { zoomClick(ZoomSlot.MID, binding.zoom2) }
//        binding.zoom4.setOnClickListener { zoomClick(ZoomSlot.TELE, binding.zoom4) }
// Replace the four individual setOnClickListener calls at the bottom of setupZoom():
        binding.zoom06.setOnClickListener { zoomClick(ZoomSlot.ULTRA_WIDE, binding.zoom06) }
        binding.zoom1.setOnClickListener { zoomClick(ZoomSlot.WIDE, binding.zoom1) }
        binding.zoom2.setOnClickListener { zoomClick(ZoomSlot.MID, binding.zoom2) }
        binding.zoom4.setOnClickListener { zoomClick(ZoomSlot.TELE, binding.zoom4) }

        highlight(binding.zoom1)
    }

    // Sirf tab highlight karo jab naya button alag ho — zoom4 flicker fix
    private fun highlightIfChanged(newBtn: View) {
        if (currentHighlightedBtn == newBtn) return
        highlight(newBtn)
    }

    private fun syncZoomButtonsToDevice(minZoom: Float, maxZoom: Float) {
        val cappedMax = maxZoom.coerceAtMost(8f)
        val isRestrictedMode = currentCameraMode == CameraMode.PORTRAIT
                || (currentCameraMode == CameraMode.NIGHT
                && (!engine.hasUltraWideLens() || engine.isFrontCamera()))
        val hasUW = engine.hasUltraWideLens() && !engine.isFrontCamera() && !isRestrictedMode
        binding.zoom06.visibility = if (hasUW) View.VISIBLE else View.GONE
        if (hasUW) {
            btn06Label = engine.getUltraWideLabel(); binding.zoom06.text = btn06Label
        }

        binding.zoom1.visibility = View.VISIBLE; binding.zoom1.text = "1"
        binding.zoom2.visibility = if (cappedMax >= 2f) View.VISIBLE else View.GONE

        when {
            engine.hasTeleLens() -> {
                btn4Label = engine.getTeleLabel()
                binding.zoom4.text = btn4Label
                binding.zoom4.visibility = View.VISIBLE
            }

            cappedMax >= 4f -> {
                btn4Label = "4"; binding.zoom4.text = btn4Label
                binding.zoom4.visibility = View.VISIBLE
            }

            cappedMax >= 2f -> {
                btn4Label = "%.0f".format(cappedMax); binding.zoom4.text = btn4Label
                binding.zoom4.visibility = View.VISIBLE
            }

            else -> binding.zoom4.visibility = View.GONE
        }

        // Portrait/Night me slider min 1f
        binding.zoomSliderView?.minZoom = if (isRestrictedMode) 1f else minZoom
        binding.zoomSliderView?.maxZoom = cappedMax
        // Don't reset highlight if we're about to restore a previous zoom
        if (pendingZoomRestore == null) {
            highlight(binding.zoom1)
        }
    }

    private fun updateZoomUI(zoom: Float) {
        if (!::engine.isInitialized) return
        zoomUIUpdatePending = false
        val lens = engine.getCurrentLensLabel()
        val sel = when {
            lens == "UltraWide" || zoom < 0.95f -> binding.zoom06
            lens == "Telephoto" -> binding.zoom4
            zoom <= 1.4f -> binding.zoom1
            zoom <= 2.8f -> binding.zoom2
            else -> binding.zoom4
        }
        highlight(
            if (sel == binding.zoom06 && binding.zoom06.visibility != View.VISIBLE)
                binding.zoom1 else sel
        )
    }

    private fun highlight(view: View) {
        // Track karo kaun sa button highlight hai
        currentHighlightedBtn = view

        listOf(
            binding.zoom06 to btn06Label, binding.zoom1 to "1",
            binding.zoom2 to "2", binding.zoom4 to btn4Label
        ).forEach { (btn, lbl) ->
            btn.setTextColor(Color.WHITE); btn.background = null; btn.text = lbl
        }
        val label = when (view) {
            binding.zoom06 -> btn06Label; binding.zoom1 -> "1"
            binding.zoom2 -> "2"; binding.zoom4 -> btn4Label
            else -> (view as? TextView)?.text?.toString() ?: ""
        }
        (view as TextView).apply {
            setTextColor(AMBER)
            setBackgroundResource(R.drawable.bg_zoom_selected)
            text = label
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tap-to-focus + pinch-to-zoom
    // ─────────────────────────────────────────────────────────────────────────

    @SuppressLint("ClickableViewAccessibility")
    private fun setupTapToFocus() {
        binding.aeafOverlay.listener = object : AEAFRegionOverlay.OnRegionChangedListener {
            override fun onRegionChanged(normalizedRect: RectF) {
                if (::engine.isInitialized) {
                    engine.previewViewWidth = binding.previewView.width
                    engine.previewViewHeight = binding.previewView.height
                    engine.setAEAFRegion(normalizedRect)
                }
            }

            override fun onRegionCleared() {
                if (::engine.isInitialized) engine.clearAEAFRegion()
            }
        }

        binding.aeafOverlay.onTapInside = { x, y ->
            if (::engine.isInitialized) {
                showFocusRing(x, y)
                TapToFocus.handle(engine.getCamera(), binding.previewView, x, y) { success ->
                    runOnUiThread {
                        binding.focusIndicator.setColorFilter(if (success) AMBER else Color.RED)
                    }
                }
            }
        }

        binding.aeafOverlay.onTapOutside = { _, _ -> /* no-op */ }
    }

    private fun showFocusRing(x: Float, y: Float) {
        binding.focusIndicator.apply {
            animate().cancel(); clearColorFilter()
            scaleX = 1.5f; scaleY = 1.5f; alpha = 1f; visibility = View.VISIBLE
            post {
                this.x = binding.previewView.left.toFloat() + x - width / 2f
                this.y = binding.previewView.top.toFloat() + y - height / 2f
                animate().scaleX(1f).scaleY(1f).setDuration(250).withEndAction {
                    animate().alpha(0f).setStartDelay(900).setDuration(300)
                        .withEndAction { visibility = View.GONE }.start()
                }.start()
            }
        }
    }

    private fun setupPinchToZoom() {
        scaleDetector = buildScaleDetector()
    }

    private fun buildScaleDetector() = ScaleGestureDetector(
        this,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean {
                isPinching = true; return true
            }

            override fun onScale(d: ScaleGestureDetector): Boolean {
                if (!::engine.isInitialized) return true
                val state = engine.getCamera()?.cameraInfo?.zoomState?.value ?: return true
                currentZoom = (currentZoom * d.scaleFactor).coerceIn(
                    engine.getTrueMinZoom(),
                    state.maxZoomRatio
                )
                engine.getCamera()?.cameraControl?.setZoomRatio(currentZoom)
                return true
            }

            override fun onScaleEnd(d: ScaleGestureDetector) {
                binding.previewView.postDelayed({ isPinching = false }, 250)
            }
        })

    // ─────────────────────────────────────────────────────────────────────────
    // Recording
    // ─────────────────────────────────────────────────────────────────────────

    private fun onRecordingStarted() {
        // Lock screen orientation to prevent surface destruction during video capture
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LOCKED
        isRecording = true
        recordingSeconds = 0
        viewModel.setRecording(true)
        isRecordButtonLocked = false

        isBoxModeActive = false                              // Resets the state
        applyBoxFocusUi()                                    // Hides the red box overlay
        binding.btnFocus.visibility = View.GONE              // Hides the focus button

        if (flashState == AUTO) {
            applyFlashState(OFF)
        }

        binding.recordingTimer.text = "00:00"
        binding.recordingTimer.visibility = View.VISIBLE
        binding.recordingDot.visibility = View.VISIBLE
        binding.imageViewRecordVideo.setImageResource(R.drawable.ic_pause)
        try {
            binding.includeMainExtra.imageViewRecord.visibility = View.VISIBLE
        } catch (_: Exception) {
        }
        recordingTimer = object : Runnable {
            override fun run() {
                recordingSeconds++
                binding.recordingTimer.text =
                    "%02d:%02d".format(recordingSeconds / 60, recordingSeconds % 60)
                binding.previewView.postDelayed(this, 1000)
            }
        }
        binding.previewView.postDelayed(recordingTimer!!, 1000)
    }

    private fun onRecordingSaved(uri: Uri): Boolean {
        lastVideoUri = uri
        viewModel.onVideoRecorded(uri)
        val journalSaved = viewModel.repository.isCapturePersisted()
        stopRecordingUI()
        if (journalSaved) toast("720p video saved")
        else toast("Video retained. Tap Done to save its lot details.")
        return journalSaved
    }

    private fun stopRecordingUI() {
        // Unlock screen orientation
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        isRecording = false; pendingStartRecording = false
        isRecordButtonLocked = false
        binding.recordingTimer.visibility = View.GONE
        binding.recordingDot.visibility = View.GONE
        recordingTimer?.let { binding.previewView.removeCallbacks(it) }
        recordingTimer = null; recordingSeconds = 0
        currentCameraMode = CameraMode.PHOTO
        binding.extensionModeBar.visibility = View.GONE
//        binding.extensionModeBar.visibility    = View.VISIBLE
        binding.buttonFrontCamera.visibility = View.VISIBLE

        binding.btnFocus.visibility = View.VISIBLE // Brings the focus button back

        binding.imageViewRecordVideo.setImageResource(R.drawable.ic_record_video)
        binding.imageViewRecordVideo.clearColorFilter()
        binding.imageViewRecordVideo.isEnabled = true
        binding.imageViewRecordVideo.alpha = 1f
        currentCaptureMode?.let { highlightCaptureModeButton(it) }
        if (!engine.isFrontCamera() && deviceLimits?.supportsManualSensor == true
            && currentCameraMode != CameraMode.VIDEO
        )
            binding.btnProMode.visibility = View.VISIBLE
        if (::engine.isInitialized) {
            engine.setNightMode(false)
            val hdrAvailable = extensionChipMap.containsKey(CHIP_HDR)
            if (hdrAvailable) {
                currentCameraMode = CameraMode.PHOTO
                syncExtensionChipsByKey(CHIP_HDR)
                withPreviewFreeze {
                    engine.setExtensionMode(
                        CameraViewExtensionMode.HDR,
                        binding.previewView,
                        true
                    )
                }
            } else {
                syncExtensionChipsByKey(CHIP_NORMAL)
                withPreviewFreeze { engine.startPhoto(binding.previewView) }
            }
        }
        if (::engine.isInitialized) {
            applyPreviewLayerFilter(engine.getPendingContrast(), engine.getPendingColor())
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupFocusLogic() {
        binding.btnFocus.setOnClickListener {
            isBoxModeActive = !isBoxModeActive
            applyBoxFocusUi()
            toast(if (isBoxModeActive) "Box Focus Mode Active" else "Full Screen Focus Active")
        }

        binding.previewView.setOnTouchListener { _, event ->
            scaleDetector.onTouchEvent(event)

            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.x
                    downY = event.y
                    if (isProMode) {
                        isProMode = false
                        binding.includePro.root.visibility = View.GONE
                        binding.btnProMode.setBackgroundResource(R.drawable.bg_zoom_pill)
                    }
                }

                MotionEvent.ACTION_UP -> if (!isPinching) {
                    val dx = event.x - downX
                    val dy = event.y - downY
                    if ((dx * dx + dy * dy) < 400 && !isBoxModeActive) {
                        showFocusRing(event.x, event.y)
                        TapToFocus.handle(
                            engine.getCamera(), binding.previewView, event.x, event.y
                        ) { success ->
                            runOnUiThread {
                                binding.focusIndicator.setColorFilter(
                                    if (success) AMBER else Color.RED
                                )
                            }
                        }
                    }
                }
            }
            true
        }
    }

    /*
    private fun applyBoxFocusUi() {
        if (isBoxModeActive) {
            binding.aeafOverlay.show()
            binding.aeafOverlay.visibility = View.VISIBLE
        } else {
            binding.aeafOverlay.visibility = View.GONE
        }
        binding.btnFocus.imageTintList = ColorStateList.valueOf(
            if (isBoxModeActive) Color.parseColor("#FFA500") else Color.WHITE
        )
    }
    */

    private fun applyBoxFocusUi() {
        if (isBoxModeActive) {
            binding.aeafOverlay.show()
            binding.aeafOverlay.visibility = View.VISIBLE
        } else {
            binding.aeafOverlay.visibility = View.GONE
            
            // ── Tell the engine to wipe the crop coordinates from memory ──
            if (::engine.isInitialized) {
                engine.clearAEAFRegion()
            }
        }
        
        binding.btnFocus.imageTintList = ColorStateList.valueOf(
            if (isBoxModeActive) Color.parseColor("#FFA500") else Color.WHITE
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private fun isPhoto() = currentCameraMode == CameraMode.PHOTO
            || currentCameraMode == CameraMode.NIGHT
            || currentCameraMode == CameraMode.PORTRAIT

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    private fun logScale(p: Int, max: Int, min: Int, maxV: Int) =
        (min * (maxV.toFloat() / min).toDouble().pow(p.toDouble() / max)).toFloat()

    private fun Int.round(step: Int) = (this / step) * step
    private fun seekListener(
        onChange: (Int, Boolean) -> Unit,
        onStop: (() -> Unit)? = null
    ) = object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(sb: SeekBar, p: Int, fromUser: Boolean) {
            onChange(p, fromUser)
        }

        override fun onStartTrackingTouch(sb: SeekBar) {}
        override fun onStopTrackingTouch(sb: SeekBar) {
            onStop?.invoke()
        }
    }

    // ── Effect sliders setup ─────────────────────────────────────────────────
    private fun setupEffectSliders() {
        val pro = binding.includePro

        fun clampEffect(v: Int) = v.coerceIn(-10, 10)

        pro.seekContrast.max = 200
        pro.seekContrast.progress = 100
        pro.labelContrast.text = "  0"
        pro.seekContrast.setOnSeekBarChangeListener(
            seekListener(
                onChange = { p, fromUser ->
                    val v = clampEffect((p - 100) / 10)
                    pro.labelContrast.text = if (v >= 0) " +$v" else "  $v"
                    if (fromUser) applyEffects()
                },
                onStop = { saveCurrentProSettings() } // Only save when finger is lifted!
            ))

        pro.seekColor.max = 200
        pro.seekColor.progress = 100
        pro.labelColor.text = "  0"
        pro.seekColor.setOnSeekBarChangeListener(
            seekListener(
            onChange = { p, fromUser ->
                val v = clampEffect((p - 100) / 10)
                pro.labelColor.text = if (v >= 0) " +$v" else "  $v"
                if (fromUser) applyEffects()
            },
            onStop = { saveCurrentProSettings() }
        ))

        pro.seekSharpness.max = 200
        pro.seekSharpness.progress = 100
        pro.labelSharpness.text = "  0"
        pro.seekSharpness.setOnSeekBarChangeListener(
            seekListener(
            onChange = { p, fromUser ->
                val v = clampEffect((p - 100) / 10)
                pro.labelSharpness.text = if (v >= 0) " +$v" else "  $v"
                if (fromUser) applyEffects()
            },
            onStop = { saveCurrentProSettings() }
        ))

        pro.presetLow.setOnClickListener {
            highlightPreset(pro.presetLow)
            applyEffectValues(contrast = 3, color = 3, sharpness = 2)
        }

        pro.presetModerate.setOnClickListener {
            highlightPreset(pro.presetModerate)
            applyEffectValues(contrast = 6, color = 5, sharpness = 5)
        }

        pro.presetHeavy.setOnClickListener {
            highlightPreset(pro.presetHeavy)
            applyEffectValues(contrast = 9, color = 8, sharpness = 8)
        }

//        pro.btnReset.setOnClickListener {
//            if (!::engine.isInitialized) return@setOnClickListener
//            clearPresetHighlights()
//            resetProControlsToAuto()
//
//            applyPreviewLayerFilter(0, 0)
//
//            engine.setISO(null, binding.previewView, isPhoto())
//            engine.setShutterSpeed(null, binding.previewView, isPhoto())
//            engine.setFPSRange(30, 30, binding.previewView, isPhoto())
//            engine.setWhiteBalance(WhiteBalance.entries[0], binding.previewView, isPhoto())
//            engine.setImageEffects(0, 0, 0)
//            val lotNum = viewModel.currentLotNumber.value ?: 1
//            viewModel.saveProSettingsForLot(lotNum, ProSettings())
//        }

        pro.btnReset.setOnClickListener {
            if (!::engine.isInitialized) return@setOnClickListener
            clearPresetHighlights()
            resetProControlsToAuto()
            applyPreviewLayerFilter(0, 0)
            engine.setISO(null, binding.previewView, isPhoto())
            engine.setShutterSpeed(null, binding.previewView, isPhoto())
            engine.setFPSRange(30, 30, binding.previewView, isPhoto())
            engine.setWhiteBalance(WhiteBalance.entries[0], binding.previewView, isPhoto())
            engine.setImageEffects(0, 0, 0)
            val lotNum = viewModel.currentLotNumber.value ?: 1
            viewModel.saveProSettingsForLot(lotNum, ProSettings())
            // Wipe the persisted store so the next app launch starts from AUTO
            ProSettingsStore.clear(this)
        }

        pro.btnApply.setOnClickListener {
            if (!::engine.isInitialized) return@setOnClickListener
            saveCurrentProSettings()
            val lotNum = viewModel.currentLotNumber.value ?: 1
            val settings = viewModel.getProSettingsForLot(lotNum)
            applyProSettingsToEngine(settings)
            isProMode = false
            binding.includePro.root.visibility = View.GONE
            binding.btnProMode.setTextColor(Color.WHITE)
        }
    }

    private fun applyEffectValues(contrast: Int, color: Int, sharpness: Int) {
        val pro = binding.includePro

        pro.seekContrast.progress = effectToProgress(contrast)
        pro.seekColor.progress = effectToProgress(color)
        pro.seekSharpness.progress = effectToProgress(sharpness)

        pro.labelContrast.text = if (contrast >= 0) " +$contrast" else "  $contrast"
        pro.labelColor.text = if (color >= 0) " +$color" else "  $color"
        pro.labelSharpness.text = if (sharpness >= 0) " +$sharpness" else "  $sharpness"

        applyEffects()
        saveCurrentProSettings()
    }

    private fun applyEffects() {
        if (!::engine.isInitialized) return
        val pro = binding.includePro

        val contrast = progressToEffect(pro.seekContrast.progress) * 10
        val color = progressToEffect(pro.seekColor.progress) * 10
        val sharpness = progressToEffect(pro.seekSharpness.progress) * 10

        engine.setImageEffects(contrast, color, sharpness)
    }

    private fun highlightPreset(selected: View) {
        val pro = binding.includePro
        listOf(pro.presetLow, pro.presetModerate, pro.presetHeavy).forEach { btn ->
            btn.setTextColor(Color.WHITE)
            btn.setBackgroundResource(R.drawable.bg_zoom_pill)
        }
        (selected as? AppCompatTextView)?.apply {
            setTextColor(AMBER)
            setBackgroundResource(R.drawable.bg_click_solid_color)
        }
    }

    private fun clearPresetHighlights() {
        val pro = binding.includePro
        listOf(pro.presetLow, pro.presetModerate, pro.presetHeavy).forEach { btn ->
            btn.setTextColor(Color.WHITE)
            btn.setBackgroundResource(R.drawable.bg_zoom_pill)
        }
    }

    private fun turnOffProMode() {
        if (!isProMode) return
        isProMode = false
        binding.includePro.root.visibility = View.GONE
        binding.btnProMode.setTextColor(Color.WHITE)
        binding.btnProMode.setBackgroundResource(R.drawable.bg_zoom_pill)
        if (::engine.isInitialized) {
            engine.setAutoMode(binding.previewView, false)
        }
        resetProControlsToAuto()
    }

    private fun setupImageFormatPicker() {
        val pro = binding.includePro

        // Hide AVIF chip on devices that cannot encode it
        try {
            pro.fmtAvif.visibility =
                if (ImageFormatStore.isAvifSupported()) View.VISIBLE else View.GONE
        } catch (_: Exception) { /* view not yet in layout — skip */
        }

        fun applyFormatUI(format: ImageFormatStore.Format) {
            selectedImageFormat = format

            // Save the selection to SharedPreferences immediately
            ImageFormatStore.save(this, format)

            if (::engine.isInitialized) {
                engine.setOutputFormat(format)
                engine.set12MPOutput(OutputQualityStore.load(this))
            }

            // Highlight the active chip, reset the others
            val chips = mapOf(
                ImageFormatStore.Format.JPEG to runCatching { pro.fmtJpeg }.getOrNull(),
                ImageFormatStore.Format.WEBP to runCatching { pro.fmtWebp }.getOrNull(),
                ImageFormatStore.Format.AVIF to runCatching { pro.fmtAvif }.getOrNull()
            )
            chips.forEach { (fmt, chip) ->
                chip ?: return@forEach
                val isActive = fmt == format
                chip.setTextColor(if (isActive) AMBER else android.graphics.Color.WHITE)
                chip.setBackgroundResource(
                    if (isActive) R.drawable.bg_zoom_selected else R.drawable.bg_zoom_pill
                )
            }
        }

        // ── THE FIX IS HERE ──
        // Load the globally persisted format from SharedPreferences FIRST
        selectedImageFormat = ImageFormatStore.load(this)

        // Then apply it to the UI (this handles fresh app starts AND rotation)
        applyFormatUI(selectedImageFormat)

        // Wire click listeners
        runCatching { pro.fmtJpeg.setOnClickListener { applyFormatUI(ImageFormatStore.Format.JPEG) } }
        runCatching { pro.fmtWebp.setOnClickListener { applyFormatUI(ImageFormatStore.Format.WEBP) } }
        runCatching { pro.fmtAvif.setOnClickListener { applyFormatUI(ImageFormatStore.Format.AVIF) } }

        // ── 12 MP toggle ─────────────────────────────────────────────────────────
        val switch12MP = runCatching { pro.switch12MP }.getOrNull() ?: return

        // Restore persisted preference
        val saved12MP = OutputQualityStore.load(this)
        switch12MP.isChecked = saved12MP
        if (::engine.isInitialized) engine.set12MPOutput(saved12MP)

        switch12MP.setOnCheckedChangeListener { _, isChecked ->
            OutputQualityStore.save(this, isChecked)
            if (::engine.isInitialized) engine.set12MPOutput(isChecked)
        }
    }

    private fun progressToEffect(progress: Int): Int =
        ((progress - 100) / 10).coerceIn(-10, 10)

    private fun effectToProgress(value: Int): Int =
        (value * 10 + 100).coerceIn(0, 200)

}
