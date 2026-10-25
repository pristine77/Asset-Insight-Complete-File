package com.assetinsight.app

import android.app.Instrumentation
import android.content.res.Configuration
import android.graphics.Rect
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import expo.modules.auctioncamera.R
import expo.modules.auctioncamera.viewextensions.CameraHeaderLayout
import java.io.File

/** Primary controls fit without scrolling, clipping, overlap or tiny hit targets. */
object CameraLayoutAssertions {
    @JvmStatic fun run(instrumentation: Instrumentation) {
        var failure: Throwable? = null
        instrumentation.runOnMainSync {
            try {
            val sizes = listOf(240 to 320, 568 to 320, 640 to 320, 800 to 360, 915 to 412,
                1280 to 800, 240 to 480, 280 to 480, 320 to 480, 360 to 640, 360 to 780, 600 to 960)
            var checked = 0
            for (font in listOf(1f, 1.3f, 2f)) {
                for ((width, height) in sizes) {
                    for (inset in listOf(false, true)) {
                        val config = Configuration(instrumentation.targetContext.resources.configuration).apply {
                            fontScale = font
                            screenWidthDp = width
                            screenHeightDp = height
                            smallestScreenWidthDp = minOf(width, height)
                            orientation = if (width > height) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
                        }
                        val context = ContextThemeWrapper(instrumentation.targetContext.createConfigurationContext(config), R.style.Theme_MyAndroidTemplate)
                        val density = context.resources.displayMetrics.density
                        fun dp(value: Int) = (value * density).toInt()
                        val root = LayoutInflater.from(context).inflate(R.layout.activity_camera_view, null) as ViewGroup
                        root.findViewById<View>(R.id.btnProMode).visibility = View.VISIBLE
                        if ((width == 320 || width == 568) && font == 2f) {
                            root.findViewById<TextView>(R.id.tvMainCount).text = "324"
                            root.findViewById<TextView>(R.id.tvExtraCount).text = "324"
                            root.findViewById<TextView>(R.id.tvTotalCount).text = "648"
                        }
                        root.findViewById<View>(R.id.buttonFrontCamera).alpha = 0.35f
                        fun guide(id: Int, method: String, value: Int) {
                            val view = root.findViewById<View>(id)
                            view.javaClass.getMethod(method, Int::class.javaPrimitiveType).invoke(view, value)
                        }
                        if (width > height) {
                            root.setPadding(if (inset) dp(32) else 0, if (inset) dp(24) else 0, 0, if (inset) dp(24) else 0)
                            guide(R.id.safeRight, "setGuidelineEnd", dp(48))
                        } else {
                            guide(R.id.safeLeft, "setGuidelineBegin", if (inset) dp(8) else 0)
                            guide(R.id.safeRight, "setGuidelineEnd", if (inset) dp(8) else 0)
                            guide(R.id.safeTop, "setGuidelineBegin", if (inset) dp(24) else 0)
                            guide(R.id.safeBottom, "setGuidelineEnd", if (inset) dp(24) else 0)
                        }
                        val w = dp(width)
                        val h = dp(height)
                        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                        root.layout(0, 0, w, h)
                        if (width > height) {
                            val referenceLabel = "$width x $height font=$font inset=$inset"
                            CameraLandscapeReferenceAssertions.assertLayout(root, referenceLabel)
                            checked++
                            val doneTop = root.findViewById<View>(R.id.textViewDone).top
                            root.findViewById<View>(R.id.buttonFrontCamera).visibility = View.GONE
                            root.findViewById<View>(R.id.imageViewRecordVideo).alpha = 0.2f
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            check(root.findViewById<View>(R.id.textViewDone).top == doneTop && root.findViewById<View>(R.id.imageViewRecordVideo).alpha == 0.2f)
                            root.findViewById<View>(R.id.buttonFrontCamera).visibility = View.VISIBLE
                            root.findViewById<View>(R.id.imageViewRecordVideo).alpha = 1f
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            if (inset && (width == 568 || width == 915) && (font == 1f || font == 2f)) {
                                root.findViewById<View>(R.id.previewView).setBackgroundColor(android.graphics.Color.rgb(45, 90, 125))
                                val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                                root.draw(Canvas(bitmap))
                                File(instrumentation.targetContext.getExternalFilesDir(null), "reference-$width-font${(font*100).toInt()}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                                bitmap.recycle()
                            }
                            if (width == 800 && font == 1f) for (resizeWidth in listOf(568, 915, 640, 1280)) {
                                root.measure(View.MeasureSpec.makeMeasureSpec(dp(resizeWidth), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, dp(resizeWidth), h)
                                CameraLandscapeReferenceAssertions.assertLayout(root, "resize $resizeWidth $referenceLabel"); checked++
                            }
                            continue
                        }
                        val header = root.findViewById<CameraHeaderLayout>(R.id.cameraHeader)
                        val label = width.toString() + "x" + height + " font=" + font + " inset=" + inset
                        fun assertControls(label: String, w: Int, h: Int, exposureExpanded: Boolean = false) {
                        val exposureId = if (header.isExposureInline) R.id.evSeekBar else R.id.evToggle
                        val panel = root.findViewById<ViewGroup>(R.id.bottomPanel)
                        val rail = panel as? expo.modules.auctioncamera.viewextensions.CameraActionLayout
                        val headerIds = setOf(R.id.galleryPreviewContainer, R.id.btnFlash, R.id.btnFocus, R.id.btnProMode, exposureId) + if (width > height) setOf(R.id.buttonFrontCamera) else emptySet()
                        val ids = listOf(R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto,
                            R.id.textViewBundleExtra, R.id.imageLeftArrow, R.id.imageRightArrow, R.id.textViewDone,
                            R.id.galleryPreviewContainer, R.id.imageViewRecordVideo, R.id.btnFlash, R.id.btnFocus,
                            R.id.buttonFrontCamera, exposureId, R.id.btnProMode) +
                            if (width > height) listOf(R.id.zoomToggle) + (if (rail?.isLensesExpanded == true) listOf(R.id.zoom06, R.id.zoom1, R.id.zoom2, R.id.zoom4) else emptyList())
                            else listOf(R.id.zoom06, R.id.zoom1, R.id.zoom2, R.id.zoom4)
                        val toolbarIds = setOf(R.id.imageViewRecordVideo, R.id.buttonFrontCamera, R.id.zoom06, R.id.zoom1, R.id.zoom2, R.id.zoom4)
                        val bounds = ids.associateWith { id ->
                            val view = checkNotNull(root.findViewById<View>(id))
                            val name = context.resources.getResourceEntryName(id)
                            check(view.visibility == View.VISIBLE) { "$label hid $name" }
                            val minimum = if (id in headerIds) 16 else if (width > height) 48 else if (id in toolbarIds) 31 else 39
                            check(view.width + 1 >= dp(minimum) && view.height + 1 >= dp(minimum)) { "$label tiny $name " + view.width / density + "x" + view.height / density }
                            val rect = Rect(0, 0, view.width, view.height)
                            root.offsetDescendantRectToMyCoords(view, rect)
                            val safeEnd = if (width > height) dp(48) else 0
                            check(rect.left >= root.paddingLeft && rect.top >= root.paddingTop && rect.right <= w - safeEnd && rect.bottom <= h - root.paddingBottom) { "$label clipped $name $rect" }
                            if (view is TextView) {
                                val textWidth = view.paint.measureText(view.text.toString())
                                check(textWidth <= view.width - view.paddingLeft - view.paddingRight + 1) { "$label clipped label $name" }
                                check(view.layout.lineCount == 1) { "$label wrapped label $name" }
                            }
                            rect
                        }
                        val entries = bounds.entries.toList()
                        for (a in entries.indices) for (b in a + 1 until entries.size) {
                            val intersection = Rect(entries[a].value)
                            check(!intersection.intersect(entries[b].value) || intersection.width() <= 1 || intersection.height() <= 1) {
                                label + " overlapping " + context.resources.getResourceEntryName(entries[a].key) + " and " + context.resources.getResourceEntryName(entries[b].key) + ": " + intersection
                            }
                        }
                        check(root.findViewById<View>(R.id.buttonFrontCamera).alpha == 0.35f) { "$label reset live camera state" }
                        val lot = root.findViewById<View>(R.id.textViewLot)
                        val lotBounds = Rect(0, 0, lot.width, lot.height).also { root.offsetDescendantRectToMyCoords(lot, it) }
                        for (id in listOf(R.id.btnProMode, R.id.btnFlash, R.id.btnFocus)) {
                            check(!Rect.intersects(lotBounds, bounds.getValue(id))) { "$label header covered the lot label" }
                        }
                        check(panel !is android.widget.ScrollView)
                        val header = root.findViewById<CameraHeaderLayout>(R.id.cameraHeader)
                        val preview = root.findViewById<View>(R.id.previewView)
                        if (width > height) {
                            check(preview.top == header.top) { "$label landscape still reserves a top strip" }
                            check(android.graphics.Color.alpha((header.background as android.graphics.drawable.ColorDrawable).color) == 0) { "$label landscape header is opaque" }
                            check(header.elevation > preview.elevation) { "$label floating header would be covered by preview" }
                        } else check(preview.top >= header.bottom) { "$label portrait preview covered reference header" }
                        for (id in listOf(R.id.btnProMode, R.id.galleryPreviewContainer, exposureId, R.id.btnFlash, R.id.btnFocus)) {
                            val rect = bounds.getValue(id)
                            check(rect.top >= header.top && rect.bottom <= header.bottom) { "$label header tool outside reference strip" }
                        }
                        check(header.isExposureExpanded == exposureExpanded && header.height <= dp((if (width > height) 72 else 40) + if (exposureExpanded) 40 else 0) + 1) { "$label header expansion mismatch" }
                        val evLabel = root.findViewById<TextView>(R.id.evLabel)
                        if (header.isExposureInline) {
                            check(evLabel.paint.measureText(evLabel.text.toString()) <= evLabel.width + 1) { "$label clipped EV label" }
                            check(root.findViewById<View>(R.id.evToggle).visibility == View.GONE)
                        }
                        check(root.findViewById<View>(R.id.textViewSetViews).visibility == View.GONE) { "$label added mode row not in reference" }
                        if (width <= height) {
                        val order = listOf(R.id.btnProMode, R.id.galleryPreviewContainer,
                            if (header.isExposureInline) R.id.evContainer else R.id.evToggle,
                            R.id.headerLotSummary, R.id.topBar).map { root.findViewById<View>(it) }
                        check(order.zipWithNext().all { (a, b) -> a.right <= b.left }) { "$label reference header order changed" }
                        check(order.all { kotlin.math.abs((it.top + it.bottom) / 2 - header.height / 2) <= dp(2) }) { "$label header wrapped into multiple rows" }
                        }
                        fun labels(view: View): List<TextView> = when(view) {
                            is TextView -> listOf(view)
                            is ViewGroup -> (0 until view.childCount).flatMap { labels(view.getChildAt(it)) }
                            else -> emptyList()
                        }
                        for (text in labels(root.findViewById(R.id.headerLotSummary))) {
                            if (text.visibility != View.VISIBLE) continue
                            check(text.layout.lineCount == 1 && text.paint.measureText(text.text.toString()) <= text.width - text.paddingLeft - text.paddingRight + 1) { "$label cropped count/lot label ${text.text}" }
                        }
                        val panelBounds = Rect(0, 0, panel.width, panel.height).also { root.offsetDescendantRectToMyCoords(panel, it) }
                        if (width > height) {
                            check(preview.right <= panelBounds.left) { "$label landscape rail moved below preview" }
                            check(panel !is expo.modules.auctioncamera.viewextensions.CameraPortraitFooterLayout)
                            check(!header.isExposureInline && header.height <= dp(if (exposureExpanded) 112 else 72) + 1) { "$label landscape must use compact sidebar tools" }
                            check(root.findViewById<View>(R.id.evContainer).visibility == if (exposureExpanded) View.VISIBLE else View.GONE)
                            val zoom = root.findViewById<android.widget.GridLayout>(R.id.zoomPanel)
                            val zoomBounds = Rect(0, 0, zoom.width, zoom.height).also { root.offsetDescendantRectToMyCoords(zoom, it) }
                            val videoBounds = bounds.getValue(R.id.imageViewRecordVideo)
                            val frontBounds = bounds.getValue(R.id.buttonFrontCamera)
                            val toggleBounds = bounds.getValue(R.id.zoomToggle)
                            check(zoom.parent === panel && root.findViewById<View>(R.id.buttonFrontCamera).parent === header && root.findViewById<View>(R.id.zoomToggle).parent === panel)
                            for (rect in listOf(toggleBounds, videoBounds) + if (rail?.isLensesExpanded == true) listOf(zoomBounds) else emptyList()) {
                                check(panelBounds.contains(rect)) { "$label lens/rotate/record escaped black rail" }
                                check(rect.left >= preview.right) { "$label lens/rotate/record still overlays preview" }
                            }
                            check(videoBounds.right < toggleBounds.left) { "$label expected record, Zoom button order" }
                            check(kotlin.math.abs(toggleBounds.centerY() - videoBounds.centerY()) <= dp(1))
                            val sidebarTools = listOf(R.id.buttonFrontCamera, R.id.btnFlash, R.id.btnFocus, R.id.btnProMode, R.id.galleryPreviewContainer, R.id.evToggle)
                            for (id in sidebarTools) {
                                val rect = bounds.getValue(id)
                                check(rect.left >= panelBounds.left && rect.right <= panelBounds.right && rect.bottom <= panelBounds.top) { "$label sidebar tool outside empty upper rail: $id $rect rail=$panelBounds" }
                                check(rect.width() + 1 >= dp(32) && rect.height() + 1 >= dp(32))
                            }
                            check(frontBounds.right <= bounds.getValue(R.id.btnFlash).left &&
                                (frontBounds.bottom <= bounds.getValue(R.id.btnProMode).top || frontBounds.right <= bounds.getValue(R.id.btnProMode).left)) { "$label rotate not in upper empty sidebar" }
                            val summary = root.findViewById<ViewGroup>(R.id.headerLotSummary)
                            val summaryBounds = Rect(0, 0, summary.width, summary.height).also { root.offsetDescendantRectToMyCoords(summary, it) }
                            check(summaryBounds.right <= preview.right) { "$label summary covered sidebar" }
                            val summaryCells = (0 until summary.childCount).map { summary.getChildAt(it) }.filter { it.visibility == View.VISIBLE }
                            check(summaryCells.zipWithNext().all { (a,b) -> a.right <= b.left && kotlin.math.abs((a.top + a.bottom) - (b.top + b.bottom)) <= dp(2) }) { "$label Lot/Main/Extra/Total not one row" }
                            if (rail?.isLensesExpanded == true) {
                                check(zoom.visibility == View.VISIBLE && zoomBounds.top > toggleBounds.bottom)
                                check(zoom.columnCount == 2 || zoom.columnCount == 4)
                            } else check(zoom.visibility == View.GONE && zoom.width == 0 && zoom.height == 0) { "$label lenses not collapsed by default" }
                        } else {
                        check(kotlin.math.abs(panel.height - dp(120)) <= 1) { "$label footer grew to ${panel.height / density}dp" }
                        check(preview.bottom == panelBounds.top) { "$label footer no longer below preview" }
                        val zoom = root.findViewById<View>(R.id.zoomPanel)
                        check(kotlin.math.abs(zoom.height - dp(32)) <= 1) { "$label zoom row grew" }
                        for (row in listOf(listOf(R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto),
                            listOf(R.id.imageLeftArrow, R.id.imageRightArrow, R.id.textViewBundleExtra, R.id.textViewDone))) {
                            val cells = row.map { bounds.getValue(it) }
                            check(cells.all { it.top == cells.first().top && it.bottom == cells.first().bottom }) { "$label footer row wrapped" }
                            check(cells.zipWithNext().all { (a,b) -> a.right < b.left }) { "$label footer reference order changed" }
                            check(cells.all { kotlin.math.abs(it.height() - dp(40)) <= 1 }) { "$label action row grew" }
                        }
                        }
                        for (index in 0 until panel.childCount) {
                            val child = panel.getChildAt(index)
                            check(child.top >= 0 && child.bottom <= panel.height) { "$label action outside panel" }
                        }
                        }
                        assertControls(label, w, h)
                        if (width > height) {
                            val rail = root.findViewById<expo.modules.auctioncamera.viewextensions.CameraActionLayout>(R.id.bottomPanel)
                            root.findViewById<View>(R.id.zoomToggle).performClick()
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            check(rail.isLensesExpanded)
                            assertControls("expanded lenses: $label", w, h)
                            root.findViewById<View>(R.id.evToggle).performClick()
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            check(header.isExposureExpanded && !rail.isLensesExpanded) { "$label EV and Zoom should not crowd the short rail" }
                            assertControls("EV after Zoom: $label", w, h, exposureExpanded = true)
                            root.findViewById<View>(R.id.zoomToggle).performClick()
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            check(!header.isExposureExpanded && rail.isLensesExpanded)
                            assertControls("Zoom after EV: $label", w, h)
                            root.findViewById<View>(R.id.zoomToggle).performClick()
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            check(!rail.isLensesExpanded)
                            assertControls("collapsed lenses: $label", w, h)
                        }
                        checked++
                        val footer = root.findViewById<View>(R.id.bottomPanel)
                        val normalHeight = footer.height
                        val normalDoneTop = root.findViewById<View>(R.id.textViewDone).top
                        root.findViewById<View>(R.id.buttonFrontCamera).visibility = View.GONE
                        root.findViewById<View>(R.id.imageViewRecordVideo).alpha = 0.2f
                        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                        check(footer.height == normalHeight && root.findViewById<View>(R.id.textViewDone).top == normalDoneTop) { "$label recording visibility reflowed footer" }
                        check(root.findViewById<View>(R.id.buttonFrontCamera).visibility == View.GONE && root.findViewById<View>(R.id.imageViewRecordVideo).alpha == 0.2f)
                        root.findViewById<View>(R.id.buttonFrontCamera).visibility = View.VISIBLE
                        root.findViewById<View>(R.id.imageViewRecordVideo).alpha = 1f
                        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                        assertControls(label, w, h)
                        if (!header.isExposureInline) {
                            val collapsed = header.height
                            root.findViewById<View>(R.id.evToggle).performClick()
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            check(header.isExposureExpanded && header.height > collapsed)
                            val exposure = root.findViewById<View>(R.id.evContainer)
                            check(exposure.visibility == View.VISIBLE && exposure.top >= collapsed - dp(2)) { "$label expanded slider covered main row" }
                            check(if (width > height) root.findViewById<View>(R.id.previewView).top == header.top else root.findViewById<View>(R.id.previewView).top >= header.bottom)
                            root.findViewById<View>(R.id.evToggle).performClick()
                            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)); root.layout(0, 0, w, h)
                            check(!header.isExposureExpanded && header.height == collapsed)
                        }
                        if (inset && (width == 568 || width == 320 || width == 360 || width == 915) && (font == 1f || font == 2f)) {
                            val previewColor = android.graphics.Color.rgb(45, 90, 125)
                            if (width > height) root.findViewById<View>(R.id.previewView).setBackgroundColor(previewColor)
                            val image = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                            root.draw(Canvas(image))
                            if (width > height) {
                                val preview = root.findViewById<View>(R.id.previewView)
                                var visiblePreviewPixels = 0
                                for (y in header.top + 1 until header.bottom - 1 step 2) for (x in preview.left until preview.right step 2) {
                                    if (image.getPixel(x, y) == previewColor) visiblePreviewPixels++
                                }
                                check(visiblePreviewPixels > 10) { "$label preview pixels are not visible behind floating header" }
                            }
                            for (id in listOf(R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto, R.id.textViewBundleExtra, R.id.imageLeftArrow, R.id.imageRightArrow, R.id.textViewDone, R.id.btnProMode)) {
                                val text = root.findViewById<TextView>(id)
                                val rect = Rect(0, 0, text.width, text.height).also { root.offsetDescendantRectToMyCoords(text, it) }
                                var white = 0
                                for (y in rect.top until rect.bottom step 2) for (x in rect.left until rect.right step 2) {
                                    val color = image.getPixel(x, y)
                                    if (android.graphics.Color.red(color) > 230 && android.graphics.Color.green(color) > 230 && android.graphics.Color.blue(color) > 230) white++
                                }
                                check(white > 5) { "$label missing first-render label " + text.text + " layout=" + text.layout.width + " scroll=" + text.scrollX + "," + text.scrollY + " baseline=" + text.baseline }
                            }
                            File(instrumentation.targetContext.getExternalFilesDir(null), "responsive-" + width + "x" + height + "-font" + (font * 100).toInt() + ".png").outputStream().use {
                                check(image.compress(Bitmap.CompressFormat.PNG, 100, it))
                            }
                            image.recycle()
                        }
                        if (width == 800 && font == 1f) {
                            for (resizeWidth in listOf(568, 915, 640, 1280)) {
                                val resizedWidth = dp(resizeWidth)
                                root.measure(View.MeasureSpec.makeMeasureSpec(resizedWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                                root.layout(0, 0, resizedWidth, h)
                                assertControls("resize=" + resizeWidth + " from " + label, resizedWidth, h)
                                checked++
                            }
                        }
                    }
                }
            }
            android.util.Log.i("AssetInsightCameraTest", "PASS: $checked camera configurations, single-row header, portrait-only 120dp footer/32dp zoom/40dp actions, restored landscape right rail and complete labels")
            } catch (error: Throwable) { failure = error }
        }
        failure?.let { throw it }
    }
}
