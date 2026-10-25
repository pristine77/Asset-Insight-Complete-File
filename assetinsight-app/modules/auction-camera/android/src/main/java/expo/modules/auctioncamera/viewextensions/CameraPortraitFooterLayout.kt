package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import expo.modules.auctioncamera.R
import kotlin.math.roundToInt

/** Reference footer: 32dp tools + two 40dp action rows + two 4dp gaps, never reflow. */
class CameraPortraitFooterLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ViewGroup(context, attrs) {
    private val divider = Paint().apply { color = 0x55FFFFFF }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    private val captureIds = listOf(R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto)
    private val actionIds = listOf(R.id.imageLeftArrow, R.id.imageRightArrow, R.id.textViewBundleExtra, R.id.textViewDone)
    private var toolsHeight = 0
    private var actionHeight = 0
    private var gap = 0

    override fun onFinishInflate() {
        super.onFinishInflate()
        setWillNotDraw(false)
        for (id in captureIds + actionIds) findViewById<TextView>(id).apply {
            minimumWidth = 0; minimumHeight = 0
            setSingleLine(true); setHorizontallyScrolling(false)
            includeFontPadding = false
            setPadding(dp(4), 0, dp(4), 0)
            setCompoundDrawables(null, null, null, null)
        }
    }

    private fun measure(view: View, width: Int, height: Int) {
        view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), MeasureSpec.EXACTLY))
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = resolveSize(dp(120), heightMeasureSpec)
        // Normally exactly 120dp. Only shrink for an exceptionally tiny host, never grow.
        val scale = minOf(1f, height.toFloat() / dp(120).coerceAtLeast(1))
        toolsHeight = (dp(32) * scale).roundToInt()
        gap = (dp(4) * scale).roundToInt()
        actionHeight = ((height - toolsHeight - gap * 2) / 2).coerceAtLeast(0)
        setMeasuredDimension(width, height)
        val side = minOf(toolsHeight, (width - dp(8)).coerceAtLeast(0) / 6)
        for (id in listOf(R.id.buttonFrontCamera, R.id.imageViewRecordVideo)) findViewById<View>(id).let {
            it.setPadding(side / 6, side / 6, side / 6, side / 6)
            measure(it, side, toolsHeight)
        }
        measure(findViewById(R.id.zoomPanel), (width - dp(8) - side * 2 - gap * 2).coerceAtLeast(0), toolsHeight)
        for (ids in listOf(captureIds, actionIds)) {
            val usable = (width - dp(8) - gap * (ids.size - 1)).coerceAtLeast(0)
            ids.forEachIndexed { index, id ->
                val view = findViewById<TextView>(id)
                val cell = (index + 1) * usable / ids.size - index * usable / ids.size
                val base = dp(14).toFloat() * scale
                val natural = Paint(view.paint).apply { textSize = base }.measureText(view.text.toString())
                val font = base * minOf(1f, (cell - view.paddingLeft - view.paddingRight).coerceAtLeast(1) / natural.coerceAtLeast(1f))
                if (kotlin.math.abs(view.textSize - font) > 0.1f) view.setTextSize(TypedValue.COMPLEX_UNIT_PX, font)
                measure(view, cell, actionHeight)
            }
        }
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        var x = dp(4)
        for (id in listOf(R.id.buttonFrontCamera, R.id.zoomPanel, R.id.imageViewRecordVideo)) {
            val view = findViewById<View>(id)
            // Keep slots stable while recording/lens availability changes visibility.
            view.layout(x, 0, x + view.measuredWidth, toolsHeight)
            x += view.measuredWidth + gap
        }
        var y = toolsHeight + gap
        for (ids in listOf(captureIds, actionIds)) {
            x = dp(4)
            for (id in ids) findViewById<View>(id).let {
                it.layout(x, y, x + it.measuredWidth, y + actionHeight)
                x += it.measuredWidth + gap
            }
            y += actionHeight + gap
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        divider.strokeWidth = dp(1).toFloat()
        for (id in listOf(R.id.buttonFrontCamera, R.id.zoomPanel)) {
            val child = findViewById<View>(id)
            val x = child.right + gap / 2f
            canvas.drawLine(x, dp(4).toFloat(), x, (toolsHeight - dp(4)).toFloat(), divider)
        }
    }

    override fun generateDefaultLayoutParams() = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    override fun generateLayoutParams(attrs: AttributeSet?) = LayoutParams(context, attrs)
    override fun generateLayoutParams(params: LayoutParams) = LayoutParams(params)
}

/** Four stable zoom slots; selected circles stay small instead of stretching into pills. */
class CameraZoomLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ViewGroup(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = MeasureSpec.getSize(heightMeasureSpec)
        val side = minOf(height, width / childCount.coerceAtLeast(1))
        for (index in 0 until childCount) {
            val view = getChildAt(index) as TextView
            view.minimumWidth = 0; view.minimumHeight = 0
            view.setPadding(0, 0, 0, 0)
            view.setSingleLine(true); view.setHorizontallyScrolling(false)
            val font = minOf(14 * resources.displayMetrics.density, side / 2f)
            if (kotlin.math.abs(view.textSize - font) > 0.1f) view.setTextSize(TypedValue.COMPLEX_UNIT_PX, font)
            view.measure(MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY))
        }
        setMeasuredDimension(width, height)
    }
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        for (index in 0 until childCount) {
            val view = getChildAt(index)
            val x = ((2 * index + 1) * width / childCount - view.measuredWidth) / 2
            val y = (height - view.measuredHeight) / 2
            view.layout(x, y, x + view.measuredWidth, y + view.measuredHeight)
        }
    }
    override fun generateDefaultLayoutParams() = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    override fun generateLayoutParams(attrs: AttributeSet?) = LayoutParams(context, attrs)
    override fun generateLayoutParams(params: LayoutParams) = LayoutParams(params)
}
