package expo.modules.auctioncamera.ui.camera

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ThumbAdapter(
    private val uris: List<Uri>,
    private val onClick: (Int) -> Unit,
) : RecyclerView.Adapter<ThumbAdapter.VH>() {

    private var selectedPos = 0
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    inner class VH(
        val root: FrameLayout,
        val thumb: ImageView,
        val badge: ImageView,
    ) : RecyclerView.ViewHolder(root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val ctx  = parent.context
        val dp   = ctx.resources.displayMetrics.density
        val size = (80 * dp).toInt()
        val badgeSz = (30 * dp).toInt()

        val thumb = ImageView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            scaleType = ImageView.ScaleType.CENTER_CROP
        }

        val badge = object : ImageView(ctx) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            override fun onDraw(c: Canvas) {
                val cx = width / 2f; val cy = height / 2f; val r = width / 2f - 2f
                paint.color = Color.parseColor("#BB000000")
                c.drawCircle(cx, cy, r, paint)
                paint.color = Color.WHITE
                val ts = r * 0.45f
                val path = Path().apply {
                    moveTo(cx - ts * 0.6f, cy - ts)
                    lineTo(cx + ts,         cy)
                    lineTo(cx - ts * 0.6f, cy + ts)
                    close()
                }
                c.drawPath(path, paint)
            }
        }.apply {
            layoutParams = FrameLayout.LayoutParams(badgeSz, badgeSz).apply {
                gravity = android.view.Gravity.CENTER
            }
            visibility = android.view.View.GONE
        }

        val root = FrameLayout(ctx).apply {
            layoutParams = ViewGroup.MarginLayoutParams(size, size).apply {
                setMargins(4, 4, 4, 4)
            }
            addView(thumb)
            addView(badge)
        }

        return VH(root, thumb, badge)
    }

    override fun getItemCount() = uris.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val isVideo = LotGalleryActivity.isVideoUri(uris[position])

        if (position == selectedPos) {
            holder.thumb.alpha = 1f
            holder.root.setBackgroundColor(0xFFFF9800.toInt())
            holder.root.setPadding(3, 3, 3, 3)
        } else {
            holder.thumb.alpha = 0.75f
            holder.root.setBackgroundColor(Color.TRANSPARENT)
            holder.root.setPadding(0, 0, 0, 0)
        }

        holder.badge.visibility =
            if (isVideo) android.view.View.VISIBLE else android.view.View.GONE

        holder.thumb.setImageDrawable(null)
        scope.launch {
            val bmp = withContext(Dispatchers.IO) { loadBitmap(holder.thumb, uris[position]) }
            if (holder.bindingAdapterPosition == position) {
                if (bmp != null) holder.thumb.setImageBitmap(bmp)
                else holder.thumb.setImageResource(android.R.drawable.ic_menu_gallery)
            }
        }

        holder.root.setOnClickListener { onClick(position) }
    }

    fun setSelected(pos: Int) {
        val old = selectedPos
        selectedPos = pos
        notifyItemChanged(old)
        notifyItemChanged(pos)
    }

    private fun loadBitmap(iv: ImageView, uri: Uri): Bitmap? = runCatching {
        if (LotGalleryActivity.isVideoUri(uri)) {
            val retriever = MediaMetadataRetriever()
            try {
                when (uri.scheme) {
                    "file" -> retriever.setDataSource(uri.path)
                    else   -> retriever.setDataSource(iv.context, uri)
                }
                retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            } finally {
                retriever.release()
            }
        } else {
            when (uri.scheme) {
                "file" -> {
                    val path = uri.path ?: return@runCatching null
                    val opts = BitmapFactory.Options().apply {
                        inJustDecodeBounds = true
                        BitmapFactory.decodeFile(path, this)
                        inSampleSize = sample(outWidth, outHeight)
                        inJustDecodeBounds = false
                    }
                    BitmapFactory.decodeFile(path, opts)
                }
                else -> {
                    val ctx  = iv.context
                    val opts = BitmapFactory.Options()
                    ctx.contentResolver.openInputStream(uri)?.use { s ->
                        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeStream(s, null, o)
                        opts.inSampleSize = sample(o.outWidth, o.outHeight)
                    }
                    ctx.contentResolver.openInputStream(uri)?.use { s ->
                        BitmapFactory.decodeStream(s, null, opts)
                    }
                }
            }
        }
    }.getOrNull()

    private fun sample(w: Int, h: Int, req: Int = 200): Int {
        var s = 1
        if (w > req || h > req) while ((w / s / 2) >= req && (h / s / 2) >= req) s *= 2
        return s
    }
}