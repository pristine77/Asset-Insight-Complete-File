package expo.modules.auctioncamera.viewextensions

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.roundToInt

class ZoomSliderView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    var minZoom = 0.6f
        set(value) {
            field = value
            currentZoom = currentZoom // Trigger coercion
        }
    var maxZoom = 8.0f
        set(value) {
            field = value
            currentZoom = currentZoom // Trigger coercion
        }
    var currentZoom = 1.0f
        set(value) {
            field = value.coerceIn(minZoom, maxZoom)
            invalidate()
        }

    var onZoomChanged: ((Float) -> Unit)? = null
    var onZoomSettled: ((Float) -> Unit)? = null
    var onStartTracking: (() -> Unit)? = null
    var onStopTracking: (() -> Unit)? = null

    private val handler = Handler(Looper.getMainLooper())
    private var settleRunnable: Runnable? = null
    private val SETTLE_DELAY_MS = 120L

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#666666")
        strokeWidth = 5f
        strokeCap = Paint.Cap.ROUND
        style = Paint.Style.STROKE
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FF6B35")
        strokeWidth = 5f
        strokeCap = Paint.Cap.ROUND
        style = Paint.Style.STROKE
    }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#33FF6B35")
        style = Paint.Style.FILL
    }
    private val thumbFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FF6B35")
        style = Paint.Style.FILL
    }
    private val thumbBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        strokeWidth = 3f
        style = Paint.Style.STROKE
    }

    private val thumbRadius = 14f
    private val glowRadius  = 20f
    private val trackY   get() = height / 2f
    private val padStart get() = thumbRadius + 6f
    private val padEnd   get() = width.toFloat() - thumbRadius - 6f

    private fun zoomToPx(zoom: Float): Float {
        val range = maxZoom - minZoom
        if (range <= 0) return padStart
        val ratio = (zoom - minZoom) / range
        return padStart + ratio * (padEnd - padStart)
    }

    private fun pxToZoom(x: Float): Float {
        val clamped = x.coerceIn(padStart, padEnd)
        val range = padEnd - padStart
        if (range <= 0) return minZoom
        val ratio   = (clamped - padStart) / range
        val raw     = minZoom + ratio * (maxZoom - minZoom)
        return (raw * 10f).roundToInt() / 10f
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = zoomToPx(currentZoom)
        val cy = trackY
        canvas.drawLine(padStart, cy, padEnd, cy, trackPaint)
        if (cx > padStart) canvas.drawLine(padStart, cy, cx, cy, fillPaint)
        canvas.drawCircle(cx, cy, glowRadius, glowPaint)
        canvas.drawCircle(cx, cy, thumbRadius, thumbFillPaint)
        canvas.drawCircle(cx, cy, thumbRadius, thumbBorderPaint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                onStartTracking?.invoke()
                parent?.requestDisallowInterceptTouchEvent(true)
                val newZoom = pxToZoom(event.x)
                if (newZoom != currentZoom) {
                    currentZoom = newZoom
                    onZoomChanged?.invoke(currentZoom)
                    scheduleSettle(currentZoom)
                }
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                val newZoom = pxToZoom(event.x)
                if (newZoom != currentZoom) {
                    currentZoom = newZoom
                    onZoomChanged?.invoke(currentZoom)
                    scheduleSettle(currentZoom)
                }
                return true
            }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL -> {
                onStopTracking?.invoke()
                parent?.requestDisallowInterceptTouchEvent(false)
                cancelSettle()
                onZoomSettled?.invoke(currentZoom)
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    private fun scheduleSettle(zoom: Float) {
        cancelSettle()
        settleRunnable = Runnable { onZoomSettled?.invoke(zoom) }
        handler.postDelayed(settleRunnable!!, SETTLE_DELAY_MS)
    }

    private fun cancelSettle() {
        settleRunnable?.let { handler.removeCallbacks(it) }
        settleRunnable = null
    }
}
