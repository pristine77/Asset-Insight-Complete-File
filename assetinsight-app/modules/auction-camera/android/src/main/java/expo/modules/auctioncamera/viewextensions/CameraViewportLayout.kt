package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.content.res.Configuration
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.constraintlayout.widget.ConstraintLayout
import expo.modules.auctioncamera.R
import kotlin.math.roundToInt

/** Landscape reference overlays, scaled together to the available height after real window insets. */
class CameraViewportLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ConstraintLayout(context, attrs) {
    private var referenceScale = 1f
    private var bottomScale = 1f
    private val landscape get() = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    private fun u(value: Float) = (value * resources.displayMetrics.density * referenceScale).roundToInt()
    private fun size(view: View, width: Int, height: Int) = view.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    private fun text(view: TextView, font: Float) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, u(font).toFloat())
        view.setSingleLine(true); view.setHorizontallyScrolling(false); view.includeFontPadding = false
    }
    private fun params(view: View, width: Int, height: Int) {
        if (view.layoutParams.width != width || view.layoutParams.height != height)
            view.layoutParams = view.layoutParams.apply { this.width = width; this.height = height }
    }
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (!landscape) { super.onMeasure(widthMeasureSpec, heightMeasureSpec); return }
        referenceScale = (MeasureSpec.getSize(heightMeasureSpec) - paddingTop - paddingBottom).coerceAtLeast(1) / (328f * resources.displayMetrics.density)
        val rail = findViewById<View>(R.id.bottomPanel)
        params(rail, u(110f), rail.layoutParams.height)
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        val preview = findViewById<View>(R.id.previewView)
        val lot = findViewById<LinearLayout>(R.id.linearLayoutLot)
        val lotText = findViewById<TextView>(R.id.textViewLot)
        text(lotText, 14f); lotText.setPadding(u(16f), 0, u(16f), 0)
        params(lotText, ViewGroup.LayoutParams.WRAP_CONTENT, u(34f))
        lot.measure(MeasureSpec.makeMeasureSpec((preview.measuredWidth / 2).coerceAtLeast(1), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(u(34f), MeasureSpec.EXACTLY))
        val mode = findViewById<TextView>(R.id.textViewSetViews)
        text(mode, 10f); size(mode, maxOf(lot.measuredWidth, u(90f)), u(16f))
        val counts = findViewById<ViewGroup>(R.id.includeMainExtra)
        fun labels(view: View): List<TextView> = when (view) { is TextView -> listOf(view); is ViewGroup -> (0 until view.childCount).flatMap { labels(view.getChildAt(it)) }; else -> emptyList() }
        labels(counts).forEach { text(it, 10f) }
        counts.measure(MeasureSpec.makeMeasureSpec((preview.measuredWidth - u(32f)).coerceAtLeast(1), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(u(18f), MeasureSpec.EXACTLY))
        val tools = findViewById<LinearLayout>(R.id.topBar)
        tools.setPadding(u(16f), u(8f), u(16f), u(8f))
        for (id in listOf(R.id.btnProMode, R.id.resToggle, R.id.btnFlash, R.id.btnFocus)) {
            val child = findViewById<View>(id)
            val isText = child is TextView
            params(child, u(if (isText) 44f else 26f), u(if (isText) 26f else 28f))
            (child.layoutParams as LinearLayout.LayoutParams).let { lp ->
                val margin = if (id == R.id.btnFocus) 0 else u(16f)
                if (lp.marginEnd != margin) { lp.marginEnd = margin; child.layoutParams = lp }
            }
            child.setPadding(0, 0, 0, 0)
            if (child is TextView) { child.minimumWidth = 0; text(child, 11f) }
        }
        tools.measure(MeasureSpec.makeMeasureSpec((preview.measuredWidth - u(32f)).coerceAtLeast(1), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(u(44f), MeasureSpec.EXACTLY))
        val ev = findViewById<LinearLayout>(R.id.evContainer)
        bottomScale = minOf(1f, preview.measuredWidth.toFloat() / u(480f).coerceAtLeast(1))
        fun bottom(value: Float) = u(value * bottomScale)
        ev.setPadding(bottom(12f), bottom(6f), bottom(12f), bottom(6f))
        val label = findViewById<TextView>(R.id.evLabel)
        val seek = findViewById<View>(R.id.evSeekBar)
        text(label, 11f * bottomScale); seek.minimumHeight = 0; params(seek, bottom(100f), bottom(24f))
        ev.visibility = if (label.visibility == VISIBLE && seek.visibility == VISIBLE) VISIBLE else GONE
        size(ev, bottom(132f), bottom(54f))
        val zoom = findViewById<LinearLayout>(R.id.zoomPanel)
        zoom.setPadding(bottom(4f), bottom(4f), bottom(4f), bottom(4f))
        listOf(R.id.zoom06, R.id.zoom1, R.id.zoom2, R.id.zoom4).forEach { text(findViewById(it), 14f * bottomScale) }
        size(zoom, bottom(180f), bottom(40f))
        val rotate = findViewById<View>(R.id.buttonFrontCamera)
        rotate.setPadding(bottom(10f), bottom(10f), bottom(10f), bottom(10f)); size(rotate, bottom(52f), bottom(52f))
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        if (!landscape) return
        val preview = findViewById<View>(R.id.previewView)
        fun bottom(value: Float) = u(value * bottomScale)
        fun place(id: Int, x: Int, y: Int) { val v = findViewById<View>(id); v.layout(x, y, x + v.measuredWidth, y + v.measuredHeight) }
        val lot = findViewById<View>(R.id.linearLayoutLot)
        place(R.id.linearLayoutLot, preview.left + u(16f), preview.top + u(16f))
        val mode = findViewById<View>(R.id.textViewSetViews)
        place(R.id.textViewSetViews, lot.left + (lot.width - mode.measuredWidth) / 2, preview.top + u(56f))
        place(R.id.includeMainExtra, preview.left + u(16f), preview.top + u(86f))
        val tools = findViewById<View>(R.id.topBar)
        place(R.id.topBar, preview.right - u(16f) - tools.measuredWidth, preview.top + u(16f))
        val ev = findViewById<View>(R.id.evContainer)
        place(R.id.evContainer, preview.left + bottom(16f), preview.bottom - bottom(16f) - ev.measuredHeight)
        val zoom = findViewById<View>(R.id.zoomPanel)
        place(R.id.zoomPanel, preview.left + (preview.width - zoom.measuredWidth) / 2, preview.bottom - bottom(16f) - zoom.measuredHeight)
        val rotate = findViewById<View>(R.id.buttonFrontCamera)
        place(R.id.buttonFrontCamera, preview.right - bottom(16f) - rotate.measuredWidth, preview.bottom - bottom(16f) - rotate.measuredHeight)
    }
}
