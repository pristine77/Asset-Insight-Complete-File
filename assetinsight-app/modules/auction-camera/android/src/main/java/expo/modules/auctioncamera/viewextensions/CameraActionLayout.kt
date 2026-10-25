package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import expo.modules.auctioncamera.R
import kotlin.math.roundToInt

/** Reference landscape rail. Scale the entire reference composition, never reflow its rows. */
class CameraActionLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ViewGroup(context, attrs) {
    private var scale = 1f
    val isLensesExpanded get() = false
    // API retained for the Activity's existing zoom-selection UI hook. Lenses are now always visible.
    fun setLensesExpanded(value: Boolean) = Unit
    fun collapseLenses() = Unit
    private fun unit(value: Float) = (value * resources.displayMetrics.density * scale).roundToInt()
    private val geometry = listOf(
        intArrayOf(R.id.galleryPreviewContainer, 44, 44, 12),
        intArrayOf(R.id.imageViewRecordVideo, 44, 44, 12),
        intArrayOf(R.id.textViewBundle, 70, 40, 64),
        intArrayOf(R.id.textViewItem, 70, 40, 110),
        intArrayOf(R.id.textViewPhoto, 70, 40, 156),
        intArrayOf(R.id.textViewBundleExtra, 82, 40, 207),
        intArrayOf(R.id.imageLeftArrow, 42, 30, 250),
        intArrayOf(R.id.imageRightArrow, 42, 30, 250),
        intArrayOf(R.id.textViewDone, 90, 30, 285),
    )
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val height = MeasureSpec.getSize(heightMeasureSpec)
        scale = height / (328f * resources.displayMetrics.density)
        val width = resolveSize(unit(110f), widthMeasureSpec)
        setMeasuredDimension(width, height)
        for ((id, w, h) in geometry.map { Triple(it[0], it[1], it[2]) }) {
            val child = findViewById<View>(id)
            if (child is TextView) {
                val font = when (id) { R.id.textViewBundleExtra -> 13f; R.id.imageLeftArrow, R.id.imageRightArrow, R.id.textViewDone -> 12f; else -> 14f }
                child.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit(font).toFloat())
                child.setSingleLine(true); child.setHorizontallyScrolling(false)
                child.includeFontPadding = false
                child.setPadding(0, 0, 0, 0)
            }
            child.measure(MeasureSpec.makeMeasureSpec(unit(w.toFloat()), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(unit(h.toFloat()), MeasureSpec.EXACTLY))
        }
        val thumb = findViewById<View>(R.id.galleryPreview)
        val badge = findViewById<TextView>(R.id.galleryCount)
        if (thumb.layoutParams.width != unit(42f)) thumb.layoutParams = thumb.layoutParams.apply { this.width = unit(42f); this.height = unit(42f) }
        if (badge.layoutParams.width != unit(20f)) badge.layoutParams = badge.layoutParams.apply { this.width = unit(20f); this.height = unit(20f) }
        badge.setTextSize(TypedValue.COMPLEX_UNIT_PX, unit(10f).toFloat())
        findViewById<View>(R.id.galleryPreviewContainer).measure(MeasureSpec.makeMeasureSpec(unit(44f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(unit(44f), MeasureSpec.EXACTLY))
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        for (entry in geometry) {
            val child = findViewById<View>(entry[0])
            val x = when (entry[0]) {
                R.id.galleryPreviewContainer -> (width - unit(92f)) / 2
                R.id.imageViewRecordVideo -> (width - unit(92f)) / 2 + unit(48f)
                R.id.imageLeftArrow -> (width - unit(88f)) / 2
                R.id.imageRightArrow -> (width - unit(88f)) / 2 + unit(46f)
                else -> (width - child.measuredWidth) / 2
            }
            val y = unit(entry[3].toFloat())
            child.layout(x, y, x + child.measuredWidth, y + child.measuredHeight)
        }
    }
    override fun generateDefaultLayoutParams() = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    override fun generateLayoutParams(attrs: AttributeSet?) = LayoutParams(context, attrs)
    override fun generateLayoutParams(params: LayoutParams) = LayoutParams(params)
}
