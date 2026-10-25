package expo.modules.auctioncamera.ui.camera

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.database.Cursor
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.widget.Toast
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import expo.modules.auctioncamera.ui.base.BaseActivity
import androidx.recyclerview.widget.LinearLayoutManager
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.databinding.ActivityLotGalleryBinding
import expo.modules.auctioncamera.viewextensions.CameraViewModel
import expo.modules.auctioncamera.viewextensions.ImageDetailsDialog
import expo.modules.auctioncamera.viewextensions.ImageEditDialog
import expo.modules.auctioncamera.viewextensions.LotPayload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.abs

class LotGalleryActivity : BaseActivity(), TextureView.SurfaceTextureListener {

    private lateinit var binding: ActivityLotGalleryBinding
    private val viewModel: CameraViewModel by viewModels()
    private val photos = mutableListOf<Uri>()
    private var currentIdx = 0
    private var lotNumber = 1
    private lateinit var thumbAdapter: ThumbAdapter
    private lateinit var gestureDetector: GestureDetector
    private lateinit var scaleGestureDetector: ScaleGestureDetector

    private var mediaPlayer: MediaPlayer? = null
    private var videoSurface: Surface? = null
    private var isVideoMode = false
    private var videoScaleFactor = 1f
    private var videoPivotX = 0f
    private var videoPivotY = 0f

    private var pendingVideoPosition = 0
    private var pendingVideoResume = true

    private val timerHandler = Handler(Looper.getMainLooper())
    private var timerSeconds = 0
    private val timerRunnable = object : Runnable {
        override fun run() {
            timerSeconds++
            binding.tvTimer.text = "%02d:%02d".format(timerSeconds / 60, timerSeconds % 60)
            timerHandler.postDelayed(this, 1000)
        }
    }

