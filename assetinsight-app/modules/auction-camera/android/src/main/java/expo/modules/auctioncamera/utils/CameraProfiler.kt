package expo.modules.auctioncamera.utils

import android.app.Activity
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Trace
import android.util.Log
import android.view.FrameMetrics
import android.view.Window

object CameraProfiler {

    private const val TAG = "CameraProfiler"
    private var frameMetricsListener: Window.OnFrameMetricsAvailableListener? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var slowFrameCount = 0
    private var jankFrameCount = 0

    fun startFrameTracking(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        try {
            frameMetricsListener = Window.OnFrameMetricsAvailableListener { _, frameMetrics, _ ->
                val totalMs = frameMetrics.getMetric(FrameMetrics.TOTAL_DURATION) / 1_000_000L
                val inputMs = frameMetrics.getMetric(FrameMetrics.INPUT_HANDLING_DURATION) / 1_000_000L
                val drawMs  = frameMetrics.getMetric(FrameMetrics.DRAW_DURATION) / 1_000_000L
                val gpuMs   = frameMetrics.getMetric(FrameMetrics.GPU_DURATION) / 1_000_000L
                when {
                    totalMs > 100L -> {
                        jankFrameCount++
                        Log.e(TAG, "Jank frame #$jankFrameCount: total=${totalMs}ms " +
                                "input=${inputMs}ms draw=${drawMs}ms gpu=${gpuMs}ms")
                    }
                    totalMs > 50L -> {
                        slowFrameCount++
                        if (slowFrameCount % 5 == 0) {
                            Log.w(TAG, " Slow frame x$slowFrameCount: total=${totalMs}ms " +
                                    "input=${inputMs}ms draw=${drawMs}ms gpu=${gpuMs}ms")
                        }
                    }
                }
            }
            activity.window.addOnFrameMetricsAvailableListener(
                frameMetricsListener!!, mainHandler
            )
            Log.d(TAG, "Frame tracking started")
        } catch (e: Exception) {
            Log.e(TAG, "Frame tracking init failed: ${e.message}")
        }
    }

    fun stopFrameTracking(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        try {
            frameMetricsListener?.let {
                activity.window.removeOnFrameMetricsAvailableListener(it)
            }
            frameMetricsListener = null
            slowFrameCount = 0
            jankFrameCount = 0
            Log.d(TAG, "Frame tracking stopped \u2014 slow=$slowFrameCount jank=$jankFrameCount")
        } catch (e: Exception) {
            Log.e(TAG, "Frame tracking stop failed: ${e.message}")
        }
    }

    fun beginSection(name: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Trace.beginAsyncSection(name, 0)
        } else {
            Trace.beginSection(name)
        }
        Log.d(TAG, "\u25b6 BEGIN $name")
    }

    fun endSection(name: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Trace.endAsyncSection(name, 0)
        } else {
            Trace.endSection()
        }
        Log.d(TAG, "\u23f9 END $name")
    }

    fun logMemory(tag: String = "") {
        val rt    = Runtime.getRuntime()
        val used  = (rt.totalMemory() - rt.freeMemory()) / 1_048_576L
        val total = rt.totalMemory() / 1_048_576L
        val max   = rt.maxMemory()   / 1_048_576L
        Log.d(TAG, "\ud83d\udcca Memory [$tag] used=${used}MB total=${total}MB max=${max}MB")
    }

    fun logState(key: String, value: String) {
        Log.d(TAG, "State \u2192 $key=$value")
    }
}