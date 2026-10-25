package expo.modules.auctioncamera

import android.hardware.camera2.CaptureRequest

enum class CameraMode {
    PHOTO,
    VIDEO,
    NIGHT,
    PORTRAIT
}

enum class ZoomSlot { ULTRA_WIDE, WIDE, MID, TELE }

enum class WhiteBalance(val awbMode: Int, val label: String) {
    AUTO(CaptureRequest.CONTROL_AWB_MODE_AUTO,           "Auto"),
    DAYLIGHT(CaptureRequest.CONTROL_AWB_MODE_DAYLIGHT,   "Daylight"),
    CLOUDY(CaptureRequest.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT, "Cloudy"),
    TUNGSTEN(CaptureRequest.CONTROL_AWB_MODE_INCANDESCENT, "Tungsten"),
    FLUORESCENT(CaptureRequest.CONTROL_AWB_MODE_FLUORESCENT, "Fluorescent"),
    SHADE(CaptureRequest.CONTROL_AWB_MODE_SHADE,         "Shade")
}

enum class CaptureMode(val displayLabel: String) {
    BUNDLE("Bundle"),
    ITEM  ("Item"),
    PHOTO ("Photo")
}

enum class TouchState { NONE, DRAGGING, RESIZING_TOP, RESIZING_BOTTOM, RESIZING_LEFT, RESIZING_RIGHT, RESIZING_TL, RESIZING_TR, RESIZING_BL, RESIZING_BR }
