"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Save, Undo2, Eraser, Type, Pencil, Palette } from "lucide-react";

export type AnnotatorMode = "draw" | "text";

type Props = {
  open: boolean;
  file: File | null;
  onClose: () => void;
  onSave: (annotatedFile: File) => void;
};

type StrokePoint = { x: number; y: number };

type Action =
  | {
      type: "stroke";
      color: string;
      size: number;
      points: StrokePoint[];
    }
  | {
      type: "text";
      color: string;
      size: number; // font size px
      text: string;
      x: number;
      y: number;
    };

export default function ImageAnnotatorModal({
  open,
  file,
  onClose,
  onSave,
}: Props) {
  const TEXT_ADD_DEFAULT_SIZE = 16;
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [mode, setMode] = useState<AnnotatorMode>("draw");
  const [color, setColor] = useState<string>("#2563eb"); // cobalt
  const [size, setSize] = useState<number>(12);
  const [actions, setActions] = useState<Action[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<StrokePoint[]>([]);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // Track both canvas coords (for drawing) and CSS coords (for placing the input card)
  const [pendingTextCanvasPos, setPendingTextCanvasPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [pendingTextCssPos, setPendingTextCssPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [pendingText, setPendingText] = useState<string>("");
  // Edit existing text state
  const [editTextIndex, setEditTextIndex] = useState<number | null>(null);
  const [editTextColor, setEditTextColor] = useState<string>("#2563eb");
  const [editTextSize, setEditTextSize] = useState<number>(
    TEXT_ADD_DEFAULT_SIZE
  );
  const [textEditorCssPos, setTextEditorCssPos] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Viewport transform for pinch-to-zoom and panning
  const [viewportScale, setViewportScale] = useState<number>(1);
  const [viewportOffset, setViewportOffset] = useState<{
    x: number;
    y: number;
  }>({ x: 0, y: 0 });
  const MIN_SCALE = 1;
  const MAX_SCALE = 6;
  const activePointers = useRef<Map<number, { x: number; y: number }>>(
    new Map()
  );
  const pinchStartScale = useRef<number>(1);
  const pinchStartOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pinchStartDist = useRef<number>(0);

  // Drag-to-move state for text
  const [dragTextIndex, setDragTextIndex] = useState<number | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragTextStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef<boolean>(false);

  // Stage overlay box (screen-aligned area for non-transformed UI)
  const [stageBox, setStageBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>({ left: 0, top: 0, width: 0, height: 0 });
  useEffect(() => {
    const update = () => {
      const canvas = overlayRef.current;
      const cont = containerRef.current;
      if (!canvas || !cont) return;
      const cr = canvas.getBoundingClientRect();
      const cot = cont.getBoundingClientRect();
      setStageBox({
        left: cr.left - cot.left,
        top: cr.top - cot.top,
        width: cr.width,
        height: cr.height,
      });
    };
    update();
    const onResize = () => update();
    window.addEventListener("resize", onResize);
    const contEl = containerRef.current;
    const onScroll = () => update();
    contEl?.addEventListener("scroll", onScroll, { passive: true } as any);
    return () => {
      window.removeEventListener("resize", onResize);
      contEl?.removeEventListener("scroll", onScroll as any);
    };
  }, [viewportScale, viewportOffset, imgEl, open, actions.length]);

  // Load image element when file changes
  useEffect(() => {
    if (!open || !file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      setImageLoaded(true);
    };
    img.onerror = () => {
      setImageLoaded(false);
    };
    img.src = url;
    return () => {
      URL.revokeObjectURL(url);
      setImgEl(null);
      setImageLoaded(false);
      setActions([]);
      setCurrentStroke([]);
      setPendingText("");
      setPendingTextCanvasPos(null);
      setPendingTextCssPos(null);
    };
  }, [open, file]);

  // Reset viewport transform when opening/changing file
  useEffect(() => {
    if (!open) return;
    setViewportScale(1);
    setViewportOffset({ x: 0, y: 0 });
  }, [open, file]);

  // Resize overlay canvas to image natural size
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !imgEl) return;
    canvas.width = imgEl.naturalWidth || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    redraw();

  }, [imgEl]);

  // Prevent page scroll while modal is open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Redraw whenever actions change
  useEffect(() => {
    redraw();

  }, [actions]);

  function redraw() {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // reapply actions
    for (const a of actions) {
      if (a.type === "stroke") {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.size;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = 0; i < a.points.length; i++) {
          const p = a.points[i];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      } else if (a.type === "text") {
        ctx.fillStyle = a.color;
        ctx.font = `${a.size}px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
        ctx.textBaseline = "top";
        wrapText(
          ctx,
          a.text,
          a.x,
          a.y,
          Math.max(200, canvas.width * 0.5),
          a.size + 6
        );
      }
    }
  }

  function wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number
  ) {
    const words = text.split(/\s+/);
    let line = "";
    let cursorY = y;
    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + " ";
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        ctx.fillText(line, x, cursorY);
        line = words[n] + " ";
        cursorY += lineHeight;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, x, cursorY);
  }

  function measureTextBlock(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    lineHeight: number
  ): { width: number; height: number; lines: string[] } {
    const words = text.split(/\s+/);
    let line = "";
    const lines: string[] = [];
    let maxLineWidth = 0;
    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + " ";
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        lines.push(line.trimEnd());
        maxLineWidth = Math.max(maxLineWidth, ctx.measureText(line).width);
        line = words[n] + " ";
      } else {
        line = testLine;
      }
    }
    lines.push(line.trimEnd());
    maxLineWidth = Math.max(
      maxLineWidth,
      ...lines.map((ln) => ctx.measureText(ln).width)
    );
    const height = lines.length * lineHeight;
    return { width: maxLineWidth, height, lines };
  }

  function toCanvasCoords(e: React.PointerEvent<HTMLCanvasElement>): {
    x: number;
    y: number;
  } {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y };
  }

  function toCssCoords(e: React.PointerEvent<HTMLCanvasElement>): {
    x: number;
    y: number;
  } {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y };
  }

  function addPointer(e: React.PointerEvent<HTMLCanvasElement>) {
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function updatePointer(e: React.PointerEvent<HTMLCanvasElement>) {
    if (activePointers.current.has(e.pointerId)) {
      activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  }

  function removePointer(e: React.PointerEvent<HTMLCanvasElement>) {
    activePointers.current.delete(e.pointerId);
  }

  function getTwoPointers() {
    const vals = Array.from(activePointers.current.values());
    return vals.length >= 2 ? vals.slice(0, 2) : null;
  }

  function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function getCenter(a: { x: number; y: number }, b: { x: number; y: number }) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function clampPan(scale: number, off: { x: number; y: number }) {
    const cont = containerRef.current;
    const stage = stageRef.current;
    if (!cont || !stage) return off;
    const contRect = cont.getBoundingClientRect();
    const baseW = stage.offsetWidth || 1;
    const baseH = stage.offsetHeight || 1;
    const scaledW = baseW * scale;
    const scaledH = baseH * scale;
    const minX = Math.min(0, contRect.width - scaledW);
    const minY = Math.min(0, contRect.height - scaledH);
    const maxX = 0;
    const maxY = 0;
    return {
      x: Math.max(minX, Math.min(off.x, maxX)),
      y: Math.max(minY, Math.min(off.y, maxY)),
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    if (!overlayRef.current || !imgEl) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    addPointer(e);

    // If two fingers, start pinch gesture
    const two = getTwoPointers();
    if (two) {
      pinchStartScale.current = viewportScale;
      pinchStartOffset.current = { ...viewportOffset };
      pinchStartDist.current = dist(two[0], two[1]);
      setIsDrawing(false);
      setDragTextIndex(null);
      return;
    }

    const ptCanvas = toCanvasCoords(e);
    const ptCss = toCssCoords(e);
    const canvas = overlayRef.current!;
    const ctx = canvas.getContext("2d");
    // Hit-test existing texts first (top-most)
    if (ctx) {
      for (let i = actions.length - 1; i >= 0; i--) {
        const a = actions[i];
        if (a.type !== "text") continue;
        ctx.font = `${a.size}px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
        const maxWidth = Math.max(200, canvas.width * 0.5);
        const lineHeight = a.size + 6;
        const m = measureTextBlock(ctx, a.text, maxWidth, lineHeight);
        const rect = {
          x: a.x,
          y: a.y,
          w: Math.ceil(m.width),
          h: Math.ceil(m.height),
        };
        if (
          ptCanvas.x >= rect.x &&
          ptCanvas.x <= rect.x + rect.w &&
          ptCanvas.y >= rect.y &&
          ptCanvas.y <= rect.y + rect.h
        ) {
          if (mode === "text") {
            // Begin drag-to-move
            setDragTextIndex(i);
            dragStart.current = ptCanvas;
            dragTextStartPos.current = { x: a.x, y: a.y };
            // Also set editor defaults for a quick tap (on pointerup without move we open editor)
            setEditTextIndex(i);
            setEditTextColor(a.color);
            setEditTextSize(a.size);
            dragMoved.current = false;
          }
          return; // stop here when hitting text
        }
      }
    }
    // If not clicking on existing text
    if (mode === "draw") {
      setIsDrawing(true);
      setCurrentStroke([ptCanvas]);
      return;
    }
    // In text mode, require a double-tap to open input for adding new text
    if (mode === "text") {
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const last = lastTapRef.current;
      const dpx = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) : Infinity;
      if (last && now - last.t < 350 && dpx < 24) {
        // Double tap detected: open input near tap, clamped within stage box
        let cssX = ptCss.x + 8;
        let cssY = ptCss.y + 8;
        const approxW = 280;
        const approxH = 90;
        if (stageBox.width > 0 && stageBox.height > 0) {
          cssX = Math.max(8, Math.min(cssX, stageBox.width - approxW - 8));
          cssY = Math.max(8, Math.min(cssY, stageBox.height - approxH - 8));
        }
        setPendingTextCanvasPos(ptCanvas);
        setPendingTextCssPos({ x: cssX, y: cssY });
        setPendingText("");
        lastTapRef.current = null;
        setTimeout(() => inputRef.current?.focus(), 0);
      } else {
        lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    updatePointer(e);

    // Handle pinch zoom/pan
    const two = getTwoPointers();
    if (two) {
      e.preventDefault();
      const curDist = dist(two[0], two[1]);
      const center = getCenter(two[0], two[1]);
      const k =
        Math.min(
          MAX_SCALE,
          Math.max(
            MIN_SCALE,
            (pinchStartScale.current * curDist) /
              Math.max(1, pinchStartDist.current)
          )
        ) / Math.max(0.0001, pinchStartScale.current);
      const newScale = Math.min(
        MAX_SCALE,
        Math.max(
          MIN_SCALE,
          pinchStartScale.current *
            (curDist / Math.max(1, pinchStartDist.current))
        )
      );
      // T_new = (1 - k) * C + k * T0
      let newOff = {
        x: (1 - k) * center.x + k * pinchStartOffset.current.x,
        y: (1 - k) * center.y + k * pinchStartOffset.current.y,
      };
      newOff = clampPan(newScale, newOff);
      setViewportScale(newScale);
      setViewportOffset(newOff);
      setIsDrawing(false);
      setDragTextIndex(null);
      return;
    }

    // Dragging text (only in text mode)
    if (dragTextIndex != null && mode === "text") {
      e.preventDefault();
      const pt = toCanvasCoords(e);
      const start = dragStart.current;
      const tstart = dragTextStartPos.current;
      if (start && tstart) {
        const dx = pt.x - start.x;
        const dy = pt.y - start.y;
        setActions((prev) =>
          prev.map((a, i) =>
            i === dragTextIndex && a.type === "text"
              ? { ...a, x: tstart.x + dx, y: tstart.y + dy }
              : a
          )
        );
        if (!dragMoved.current && Math.hypot(dx, dy) > 3)
          dragMoved.current = true;
      }
      return;
    }

    if (!isDrawing || mode !== "draw") return;
    e.preventDefault();
    const pt = toCanvasCoords(e);
    setCurrentStroke((prev) => [...prev, pt]);
    // draw incrementally for responsiveness
    const canvas = overlayRef.current!;
    const ctx = canvas.getContext("2d")!;
    const seg = currentStroke.concat([pt]);
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = Math.max(0, seg.length - 3); i < seg.length; i++) {
      const p = seg[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    // pointer registry
    removePointer(e);

    // If ending a drag without significant movement, open editor for that text at its position
    if (dragTextIndex != null && mode === "text") {
      const i = dragTextIndex;
      setDragTextIndex(null);
      const canvas = overlayRef.current!;
      const a = actions[i] as any;
      if (a && a.type === "text") {
        if (dragMoved.current) {
          dragMoved.current = false;
          return; // do not open editor after a drag
        }
        const cRect = canvas.getBoundingClientRect();
        const scaleX = cRect.width / canvas.width;
        const scaleY = cRect.height / canvas.height;
        let cssLeft = a.x * scaleX;
        let cssTop = Math.max(0, (a.y - 32) * scaleY);
        const approxW = 280;
        const approxH = 90;
        if (stageBox.width > 0 && stageBox.height > 0) {
          cssLeft = Math.max(8, Math.min(cssLeft, stageBox.width - approxW - 8));
          cssTop = Math.max(8, Math.min(cssTop, stageBox.height - approxH - 8));
        }
        setEditTextIndex(i);
        setEditTextColor(a.color);
        setEditTextSize(a.size);
        setTextEditorCssPos({ x: cssLeft, y: cssTop });
      }
    }

    if (mode === "draw" && isDrawing && currentStroke.length > 0) {
      // Compute total path length to ignore micro-strokes / accidental taps
      let pathLen = 0;
      for (let i = 1; i < currentStroke.length; i++) {
        const a = currentStroke[i - 1];
        const b = currentStroke[i];
        pathLen += Math.hypot(b.x - a.x, b.y - a.y);
      }
      if (pathLen >= 12) {
        setActions((prev) => [
          ...prev,
          { type: "stroke", color, size, points: currentStroke },
        ]);
      }
      setIsDrawing(false);
      setCurrentStroke([]);
      // Auto-exit draw mode, user can tap Draw again to continue drawing
      setMode("text");
    }
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    removePointer(e);
    setIsDrawing(false);
    setCurrentStroke([]);
    setDragTextIndex(null);
    dragMoved.current = false;
  }

  function undo() {
    setActions((prev) => prev.slice(0, -1));
  }

  function clearAll() {
    setActions([]);
    setCurrentStroke([]);
  }

  function commitText() {
    if (!pendingTextCanvasPos) return;
    const txt = (pendingText || "").trim();
    if (!txt) {
      setPendingText("");
      setPendingTextCanvasPos(null);
      setPendingTextCssPos(null);
      return;
    }
    setActions((prev) => [
      ...prev,
      {
        type: "text",
        color,
        size: TEXT_ADD_DEFAULT_SIZE,
        text: txt,
        x: pendingTextCanvasPos.x,
        y: pendingTextCanvasPos.y,
      },
    ]);
    setPendingText("");
    setPendingTextCanvasPos(null);
    setPendingTextCssPos(null);
  }

  async function saveAnnotated() {
    if (!imgEl) return;
    // Compose final image at natural size
    const out = document.createElement("canvas");
    out.width = imgEl.naturalWidth || imgEl.width;
    out.height = imgEl.naturalHeight || imgEl.height;
    const ctx = out.getContext("2d")!;
    // base image
    ctx.drawImage(imgEl, 0, 0, out.width, out.height);
    // overlay: redraw actions deterministically
    for (const a of actions) {
      if (a.type === "stroke") {
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.size;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        for (let i = 0; i < a.points.length; i++) {
          const p = a.points[i];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      } else if (a.type === "text") {
        ctx.fillStyle = a.color;
        ctx.font = `${a.size}px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
        ctx.textBaseline = "top";
        wrapText(
          ctx,
          a.text,
          a.x,
          a.y,
          Math.max(200, out.width * 0.5),
          a.size + 6
        );
      }
    }
    const blob: Blob | null = await new Promise((resolve) =>
      out.toBlob((b) => resolve(b), "image/jpeg", 0.92)
    );
    if (!blob) return;
    const annotated = new File(
      [blob],
      `${
        file?.name?.replace(/\.(jpg|jpeg|png)$/i, "") || "salvage"
      }-annotated.jpg`,
      { type: "image/jpeg" }
    );
    onSave(annotated);
  }

  if (!open || !file) return null;

  // compute display sizing: fit within viewport (mobile friendly)
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 ">
      <div className="relative w-full max-w-6xl h-[96dvh] sm:h-[90vh] mx-0 sm:mx-2 rounded-none sm:rounded-lg bg-[var(--app-panel)] shadow-sm ring-1  flex flex-col">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-2 sm:px-3 py-2 border-b border-[var(--app-border)]">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ring-1 ${
                mode === "draw"
                  ? "bg-blue-600 text-white ring-blue-600"
                  : "bg-[var(--app-panel)] text-[var(--app-text-muted)] ring-gray-200"
              }`}
              onClick={() => setMode("draw")}
              title="Draw"
            >
              <Pencil className="h-4 w-4" /> Draw
            </button>
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ring-1 ${
                mode === "text"
                  ? "bg-blue-600 text-white ring-blue-600"
                  : "bg-[var(--app-panel)] text-[var(--app-text-muted)] ring-gray-200"
              }`}
              onClick={() => setMode("text")}
              title="Add Text"
            >
              <Type className="h-4 w-4" /> Text
            </button>
            <div className="flex items-center gap-2 ml-2">
              <Palette className="h-4 w-4 text-[var(--app-text-muted)]" />
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-6 w-8 cursor-pointer"
              />
              <input
                type="range"
                min={1}
                max={24}
                step={1}
                value={size}
                onChange={(e) => setSize(parseInt(e.target.value))}
                className="w-28"
              />
              <span className="text-xs text-[var(--app-text-muted)] w-8">{size}px</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={undo}
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1 rounded-md bg-[var(--app-panel)] px-2 py-1 text-xs font-medium text-[var(--app-text-muted)] ring-1 ring-gray-200 hover:bg-[var(--app-panel-alt)]"
              title="Undo"
            >
              <Undo2 className="h-4 w-4" /> Undo
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--app-panel)] px-2 py-1 text-xs font-medium text-[var(--app-text-muted)] ring-1 ring-gray-200 hover:bg-[var(--app-panel-alt)]"
              title="Clear"
            >
              <Eraser className="h-4 w-4" /> Clear
            </button>
            <button
              type="button"
              onClick={saveAnnotated}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white ring-1 ring-blue-600 hover:bg-blue-500"
              title="Save"
            >
              <Save className="h-4 w-4" /> Save
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--app-panel)] px-2 py-1 text-xs font-medium text-[var(--app-text-muted)] ring-1 ring-gray-200 hover:bg-[var(--app-panel-alt)]"
              title="Close"
            >
              <X className="h-4 w-4" /> Close
            </button>
          </div>
        </div>

        {/* Canvas area */}
        <div
          ref={containerRef}
          className={`relative flex-1 bg-gray-900/5 ${
            isDrawing ? "overflow-hidden" : "overflow-auto"
          } p-2 select-none`}
          onWheel={(e) => {
            if (isDrawing) e.preventDefault();
          }}
        >
          <div
            ref={stageRef}
            className="relative mx-auto"
            style={{
              maxWidth: "100%",
              width: "fit-content",
              transformOrigin: "0 0",
              transform: `translate(${viewportOffset.x}px, ${viewportOffset.y}px) scale(${viewportScale})`,
            }}
          >
            {/* Base image */}
            { }
            {imgEl && (
              <img
                src={imgEl.src}
                alt={file?.name || "image"}
                className="block max-h-[70dvh] sm:max-h-[72vh] w-auto h-auto max-w-full select-none"
                draggable={false}
              />
            )}
            {/* Overlay canvas; sized to image's natural dimensions; scaled by CSS with the img */}
            <canvas
              ref={overlayRef}
              className="absolute inset-0 w-full h-full [image-rendering:pixelated] cursor-crosshair touch-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onPointerLeave={(e) => {
                if (isDrawing) handlePointerCancel(e);
              }}
              onLostPointerCapture={(e) => {
                if (isDrawing) handlePointerCancel(e as any);
              }}
              onContextMenu={(e) => e.preventDefault()}
              style={{ touchAction: "none" }}
            />

            {/* Non-transformed overlay layer aligned to the stage */}
            <div className="pointer-events-none absolute inset-0 z-30">
              <div
                className="relative"
                style={{
                  position: "absolute",
                  left: stageBox.left,
                  top: stageBox.top,
                  width: stageBox.width,
                  height: stageBox.height,
                }}
              >
                {/* Anchored text input overlay with Add/Cancel */}
                {pendingTextCssPos && (
                  <div
                    className="absolute pointer-events-auto"
                    style={{
                      left: pendingTextCssPos.x,
                      top: pendingTextCssPos.y,
                    }}
                  >
                    <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow-sm ring-1  w-[240px] sm:w-[280px]">
                      <input
                        ref={inputRef}
                        value={pendingText}
                        onChange={(e) => setPendingText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitText();
                          if (e.key === "Escape") {
                            setPendingText("");
                            setPendingTextCanvasPos(null);
                            setPendingTextCssPos(null);
                          }
                        }}
                        placeholder="Type here..."
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-xs sm:text-sm shadow focus:outline-none focus:ring-2 focus:ring-blue-300"
                      />
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          className="rounded-md bg-[var(--app-panel-alt)] px-2 py-1 text-[11px] sm:text-xs text-[var(--app-text-muted)] hover:bg-gray-200"
                          onClick={() => {
                            setPendingText("");
                            setPendingTextCanvasPos(null);
                            setPendingTextCssPos(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="rounded-md bg-blue-600 px-2 py-1 text-[11px] sm:text-xs font-semibold text-white hover:bg-blue-500"
                          onClick={commitText}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Per-text toolbar (eraser + X delete) anchored near each text */}
                {overlayRef.current &&
                  actions
                    .map((a, i) => ({ a, i }))
                    .filter(({ a }) => a.type === "text")
                    .map(({ a, i }) => {
                      const canvas = overlayRef.current!;
                      const rect = canvas.getBoundingClientRect();
                      const scaleX = rect.width / canvas.width;
                      const scaleY = rect.height / canvas.height;
                      const cssLeft = (a as any).x * scaleX;
                      const cssTop = (a as any).y * scaleY;
                      return (
                        <div
                          key={`txtctl-${i}`}
                          className="absolute pointer-events-auto"
                          style={{
                            left: cssLeft,
                            top: Math.max(0, cssTop - 28),
                          }}
                        >
                          <div className="inline-flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-1 text-white shadow-sm">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActions((prev) =>
                                  prev.filter((_, idx) => idx !== i)
                                );
                              }}
                              className="inline-flex items-center justify-center h-6 w-6 rounded-full hover:bg-black/60"
                              title="Erase text"
                            >
                              <Eraser className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                // X deletes the text as requested
                                setActions((prev) =>
                                  prev.filter((_, idx) => idx !== i)
                                );
                              }}
                              className="inline-flex items-center justify-center h-6 w-6 rounded-full hover:bg-black/60"
                              title="Delete text"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                {/* Text editor panel for changing color/size of selected text */}
                {textEditorCssPos != null &&
                  editTextIndex != null &&
                  actions[editTextIndex] &&
                  (actions[editTextIndex] as any).type === "text" && (
                    <div
                      className="absolute pointer-events-auto"
                      style={{
                        left: textEditorCssPos.x,
                        top: textEditorCssPos.y,
                      }}
                    >
                      <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow-sm ring-1  w-[240px] sm:w-[280px]">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-[var(--app-text-muted)]">Color</label>
                          <input
                            type="color"
                            value={editTextColor}
                            onChange={(e) => setEditTextColor(e.target.value)}
                            className="h-6 w-8"
                          />
                          <label className="ml-2 text-xs text-[var(--app-text-muted)]">
                            Size
                          </label>
                          <input
                            type="range"
                            min={12}
                            max={72}
                            step={1}
                            value={editTextSize}
                            onChange={(e) =>
                              setEditTextSize(parseInt(e.target.value))
                            }
                            className="flex-1"
                          />
                          <div className="w-10 text-right text-xs text-[var(--app-text-muted)]">
                            {editTextSize}px
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="rounded-md bg-[var(--app-panel-alt)] px-2 py-1 text-[11px] sm:text-xs text-[var(--app-text-muted)] hover:bg-gray-200"
                            onClick={() => {
                              setEditTextIndex(null);
                              setTextEditorCssPos(null);
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="rounded-md bg-blue-600 px-2 py-1 text-[11px] sm:text-xs font-semibold text-white hover:bg-blue-500"
                            onClick={() => {
                              setActions((prev) =>
                                prev.map((a, i) =>
                                  i === editTextIndex && a.type === "text"
                                    ? {
                                        ...a,
                                        color: editTextColor,
                                        size: editTextSize,
                                      }
                                    : a
                                )
                              );
                              setEditTextIndex(null);
                              setTextEditorCssPos(null);
                            }}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="rounded-md bg-black text-white px-2 py-1 text-[11px] sm:text-xs hover:bg-black/90"
                            onClick={() => {
                              const idx = editTextIndex!;
                              setActions((prev) =>
                                prev.filter((_, i) => i !== idx)
                              );
                              setEditTextIndex(null);
                              setTextEditorCssPos(null);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                {/* Per-text toolbar (eraser + X delete) anchored near each text */}
                {overlayRef.current &&
                  actions
                    .map((a, i) => ({ a, i }))
                    .filter(({ a }) => a.type === "text")
                    .map(({ a, i }) => {
                      const canvas = overlayRef.current!;
                      const rect = canvas.getBoundingClientRect();
                      const scaleX = rect.width / canvas.width;
                      const scaleY = rect.height / canvas.height;
                      const cssLeft = (a as any).x * scaleX;
                      const cssTop = (a as any).y * scaleY;
                      return (
                        <div
                          key={`txtctl-${i}`}
                          className="absolute pointer-events-auto"
                          style={{
                            left: cssLeft,
                            top: Math.max(0, cssTop - 28),
                          }}
                        >
                          <div className="inline-flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-1 text-white shadow-sm">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActions((prev) =>
                                  prev.filter((_, idx) => idx !== i)
                                );
                              }}
                              className="inline-flex items-center justify-center h-6 w-6 rounded-full hover:bg-black/60"
                              title="Erase text"
                            >
                              <Eraser className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                // X deletes the text as requested
                                setActions((prev) =>
                                  prev.filter((_, idx) => idx !== i)
                                );
                              }}
                              className="inline-flex items-center justify-center h-6 w-6 rounded-full hover:bg-black/60"
                              title="Delete text"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                {/* Text editor panel for changing color/size of selected text */}
                {textEditorCssPos != null &&
                  editTextIndex != null &&
                  actions[editTextIndex] &&
                  (actions[editTextIndex] as any).type === "text" && (
                    <div
                      className="absolute pointer-events-auto"
                      style={{
                        left: textEditorCssPos.x,
                        top: textEditorCssPos.y,
                      }}
                    >
                      <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow-sm ring-1  w-[240px] sm:w-[280px]">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-[var(--app-text-muted)]">Color</label>
                          <input
                            type="color"
                            value={editTextColor}
                            onChange={(e) => setEditTextColor(e.target.value)}
                            className="h-6 w-8"
                          />
                          <label className="ml-2 text-xs text-[var(--app-text-muted)]">
                            Size
                          </label>
                          <input
                            type="range"
                            min={12}
                            max={72}
                            step={1}
                            value={editTextSize}
                            onChange={(e) =>
                              setEditTextSize(parseInt(e.target.value))
                            }
                            className="flex-1"
                          />
                          <div className="w-10 text-right text-xs text-[var(--app-text-muted)]">
                            {editTextSize}px
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="rounded-md bg-[var(--app-panel-alt)] px-2 py-1 text-[11px] sm:text-xs text-[var(--app-text-muted)] hover:bg-gray-200"
                            onClick={() => {
                              setEditTextIndex(null);
                              setTextEditorCssPos(null);
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="rounded-md bg-blue-600 px-2 py-1 text-[11px] sm:text-xs font-semibold text-white hover:bg-blue-500"
                            onClick={() => {
                              setActions((prev) =>
                                prev.map((a, i) =>
                                  i === editTextIndex && a.type === "text"
                                    ? {
                                        ...a,
                                        color: editTextColor,
                                        size: editTextSize,
                                      }
                                    : a
                                )
                              );
                              setEditTextIndex(null);
                              setTextEditorCssPos(null);
                            }}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="rounded-md bg-black text-white px-2 py-1 text-[11px] sm:text-xs hover:bg-black/90"
                            onClick={() => {
                              const idx = editTextIndex!;
                              setActions((prev) =>
                                prev.filter((_, i) => i !== idx)
                              );
                              setEditTextIndex(null);
                              setTextEditorCssPos(null);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
