package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.content.res.Configuration
import android.graphics.Paint
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import expo.modules.auctioncamera.R
import kotlin.math.ceil
import kotlin.math.roundToInt

/** One compact reference strip at every width; only an explicitly opened EV panel adds height. */
class CameraHeaderLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ViewGroup(context, attrs) {
    private var mainRow = emptyList<View>()
    private var rowHeight = 0
    private var expanded = false
    var isExposureInline = false
        private set
    val isExposureExpanded get() = expanded && !isExposureInline
    private var exposureAvailable = false
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    private val gap get() = dp(2)
    private val landscape get() = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    private val verticalInset get() = dp(if (landscape) 1 else 2)

    override fun onFinishInflate() {
        super.onFinishInflate()
        setWillNotDraw(false)
        findViewById<View>(R.id.evToggle).setOnClickListener { setExposureExpanded(!expanded) }
    }

    fun setExposureExpanded(value: Boolean) {
        if (landscape) return // Reference landscape has a permanently visible exposure panel.
        val next = value && exposureAvailable && !isExposureInline
        if (expanded != next) { expanded = next; requestLayout() }
    }
    fun collapseExposure() = setExposureExpanded(false)

    private fun size(view: View, width: Int, height: Int) = view.measure(
        MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), MeasureSpec.EXACTLY))
    private fun textSize(view: TextView, px: Float) {
        if (kotlin.math.abs(view.textSize - px) > 0.1f) view.setTextSize(TypedValue.COMPLEX_UNIT_PX, px)
        view.setSingleLine(true); view.setHorizontallyScrolling(false)
    }
    private fun children(view: View): List<TextView> = when (view) {
        is TextView -> listOf(view)
        is ViewGroup -> (0 until view.childCount).flatMap { children(view.getChildAt(it)) }
        else -> emptyList()
    }
    private fun fitCounts(summaryWidth: Int) {
        val counts = findViewById<GridLayout>(R.id.includeMainExtra)
        if (counts.columnCount != 3) {
            for (index in 0 until counts.childCount) {
                val child = counts.getChildAt(index)
                child.layoutParams = (child.layoutParams as GridLayout.LayoutParams).apply {
                    rowSpec = GridLayout.spec(GridLayout.UNDEFINED); columnSpec = GridLayout.spec(GridLayout.UNDEFINED)
                }
            }
            counts.columnCount = 3
        }
        val labels = children(counts)
        val base = dp(9).toFloat()
        val recordSpace = if (findViewById<View>(R.id.imageViewRecord).visibility == VISIBLE) dp(12) else 0
        val natural = labels.sumOf { ceil(Paint(it.paint).apply { textSize = base }.measureText(it.text.toString())).toInt() } + recordSpace
        val factor = minOf(1f, (summaryWidth - dp(2)).toFloat() / natural.coerceAtLeast(1)).coerceAtLeast(0.1f)
        labels.forEach { textSize(it, base * factor) }
        val title = findViewById<TextView>(R.id.textViewLot)
        title.setPadding(dp(6), dp(1), dp(6), dp(1))
        val titleBase = dp(12).toFloat()
        val titleWidth = Paint(title.paint).apply { textSize = titleBase }.measureText(title.text.toString())
        textSize(title, titleBase * minOf(1f, (summaryWidth - dp(12)).coerceAtLeast(1) / titleWidth.coerceAtLeast(1f)))
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (landscape) {
            setMeasuredDimension(0, 0)
            return
        }
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val available = (width - dp(8)).coerceAtLeast(1)
        val side = minOf(dp(if (landscape) 28 else 32), (available / 12).coerceAtLeast(dp(12)))
        val pro = findViewById<TextView>(R.id.btnProMode)
        val gallery = findViewById<ViewGroup>(R.id.galleryPreviewContainer)
        val exposure = findViewById<LinearLayout>(R.id.evContainer)
        val label = findViewById<TextView>(R.id.evLabel)
        val seek = findViewById<View>(R.id.evSeekBar)
        val toggle = findViewById<TextView>(R.id.evToggle)
        val summary = findViewById<View>(R.id.headerLotSummary)
        val tools = findViewById<LinearLayout>(R.id.topBar)
        val div1 = findViewById<View>(R.id.headerLotDivider)
        val div2 = findViewById<View>(R.id.headerToolsDivider)
        exposureAvailable = label.visibility == VISIBLE && seek.visibility == VISIBLE
        val toolButtons = (0 until tools.childCount).map { tools.getChildAt(it) }.filter { it.visibility != GONE }
        val groupCount = (if (pro.visibility != GONE) 1 else 0) + 5 + (if (exposureAvailable) 1 else 0)
        val fixed = (if (pro.visibility != GONE) side else 0) + side + side * toolButtons.size + dp(2) + (groupCount - 1) * gap
        var summaryWidth = minOf(dp(150), (available * 0.35f).roundToInt()).coerceAtLeast(1)
        var exposureWidth = (available - fixed - summaryWidth).coerceAtLeast(0)
        textSize(label, dp(11).toFloat())
        // Leave useful slider travel after its thumb/padding, otherwise offer the EV disclosure.
        val inlineMinimum = ceil(label.paint.measureText(label.text.toString())).toInt() + dp(4) + dp(80)
        isExposureInline = exposureAvailable && !landscape && exposureWidth >= inlineMinimum
        if (isExposureInline || !exposureAvailable) expanded = false
        if (!isExposureInline) {
            val toggleWidth = if (exposureAvailable) minOf(dp(56), exposureWidth) else 0
            summaryWidth += exposureWidth - toggleWidth
            exposureWidth = toggleWidth
        }
        fitCounts(summaryWidth)
        summary.measure(MeasureSpec.makeMeasureSpec(summaryWidth, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(if (landscape) 28 else 40), MeasureSpec.AT_MOST))
        if (pro.minimumWidth != 0) pro.minimumWidth = 0
        pro.setPadding(0, 0, 0, 0); textSize(pro, minOf(dp(10).toFloat(), side / 3f))
        size(pro, side, side)
        val thumb = findViewById<View>(R.id.galleryPreview)
        if (thumb.layoutParams.width != side - dp(2) || thumb.layoutParams.height != side - dp(2)) {
            thumb.layoutParams = thumb.layoutParams.apply { this.width = (side - dp(2)).coerceAtLeast(1); height = this.width }
        }
        val badge = findViewById<TextView>(R.id.galleryCount)
        val badgeSide = (side * 0.6f).roundToInt().coerceAtLeast(dp(10))
        if (badge.layoutParams.width != badgeSide || badge.layoutParams.height != badgeSide) badge.layoutParams = badge.layoutParams.apply { this.width = badgeSide; height = badgeSide }
        textSize(badge, minOf(dp(8).toFloat(), badgeSide / 2.5f))
        size(gallery, side, side)
        toolButtons.forEach { button ->
            if (button is TextView) textSize(button, dp(9).toFloat())
            else button.setPadding(side / 5, side / 5, side / 5, side / 5)
            val params = button.layoutParams
            if (params.width != side || params.height != side) button.layoutParams = params.apply { this.width = side; height = side }
        }
        size(tools, side * toolButtons.size, side)
        rowHeight = maxOf(side, summary.measuredHeight)
        size(div1, dp(1), (rowHeight - dp(4)).coerceAtLeast(1)); size(div2, dp(1), (rowHeight - dp(4)).coerceAtLeast(1))
        toggle.visibility = if (exposureAvailable && !isExposureInline) VISIBLE else GONE
        val toggleText = if (exposureWidth < dp(40)) "EV" else label.text.toString()
        if (toggle.text.toString() != toggleText) toggle.text = toggleText
        textSize(toggle, minOf(dp(10).toFloat(), exposureWidth / 5f))
        toggle.isSelected = expanded
        toggle.contentDescription = (if (expanded) "Hide exposure slider, " else "Show exposure slider, ") + label.text
        toggle.setPadding(0, 0, 0, 0)
        size(toggle, exposureWidth, side)
        exposure.visibility = if (exposureAvailable && (isExposureInline || expanded)) VISIBLE else GONE
        if (seek.minimumHeight != 0) seek.minimumHeight = 0
        val exposureHeight = if (isExposureInline) rowHeight else dp(36)
        if (seek.layoutParams.height != exposureHeight) seek.layoutParams = seek.layoutParams.apply { height = exposureHeight }
        size(exposure, if (isExposureInline) exposureWidth else available, exposureHeight)
        mainRow = listOfNotNull(pro.takeIf { it.visibility != GONE }, gallery,
            (if (isExposureInline) exposure else toggle).takeIf { exposureAvailable }, div1, summary, div2, tools)
        val height = rowHeight + verticalInset * 2 + if (expanded) gap + exposureHeight else 0
        setMeasuredDimension(resolveSize(width, widthMeasureSpec), resolveSize(height, heightMeasureSpec))
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        if (landscape) {
            return
        }
        val visible = mainRow.toSet()
        for (index in 0 until childCount) {
            val child = getChildAt(index)
            if (child !in visible && !(expanded && child.id == R.id.evContainer)) child.layout(0, 0, 0, 0)
        }
        var x = dp(4)
        for (child in mainRow) {
            val y = verticalInset + (rowHeight - child.measuredHeight) / 2
            child.layout(x, y, x + child.measuredWidth, y + child.measuredHeight)
            x += child.measuredWidth + gap
        }
        if (expanded) findViewById<View>(R.id.evContainer).let { it.layout(dp(4), rowHeight + verticalInset + gap, width - dp(4), rowHeight + verticalInset + gap + it.measuredHeight) }
    }

    override fun generateDefaultLayoutParams() = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    override fun generateLayoutParams(attrs: AttributeSet?) = LayoutParams(context, attrs)
    override fun generateLayoutParams(params: LayoutParams) = LayoutParams(params)
}
