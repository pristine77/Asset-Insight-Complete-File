package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import expo.modules.auctioncamera.TouchState

class AEAFRegionOverlay @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    interface OnRegionChangedListener {
        fun onRegionChanged(normalizedRect: RectF)
        fun onRegionCleared()
    }

    var listener: OnRegionChangedListener? = null
    var onTapInside: ((Float, Float) -> Unit)? = null
    var onTapOutside: ((Float, Float) -> Unit)? = null

    private var downTouchX = 0f
    private var downTouchY = 0f
    private val boxPaint = Paint().apply {
        color = Color.RED
        style = Paint.Style.STROKE
        strokeWidth = 6f
    }
    private val handlePaint = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.FILL
    }
    private val handleStrokePaint = Paint().apply {
        color = Color.RED
        style = Paint.Style.STROKE
        strokeWidth = 4f
    }
    private val dimPaint = Paint().apply {
        color = Color.parseColor("#99000000")
        style = Paint.Style.FILL
    }

    private var boxRect = RectF()
    private var isBoxVisible = false
    private val MIN_BOX_SIZE = 200f
    private val HANDLE_TOUCH_RADIUS = 70f
    private val HANDLE_DRAW_SIZE = 35f

    private var touchState = TouchState.NONE
    private var lastTouchX = 0f
    private var lastTouchY = 0f


    fun show() {
        this.visibility = View.VISIBLE
        isBoxVisible = true
        if (width > 0 && height > 0) {
            showInitialRegion()
        } else {
            post { showInitialRegion() }
        }
    }

    fun hide() {
        this.visibility = View.GONE
        isBoxVisible = false
        listener?.onRegionCleared()
    }

    private fun showInitialRegion() {
        if (width <= 0 || height <= 0) return
        val w = width.toFloat()
        val h = height.toFloat()

        val boxWidth = w * 0.5f
        val boxHeight = h * 0.6f

        boxRect.set(
            (w - boxWidth) / 2,
            (h - boxHeight) / 2,
            (w + boxWidth) / 2,
            (h + boxHeight) / 2
        )

        clampBox()
        invalidate()
        notifyListener()
    }

    fun forceNotifyCurrentRegion() {
        if (isBoxVisible && !boxRect.isEmpty) {
            notifyListener()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (!isBoxVisible || boxRect.isEmpty) return

        val fullRect = RectF(0f, 0f, width.toFloat(), height.toFloat())
        val path = Path().apply {
            addRect(fullRect, Path.Direction.CW)
            addRect(boxRect, Path.Direction.CCW)
        }
        canvas.drawPath(path, dimPaint)

        canvas.drawRect(boxRect, boxPaint)

        drawHandles(canvas)
    }

    private fun drawHandles(canvas: Canvas) {
        val cx = boxRect.centerX()
        val cy = boxRect.centerY()
        val r = HANDLE_DRAW_SIZE / 2f
        val hr = HANDLE_DRAW_SIZE / 1.3f

        val cornerPoints = listOf(
            PointF(boxRect.left, boxRect.top),
            PointF(boxRect.right, boxRect.top),
            PointF(boxRect.left, boxRect.bottom),
            PointF(boxRect.right, boxRect.bottom)
        )
        val sidePoints = listOf(
            PointF(cx, boxRect.top),
            PointF(cx, boxRect.bottom),
            PointF(boxRect.left, cy),
            PointF(boxRect.right, cy)
        )

        cornerPoints.forEach { p ->
            val rect = RectF(p.x - hr, p.y - hr, p.x + hr, p.y + hr)
            canvas.drawRoundRect(rect, 8f, 8f, handlePaint)
            canvas.drawRoundRect(rect, 8f, 8f, handleStrokePaint)
        }

        sidePoints.forEach { p ->
            val rect = if (p.x == cx) {
                RectF(p.x - hr, p.y - r, p.x + hr, p.y + r)
            } else {
                RectF(p.x - r, p.y - hr, p.x + r, p.y + hr)
            }
            canvas.drawRoundRect(rect, 10f, 10f, handlePaint)
            canvas.drawRoundRect(rect, 10f, 10f, handleStrokePaint)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!isBoxVisible) return false

        val x = event.x
        val y = event.y

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                touchState = getTouchState(x, y)
                lastTouchX = x
                lastTouchY = y
                downTouchX = x
                downTouchY = y
                return touchState != TouchState.NONE || boxRect.contains(x, y)
            }

            MotionEvent.ACTION_MOVE -> {
                if (touchState == TouchState.NONE) return false
                val dx = x - lastTouchX
                val dy = y - lastTouchY

                when (touchState) {
                    TouchState.DRAGGING -> boxRect.offset(dx, dy)
                    TouchState.RESIZING_TOP -> boxRect.top += dy
                    TouchState.RESIZING_BOTTOM -> boxRect.bottom += dy
                    TouchState.RESIZING_LEFT -> boxRect.left += dx
                    TouchState.RESIZING_RIGHT -> boxRect.right += dx
                    TouchState.RESIZING_TL -> { boxRect.top += dy; boxRect.left += dx }
                    TouchState.RESIZING_TR -> { boxRect.top += dy; boxRect.right += dx }
                    TouchState.RESIZING_BL -> { boxRect.bottom += dy; boxRect.left += dx }
                    TouchState.RESIZING_BR -> { boxRect.bottom += dy; boxRect.right += dx }
                    else -> {}
                }

                clampBox()
                invalidate()
                notifyListener()
                lastTouchX = x
                lastTouchY = y
                return true
            }

            MotionEvent.ACTION_UP -> {
                val totalDx = x - downTouchX
                val totalDy = y - downTouchY
                val isTap = Math.sqrt((totalDx * totalDx + totalDy * totalDy).toDouble()) < 20.0

                if (isTap) {
                    if (boxRect.contains(x, y)) {
                        onTapInside?.invoke(x, y)
                    } else {
                        onTapOutside?.invoke(x, y)
                    }
                }
                touchState = TouchState.NONE
                return true
            }

            MotionEvent.ACTION_CANCEL -> {
                touchState = TouchState.NONE
                return true
            }
        }
        return false
    }

    private fun getTouchState(x: Float, y: Float): TouchState {
        val cx = boxRect.centerX()
        val cy = boxRect.centerY()

        fun dTL() = hypot(x - boxRect.left, y - boxRect.top)
        fun dTR() = hypot(x - boxRect.right, y - boxRect.top)
        fun dBL() = hypot(x - boxRect.left, y - boxRect.bottom)
        fun dBR() = hypot(x - boxRect.right, y - boxRect.bottom)
        fun dTop() = hypot(x - cx, y - boxRect.top)
        fun dBottom() = hypot(x - cx, y - boxRect.bottom)
        fun dLeft() = hypot(x - boxRect.left, y - cy)
        fun dRight() = hypot(x - boxRect.right, y - cy)

        return when {
            dTL() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_TL
            dTR() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_TR
            dBL() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_BL
            dBR() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_BR
            dTop() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_TOP
            dBottom() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_BOTTOM
            dLeft() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_LEFT
            dRight() <= HANDLE_TOUCH_RADIUS -> TouchState.RESIZING_RIGHT
            boxRect.contains(x, y) -> TouchState.DRAGGING
            else -> TouchState.NONE
        }
    }

    private fun clampBox() {
        if (boxRect.width() < MIN_BOX_SIZE) {
            if (touchState == TouchState.RESIZING_LEFT || touchState == TouchState.RESIZING_TL || touchState == TouchState.RESIZING_BL)
                boxRect.left = boxRect.right - MIN_BOX_SIZE
            else
                boxRect.right = boxRect.left + MIN_BOX_SIZE
        }
        if (boxRect.height() < MIN_BOX_SIZE) {
            if (touchState == TouchState.RESIZING_TOP || touchState == TouchState.RESIZING_TL || touchState == TouchState.RESIZING_TR)
                boxRect.top = boxRect.bottom - MIN_BOX_SIZE
            else
                boxRect.bottom = boxRect.top + MIN_BOX_SIZE
        }

        val w = width.toFloat()
        val h = height.toFloat()
        if (w > 0 && h > 0) {
            if (boxRect.left < 0) boxRect.offset(-boxRect.left, 0f)
            if (boxRect.top < 0) boxRect.offset(0f, -boxRect.top)
            if (boxRect.right > w) boxRect.offset(w - boxRect.right, 0f)
            if (boxRect.bottom > h) boxRect.offset(0f, h - boxRect.bottom)
        }
    }

    private fun notifyListener() {
        if (width <= 0 || height <= 0) return
        val normalized = RectF(
            boxRect.left / width,
            boxRect.top / height,
            boxRect.right / width,
            boxRect.bottom / height
        )
        listener?.onRegionChanged(normalized)
    }

    private fun hypot(dx: Float, dy: Float) = Math.sqrt((dx * dx + dy * dy).toDouble()).toFloat()
}