    companion object {
        private const val EXTRA_LOT_NUMBER  = "lot_number"
        private const val EXTRA_PHOTO_URIS  = "photo_uris"
        private const val EXTRA_START_INDEX = "start_index"
        private const val STATE_CURRENT_INDEX = "state_current_index"
        private const val SWIPE_MIN_DISTANCE = 80
        private const val SWIPE_MIN_VELOCITY = 80

        fun launch(ctx: Context, lotNumber: Int, uris: List<Uri>, startIndex: Int = 0) {
            ctx.startActivity(
                Intent(ctx, LotGalleryActivity::class.java).apply {
                    putExtra(EXTRA_LOT_NUMBER, lotNumber)
                    putStringArrayListExtra(EXTRA_PHOTO_URIS, ArrayList(uris.map { it.toString() }))
                    putExtra(EXTRA_START_INDEX, startIndex)
                }
            )
        }

        fun launchFromLot(ctx: Context, lotNumber: Int, lot: LotPayload) {
            val uris = mutableListOf<Uri>()
            lot.files.forEach { uris.add(Uri.parse(it.uri)) }
            lot.extraFiles.forEach { uris.add(Uri.parse(it.uri)) }
            lot.videoFile?.let { uris.add(Uri.parse(it.uri)) }
            launch(ctx, lotNumber, uris)
        }

        fun isVideoUri(uri: Uri): Boolean {
            val path = uri.path ?: uri.toString()
            return path.endsWith(".mp4", ignoreCase = true)
                    || path.endsWith(".3gp", ignoreCase = true)
                    || path.endsWith(".mov", ignoreCase = true)
                    || path.contains("VID_", ignoreCase = true)
                    || path.contains("video", ignoreCase = true)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lotNumber = intent.getIntExtra(EXTRA_LOT_NUMBER, 1)
        val uriStrings = intent.getStringArrayListExtra(EXTRA_PHOTO_URIS) ?: emptyList<String>()
        photos.addAll(orderUrisForGallery(uriStrings.map { Uri.parse(it) }))
        val startIdx = intent.getIntExtra(EXTRA_START_INDEX, 0)
        currentIdx = startIdx.coerceIn(0, (photos.size - 1).coerceAtLeast(0))
        val restoredIdx = savedInstanceState?.getInt(STATE_CURRENT_INDEX, currentIdx) ?: currentIdx
        currentIdx = restoredIdx.coerceIn(0, (photos.size - 1).coerceAtLeast(0))
        initUI(isRotationRestore = false, newConfig = null)
        setupEdgeToEdge()
    }

    private fun setupEdgeToEdge() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            val systemBars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            
            val left = systemBars.left
            val top = systemBars.top
            val right = systemBars.right
            val bottom = systemBars.bottom

            // Use direct findViewById to be safer than binding which might be stale or nullable
            findViewById<androidx.constraintlayout.widget.Guideline>(R.id.safeLeft)?.setGuidelineBegin(left)
            findViewById<androidx.constraintlayout.widget.Guideline>(R.id.safeTop)?.setGuidelineBegin(top)
            findViewById<androidx.constraintlayout.widget.Guideline>(R.id.safeRight)?.setGuidelineEnd(right)
            findViewById<androidx.constraintlayout.widget.Guideline>(R.id.safeBottom)?.setGuidelineEnd(bottom)

            insets
        }
        window.decorView.requestApplyInsets()
    }

    private fun initUI(isRotationRestore: Boolean, newConfig: Configuration?) {
        if (isRotationRestore){
            newConfig?.let {
                val configContext = createConfigurationContext(newConfig)
                val themedContext = androidx.appcompat.view.ContextThemeWrapper(
                    configContext,
                    theme
                )
                val inflater = layoutInflater.cloneInContext(themedContext)
                binding = ActivityLotGalleryBinding.inflate(inflater)
                setContentView(binding.root)
            }
        }else{
            binding = ActivityLotGalleryBinding.inflate(layoutInflater)
            setContentView(binding.root)
        }
        binding.videoView.surfaceTextureListener = this
        binding.imageViewRecord.setOnClickListener { togglePlayPause() }
        binding.videoControlBar.visibility = View.GONE
        setupGestureDetectors()
        setupThumbnailStrip()
        showMedia(currentIdx, isRotationRestore)
        binding.btnBack.setOnClickListener { finish() }
        binding.btnBackToCamera.setOnClickListener { finish() }
        binding.btnDelete.setOnClickListener {
            if (photos.isNotEmpty()) {
                val uriToDelete = photos[currentIdx]
                viewModel.deleteMedia(uriToDelete, lotNumber)
                photos.removeAt(currentIdx)
                if (photos.isEmpty()) finish() else {
                    currentIdx = currentIdx.coerceAtMost(photos.size - 1)
                    thumbAdapter.notifyDataSetChanged()
                    showMedia(currentIdx, isRotationRestore = false)
                }
            }
        }
        binding.btnEditImage.setOnClickListener {
            if (photos.isEmpty() || isVideoUri(photos[currentIdx])) return@setOnClickListener
            val uri = photos[currentIdx]
            ImageEditDialog(imageUri = uri, onSaved = { _ ->
                showMedia(currentIdx, isRotationRestore = false)
                thumbAdapter.notifyItemChanged(currentIdx)
            }).show(supportFragmentManager, "edit_dialog")
        }
        binding.btnInfo.setOnClickListener {
            lifecycleScope.launch {
                val uri = photos[currentIdx]
                val details = if (isVideoUri(uri)) buildVideoDetails(uri) else buildImageDetails(uri)
                ImageDetailsDialog(details).show(supportFragmentManager, "details")
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)

        // Save current video state before destroying the old surface
        val wasPlaying = mediaPlayer?.isPlaying == true
        pendingVideoPosition = mediaPlayer?.currentPosition ?: 0
        pendingVideoResume = wasPlaying

        // Clean up active threads to prevent UI leaks
        timerHandler.removeCallbacks(timerRunnable)
        releaseMediaPlayer()
        videoSurface = null

        // Re-build UI for Landscape/Portrait
        initUI(isRotationRestore = true, newConfig)
        setupEdgeToEdge()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(STATE_CURRENT_INDEX, currentIdx)
    }

    override fun onPause() {
        super.onPause()
        if (isVideoMode) pauseVideo()
    }

    override fun onDestroy() {
        super.onDestroy()
        timerHandler.removeCallbacks(timerRunnable)
        releaseMediaPlayer()
    }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, w: Int, h: Int) {
        videoSurface = Surface(surface)
        if (isVideoMode) playCurrentVideo()
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, w: Int, h: Int) {}
    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean { videoSurface = null; return true }
    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}

    private fun togglePlayPause() {
        val mp = mediaPlayer ?: return
        if (mp.isPlaying) pauseVideo() else resumeVideo()
    }

    private fun pauseVideo() {
        mediaPlayer?.pause(); timerHandler.removeCallbacks(timerRunnable); binding.imageViewRecord.setImageResource(R.drawable.ic_resume)
    }

    private fun resumeVideo() {
        mediaPlayer?.start(); timerHandler.post(timerRunnable); binding.imageViewRecord.setImageResource(R.drawable.ic_rec_pause)
    }

    private fun showVideoControls() {
        timerHandler.removeCallbacks(timerRunnable); timerSeconds = pendingVideoPosition / 1000
        binding.tvTimer.text = "%02d:%02d".format(timerSeconds / 60, timerSeconds % 60)
        binding.imageViewRecord.setImageResource(if (pendingVideoResume) R.drawable.ic_rec_pause else R.drawable.ic_resume)
        binding.videoControlBar.visibility = View.VISIBLE
    }

    private fun hideVideoControls() { timerHandler.removeCallbacks(timerRunnable); binding.videoControlBar.visibility = View.GONE }

    private fun setupGestureDetectors() {
        gestureDetector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
                val dx = e2.x - (e1?.x ?: e2.x); val dy = e2.y - (e1?.y ?: e2.y)
                if (abs(dx) > abs(dy) && abs(dx) >= SWIPE_MIN_DISTANCE && abs(vx) >= SWIPE_MIN_VELOCITY && videoScaleFactor <= 1f) {
                    if (dx < 0) showMedia(currentIdx + 1, false) else showMedia(currentIdx - 1, false)
                    return true
                }
                return false
            }
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean { if (isVideoMode) { togglePlayPause(); return true }; return false }
        })
        scaleGestureDetector = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(d: ScaleGestureDetector): Boolean {
                if (!isVideoMode) return false
                videoScaleFactor *= d.scaleFactor; videoScaleFactor = videoScaleFactor.coerceIn(1f, 5f)
                videoPivotX = d.focusX; videoPivotY = d.focusY; applyVideoZoom(); return true
            }
        })
        binding.gestureOverlay.setOnTouchListener { _, event -> scaleGestureDetector.onTouchEvent(event); gestureDetector.onTouchEvent(event); true }
        binding.ivMainPhoto.setOnSingleFlingListener { e1, e2, vx, _ ->
            val dx = e2.x - (e1?.x ?: e2.x)
            if (abs(dx) >= SWIPE_MIN_DISTANCE && abs(vx) >= SWIPE_MIN_VELOCITY) {
                if (dx < 0) showMedia(currentIdx + 1, false) else showMedia(currentIdx - 1, false); true
            } else false
        }
    }

    private fun applyVideoZoom() {
        val matrix = Matrix(); matrix.postScale(videoScaleFactor, videoScaleFactor, videoPivotX, videoPivotY); binding.videoView.setTransform(matrix)
    }

    private fun showMedia(index: Int, isRotationRestore: Boolean) {
        if (!isRotationRestore) { pendingVideoPosition = 0; pendingVideoResume = true }
        if (photos.isEmpty()) {
            binding.tvHeader.text = "${viewModel.repository.lotLabel(lotNumber)} \u2013 No media"; binding.ivMainPhoto.setImageDrawable(null)
            binding.videoView.visibility = View.GONE; binding.videoControlBar.visibility = View.GONE; return
        }
        currentIdx = index.coerceIn(0, photos.lastIndex)
        binding.tvHeader.text = "${viewModel.repository.lotLabel(lotNumber)} \u2013 ${currentIdx + 1}/${photos.size}"
        val uri = photos[currentIdx]; val isVideo = isVideoUri(uri)
        if (isVideo) showVideo(uri) else showPhoto(uri)
        thumbAdapter.setSelected(currentIdx); scrollThumbsToCentre(currentIdx)
    }

    private fun scrollThumbsToCentre(index: Int) {
        val lm = binding.rvThumbs.layoutManager as? LinearLayoutManager ?: return
        binding.rvThumbs.post {
            val child = lm.findViewByPosition(index) ?: binding.rvThumbs.getChildAt(0)
            val offset = if (lm.orientation == LinearLayoutManager.HORIZONTAL) {
                (binding.rvThumbs.width / 2) - ((child?.width ?: 100) / 2)
            } else {
                (binding.rvThumbs.height / 2) - ((child?.height ?: 100) / 2)
            }
            lm.scrollToPositionWithOffset(index, offset)
        }
    }

    private fun showVideo(uri: Uri) {
        isVideoMode = true; videoScaleFactor = 1f; binding.videoView.setTransform(Matrix())
        binding.ivMainPhoto.visibility = View.GONE; binding.videoView.visibility = View.VISIBLE; binding.gestureOverlay.visibility = View.VISIBLE
        releaseMediaPlayer(); showVideoControls(); if (videoSurface != null) playCurrentVideo()
    }

    private fun playCurrentVideo() {
        val uri = photos[currentIdx]
        val playUri: Uri = try {
            if (uri.scheme == "file") {
                val file = File(uri.path!!)
                if (file.exists()) androidx.core.content.FileProvider.getUriForFile(this, "${packageName}.fileprovider", file) else uri
            } else uri
        } catch (e: Exception) { uri }

        try {
            mediaPlayer = MediaPlayer().apply {
                val surface = videoSurface ?: return
                setSurface(surface)
                when (playUri.scheme) {
                    "file"    -> setDataSource(playUri.path!!)
                    "content" -> setDataSource(this@LotGalleryActivity, playUri)
                    else      -> setDataSource(playUri.toString())
                }
                isLooping = false
                setOnPreparedListener { mp ->
                    val vw = mp.videoWidth.toFloat(); val vh = mp.videoHeight.toFloat(); val tw = binding.videoView.width.toFloat(); val th = binding.videoView.height.toFloat()
                    if (vw > 0 && vh > 0 && tw > 0 && th > 0) {
                        val scale = if (tw / th > vw / vh) th / vh else tw / vw
                        val matrix = Matrix(); matrix.setScale(scale * vw / tw, scale * vh / th, tw / 2f, th / 2f)
                        binding.videoView.setTransform(matrix)
                    }
                    if (pendingVideoPosition > 0) mp.seekTo(pendingVideoPosition)
                    if (pendingVideoResume) resumeVideo()
                    pendingVideoPosition = 0; pendingVideoResume = true
                }
                setOnCompletionListener { pauseVideo() }
                prepareAsync()
            }
        } catch (e: Exception) { Toast.makeText(this, "Video play failed", Toast.LENGTH_SHORT).show() }
    }

    private fun showPhoto(uri: Uri) {
        isVideoMode = false; releaseMediaPlayer(); hideVideoControls(); binding.videoView.visibility = View.GONE; binding.ivMainPhoto.visibility = View.VISIBLE; binding.gestureOverlay.visibility = View.GONE; binding.ivMainPhoto.setScale(1f, false); loadImageAsync(uri)
    }

    private fun loadImageAsync(uri: Uri) {
        binding.ivMainPhoto.setImageDrawable(null)
        lifecycleScope.launch {
            val bmp = withContext(Dispatchers.IO) {
                try {
                    val ctx = this@LotGalleryActivity
                    when (uri.scheme) {
                        "file" -> {
                            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true; BitmapFactory.decodeFile(uri.path, this); inSampleSize = calculateSample(outWidth, outHeight); inJustDecodeBounds = false }
                            BitmapFactory.decodeFile(uri.path, opts)
                        }
                        else -> {
                            val opts = BitmapFactory.Options()
                            ctx.contentResolver.openInputStream(uri)?.use { s ->
                                val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeStream(s, null, o); opts.inSampleSize = calculateSample(o.outWidth, o.outHeight)
                            }
                            ctx.contentResolver.openInputStream(uri)?.use { s -> BitmapFactory.decodeStream(s, null, opts) }
                        }
                    }
                } catch (e: Exception) { null }
            }
            if (bmp != null) binding.ivMainPhoto.setImageBitmap(bmp) else binding.ivMainPhoto.setImageResource(android.R.drawable.ic_menu_gallery)
        }
    }

    private fun calculateSample(w: Int, h: Int): Int {
        var s = 1; if (w > 1080 || h > 1080) while ((w / s / 2) >= 1080 && (h / s / 2) >= 1080) s *= 2; return s
    }

    private fun releaseMediaPlayer() { mediaPlayer?.apply { if (isPlaying) stop(); release() }; mediaPlayer = null }

    private fun setupThumbnailStrip() {
        thumbAdapter = ThumbAdapter(photos) { idx -> showMedia(idx, isRotationRestore = false) }
        binding.rvThumbs.adapter = thumbAdapter
    }

    private fun orderUrisForGallery(input: List<Uri>): List<Uri> {
        val data = input.map { uri ->
            val ts = try {
                if (uri.scheme == "file") {
                    File(uri.path ?: "").lastModified()
                } else {
                    // For content URIs, we could try to query the provider, but 0 is a safe fallback
                    0L
                }
            } catch (e: Exception) { 0L }
            uri to ts
        }
        // Sort by timestamp ascending so the gallery matches capture and ZIP order.
        return data.sortedBy { it.second }.map { it.first }
    }

    private suspend fun buildImageDetails(uri: Uri): Map<String, String> = withContext(Dispatchers.IO) {
        val map = LinkedHashMap<String, String>()
        try {
            // 1. Get basic info (Name, Size)
            if (uri.scheme == "content") {
                contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                    if (cursor.moveToFirst()) {
                        if (nameIdx != -1) map["File Name"] = cursor.getString(nameIdx)
                        if (sizeIdx != -1) map["File Size"] = android.text.format.Formatter.formatShortFileSize(this@LotGalleryActivity, cursor.getLong(sizeIdx))
                    }
                }
            } else {
                val path = uri.path ?: ""
                val file = File(path)
                map["File Name"] = file.name
                map["File Size"] = android.text.format.Formatter.formatShortFileSize(this@LotGalleryActivity, file.length())
            }

            // 2. Extract EXIF data safely via InputStream
            val ex = contentResolver.openInputStream(uri)?.use { stream ->
                androidx.exifinterface.media.ExifInterface(stream)
            } ?: return@withContext mapOf("Error" to "Could not open stream")
            
            // 3. Extract dimensions using BitmapFactory for reliability
            val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(uri)?.use { stream ->
                android.graphics.BitmapFactory.decodeStream(stream, null, opts)
            }
            val w = opts.outWidth
            val h = opts.outHeight

            if (w > 0 && h > 0) { map["Resolution"] = "${w}x${h}"; map["Megapixels"] = "%.1f MP".format((w * h).toFloat() / 1_000_000f) }
            ex.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_MODEL)?.let { map["Device"] = it }
            ex.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_MAKE)?.let { map["Manufacturer"] = it }
            ex.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_ISO_SPEED_RATINGS)?.let { map["ISO"] = it }
            ex.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_F_NUMBER)?.let { map["Aperture"] = "f/$it" }
            ex.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_EXPOSURE_TIME)?.let { val sec = it.toDoubleOrNull() ?: 0.0; map["Shutter Speed"] = if (sec < 1.0 && sec > 0) "1/${(1.0 / sec).toInt()}s" else "${sec}s" }
            ex.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM)?.let { map["Focal Length"] = "${it}mm" }
            ex.getAttribute(androidx.exifinterface.media.ExifInterface.TAG_DATETIME)?.let { map["Date & Time"] = it }
        } catch (e: Exception) { map["Error"] = e.message ?: "Unknown Error" }
        map
    }

    private suspend fun buildVideoDetails(uri: Uri): Map<String, String> = withContext(Dispatchers.IO) {
        val map = LinkedHashMap<String, String>(); val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(this@LotGalleryActivity, uri); map["Format"] = "MPEG-4 (Video)"
            val dur = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() ?: 0L; map["Duration"] = "${dur / 1000} seconds"
            map["Resolution"] = "${retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)}x${retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)}"
            map["Bitrate"] = "${(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLong() ?: 0L) / 1000} kbps"
            if (uri.scheme == "content") {
                contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val size = cursor.getLong(0)
                        map["File Size"] = android.text.format.Formatter.formatShortFileSize(this@LotGalleryActivity, size)
                    }
                }
            } else {
                val file = File(uri.path ?: "")
                if (file.exists()) map["File Size"] = android.text.format.Formatter.formatShortFileSize(this@LotGalleryActivity, file.length())
            }
        } catch (e: Exception) { map["Error"] = "Metadata could not be read" } finally { retriever.release() }
        map
    }
}
