package com.assetinsight.app

import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import expo.modules.auctioncamera.R
import kotlin.math.abs
import kotlin.math.roundToInt

/** Geometric acceptance for the owner's Oct25 image, not the superseded sidebar/disclosure UI. */
object CameraLandscapeReferenceAssertions {
    fun assertLayout(root: ViewGroup, label: String) {
        val preview = root.findViewById<View>(R.id.previewView)
        val rail = root.findViewById<ViewGroup>(R.id.bottomPanel)
        val scale = (root.height - root.paddingTop - root.paddingBottom) / 328f
        fun u(v: Float) = (v * scale).roundToInt()
        fun bounds(id: Int): Rect {
            val view = root.findViewById<View>(id)
            return Rect(0, 0, view.width, view.height).also { root.offsetDescendantRectToMyCoords(view, it) }
        }
        val ids = listOf(R.id.linearLayoutLot, R.id.textViewSetViews, R.id.includeMainExtra, R.id.topBar,
            R.id.evContainer, R.id.zoomPanel, R.id.buttonFrontCamera, R.id.galleryPreviewContainer,
            R.id.imageViewRecordVideo, R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto,
            R.id.textViewBundleExtra, R.id.imageLeftArrow, R.id.imageRightArrow, R.id.textViewDone)
        val rectangles = ids.associateWith { bounds(it) }
        check(preview.top == root.paddingTop && preview.bottom == root.height - root.paddingBottom) { "$label preview lost full height" }
        check(preview.right == rail.left && abs(rail.width - u(110f)) <= 2) { "$label reference rail width changed" }
        check(rail.top == preview.top && rail.bottom == preview.bottom) { "$label rail moved below preview" }
        check(root.findViewById<View>(R.id.zoomToggle).visibility == View.GONE)
        check(root.findViewById<View>(R.id.evToggle).visibility == View.GONE)
        for ((id, rect) in rectangles) {
            val view = root.findViewById<View>(id)
            if (view.visibility != View.VISIBLE) continue
            check(rect.width() > 0 && rect.height() > 0 && rect.left >= root.paddingLeft && rect.top >= root.paddingTop &&
                rect.right <= rail.right && rect.bottom <= root.height - root.paddingBottom) { "$label clipped ${root.resources.getResourceEntryName(id)} $rect" }
        }
        val entries = rectangles.entries.filter { root.findViewById<View>(it.key).visibility == View.VISIBLE }
        for (a in entries.indices) for (b in a+1 until entries.size) {
            val intersection = Rect(entries[a].value)
            check(!intersection.intersect(entries[b].value) || intersection.width() <= 1 || intersection.height() <= 1) { "$label overlap ${entries[a].key}/${entries[b].key}: $intersection" }
        }
        val lot = rectangles.getValue(R.id.linearLayoutLot)
        check(abs(bounds(R.id.textViewLot).height() - u(34f)) <= 2) { "$label blue lot pill is thinner than the reference" }
        val mode = rectangles.getValue(R.id.textViewSetViews)
        val counts = rectangles.getValue(R.id.includeMainExtra)
        check(abs(lot.left - preview.left - u(16f)) <= 2 && abs(lot.top - preview.top - u(16f)) <= 2)
        check(lot.bottom < mode.top && mode.bottom < counts.top) { "$label missing stacked lot/mode/counts" }
        val toolbar = rectangles.getValue(R.id.topBar)
        check(abs(toolbar.top - preview.top - u(16f)) <= 2 && abs(preview.right - toolbar.right - u(16f)) <= 2)
        for (id in listOf(R.id.btnProMode, R.id.btnFlash, R.id.btnFocus)) check(toolbar.contains(bounds(id)))
        val ev = rectangles.getValue(R.id.evContainer)
        val zoom = rectangles.getValue(R.id.zoomPanel)
        val rotate = rectangles.getValue(R.id.buttonFrontCamera)
        check(ev.right < zoom.left && zoom.right < rotate.left && rotate.right < preview.right) { "$label bottom reference order" }
        check(abs(ev.bottom - zoom.bottom) <= 2 && abs(zoom.bottom - rotate.bottom) <= 2)
        val lensCells = listOf(R.id.zoom06, R.id.zoom1, R.id.zoom2, R.id.zoom4).map { bounds(it) }
        check(lensCells.zipWithNext().all { (a,b) -> a.right <= b.left && a.top == b.top && a.bottom == b.bottom })
        check(lensCells.all { zoom.contains(it) }) { "$label cropped lenses" }
        val actions = listOf(R.id.textViewBundle, R.id.textViewItem, R.id.textViewPhoto, R.id.textViewBundleExtra)
        val actionRects = actions.map { rectangles.getValue(it) }
        check(actionRects.zipWithNext().all { (a,b) -> a.bottom < b.top }) { "$label changed reference vertical modes" }
        check(actionRects.all { it.centerX() == rail.left + rail.width / 2 || abs(it.centerX() - (rail.left + rail.width / 2)) <= 1 })
        val prev = rectangles.getValue(R.id.imageLeftArrow); val next = rectangles.getValue(R.id.imageRightArrow)
        val done = rectangles.getValue(R.id.textViewDone)
        check(prev.top == next.top && prev.bottom == next.bottom && prev.right < next.left && done.top > prev.bottom)
        val gallery = rectangles.getValue(R.id.galleryPreviewContainer); val video = rectangles.getValue(R.id.imageViewRecordVideo)
        check(gallery.top == video.top && gallery.right < video.left && gallery.bottom < actionRects.first().top)
        fun labels(v: View): List<TextView> = when(v) { is TextView -> listOf(v); is ViewGroup -> (0 until v.childCount).flatMap { labels(v.getChildAt(it)) }; else -> emptyList() }
        for (id in ids) for (text in labels(root.findViewById(id))) {
            if (text.visibility != View.VISIBLE) continue
            check(text.layout != null && text.layout.lineCount == 1 && text.paint.measureText(text.text.toString()) <= text.width - text.paddingLeft - text.paddingRight + 2) { "$label clipped text '${text.text}'" }
        }
    }
}
