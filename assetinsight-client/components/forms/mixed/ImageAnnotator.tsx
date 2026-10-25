"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/legacy";

export type AnnBox = {
  id: string;
  x: number; // 0..1
  y: number; // 0..1
  w: number; // 0..1
  h: number; // 0..1
};

type Props = {
  imageUrl: string;
  initialBoxes?: AnnBox[];
  onSave: (boxes: AnnBox[]) => void;
  onCancel: () => void;
};

// Utility helpers
function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

export default function ImageAnnotator({
  imageUrl,
  initialBoxes,
  onSave,
  onCancel,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [boxes, setBoxes] = useState<AnnBox[]>(() => initialBoxes || []);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [creating, setCreating] = useState<{
    startX: number;
    startY: number;
    id: string;
  } | null>(null);

  const [dragging, setDragging] = useState<{
    id: string;
    offX: number; // normalized offset from pointer to box.x
    offY: number;
  } | null>(null);

  const [resizing, setResizing] = useState<{
    id: string;
    corner: "tl" | "tr" | "bl" | "br";
  } | null>(null);

  // Start-create gesture pending until user drags beyond a small threshold
  const [pendingCreate, setPendingCreate] = useState<{
    startX: number;
    startY: number;
    id: string;
  } | null>(null);

  // get pointer position normalized inside image area
  const getNormPos = (clientX: number, clientY: number) => {
    const el = wrapperRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const x = clamp((clientX - rect.left) / rect.width);
    const y = clamp((clientY - rect.top) / rect.height);
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Only consider creating if clicked on empty canvas (not on box or handle)
    const target = e.target as HTMLElement;
    if (target.dataset.handle || target.dataset.box) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const { x, y } = getNormPos(e.clientX, e.clientY);
    // Generate an id not already present in current boxes
    let id = makeId();
    while (boxes.some((b) => b.id === id)) id = makeId();
    // Do not create immediately — wait for a small drag threshold in onPointerMove
    setPendingCreate({ startX: x, startY: y, id });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // If user initiated a blank-area press, start creation only after a small drag
    if (pendingCreate && !creating && !dragging && !resizing) {
      const { x, y } = getNormPos(e.clientX, e.clientY);
      const dx = Math.abs(x - pendingCreate.startX);
      const dy = Math.abs(y - pendingCreate.startY);
      const threshold = 0.01; // ~1% of min(image dimension) ≈ a few pixels on mobile
      if (dx > threshold || dy > threshold) {
        const id = pendingCreate.id;
        setCreating({ startX: pendingCreate.startX, startY: pendingCreate.startY, id });
        setActiveId(id);
        setBoxes((prev) => {
          const idx = prev.findIndex((b) => b.id === id);
          const nextBox = {
            id,
            x: Math.min(pendingCreate.startX, x),
            y: Math.min(pendingCreate.startY, y),
            w: Math.abs(x - pendingCreate.startX),
            h: Math.abs(y - pendingCreate.startY),
          } as AnnBox;
          if (idx >= 0) {
            const out = [...prev];
            out[idx] = { ...out[idx], ...nextBox };
            return out;
          }
          return [...prev, nextBox];
        });
        // Clear pending so we don't create multiple boxes with the same id if move fires again before state commits
        setPendingCreate(null);
      }
    }
    if (creating) {
      const { x, y } = getNormPos(e.clientX, e.clientY);
      setBoxes((prev) => {
        const out = [...prev];
        const idx = out.findIndex((b) => b.id === creating.id);
        if (idx >= 0) {
          const sx = creating.startX;
          const sy = creating.startY;
          const nx = Math.min(sx, x);
          const ny = Math.min(sy, y);
          const nw = Math.abs(x - sx);
          const nh = Math.abs(y - sy);
          out[idx] = { ...out[idx], x: nx, y: ny, w: nw, h: nh };
        }
        return out;
      });
      return;
    }
    if (dragging) {
      const { x, y } = getNormPos(e.clientX, e.clientY);
      setBoxes((prev) => {
        const out = [...prev];
        const idx = out.findIndex((b) => b.id === dragging.id);
        if (idx >= 0) {
          const bw = out[idx].w;
          const bh = out[idx].h;
          let nx = clamp(x - dragging.offX);
          let ny = clamp(y - dragging.offY);
          if (nx + bw > 1) nx = 1 - bw;
          if (ny + bh > 1) ny = 1 - bh;
          out[idx] = { ...out[idx], x: nx, y: ny };
        }
        return out;
      });
      return;
    }
    if (resizing) {
      const { x, y } = getNormPos(e.clientX, e.clientY);
      setBoxes((prev) => {
        const out = [...prev];
        const idx = out.findIndex((b) => b.id === resizing.id);
        if (idx >= 0) {
          const b = out[idx];
          let left = b.x;
          let top = b.y;
          let right = b.x + b.w;
          let bottom = b.y + b.h;
          if (resizing.corner === "tl") {
            left = clamp(Math.min(x, right - 0.01));
            top = clamp(Math.min(y, bottom - 0.01));
          } else if (resizing.corner === "tr") {
            right = clamp(Math.max(x, left + 0.01));
            top = clamp(Math.min(y, bottom - 0.01));
          } else if (resizing.corner === "bl") {
            left = clamp(Math.min(x, right - 0.01));
            bottom = clamp(Math.max(y, top + 0.01));
          } else if (resizing.corner === "br") {
            right = clamp(Math.max(x, left + 0.01));
            bottom = clamp(Math.max(y, top + 0.01));
          }
          const nx = Math.min(left, right);
          const ny = Math.min(top, bottom);
          const nw = Math.max(0, Math.abs(right - left));
          const nh = Math.max(0, Math.abs(bottom - top));
          out[idx] = { ...b, x: nx, y: ny, w: nw, h: nh };
        }
        return out;
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (creating) {
      setCreating(null);
      setBoxes((prev) =>
        prev.filter((b) => b.id !== creating.id || (b.w > 0.01 && b.h > 0.01))
      );
      return;
    }
    // If user tapped without dragging enough to start creating, just clear pending
    if (pendingCreate) {
      setPendingCreate(null);
    }
    if (dragging) setDragging(null);
    if (resizing) setResizing(null);
  };

  const startDragBox = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    // If a pending create was in progress, cancel it; user intends to drag existing box
    if (pendingCreate) setPendingCreate(null);
    const { x, y } = getNormPos(e.clientX, e.clientY);
    const b = boxes.find((bb) => bb.id === id);
    if (!b) return;
    setActiveId(id);
    setDragging({ id, offX: x - b.x, offY: y - b.y });
  };

  const startResize = (
    e: React.PointerEvent,
    id: string,
    corner: "tl" | "tr" | "bl" | "br"
  ) => {
    e.stopPropagation();
    // Cancel any pending create; user intends to resize existing box
    if (pendingCreate) setPendingCreate(null);
    setActiveId(id);
    setResizing({ id, corner });
  };

  const deleteActive = () => {
    if (!activeId) return;
    setBoxes((prev) => prev.filter((b) => b.id !== activeId));
    setActiveId(null);
  };

  useEffect(() => {
    // prevent wheel zoom/scroll inside modal from bubbling (optional)
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => ev.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel as any);
  }, []);

  // Safety: deduplicate boxes by id to prevent React duplicate key warnings
  useEffect(() => {
    if (!boxes || boxes.length < 2) return;
    const seen = new Set<string>();
    let hasDup = false;
    for (const b of boxes) {
      if (seen.has(b.id)) {
        hasDup = true;
        break;
      }
      seen.add(b.id);
    }
    if (!hasDup) return;
    const uniq = Array.from(
      boxes.reduce((m, b) => m.set(b.id, b), new Map<string, AnnBox>()).values()
    );
    if (uniq.length !== boxes.length) setBoxes(uniq);
  }, [boxes]);

  // Disable background scroll and gestures while annotating (mobile-friendly)
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevHtmlTouch = (html.style as any).touchAction;
    const prevBodyTouch = (body.style as any).touchAction;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    (html.style as any).touchAction = "none";
    (body.style as any).touchAction = "none";
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      (html.style as any).touchAction = prevHtmlTouch || "";
      (body.style as any).touchAction = prevBodyTouch || "";
    };
  }, []);

  return (
    <Dialog
      open
      fullScreen
      onClose={(_event, reason) => {
        if (reason === "escapeKeyDown") onCancel();
      }}
      aria-labelledby="focus-editor-title"
      slotProps={{
        paper: {
          sx: {
            m: 0,
            bgcolor: "#111827",
            overflow: "hidden",
          },
        },
      }}
    >
      <div className="relative w-screen h-[100dvh] overflow-hidden bg-gray-900/80 flex flex-col pb-[env(safe-area-inset-bottom)]">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-white/10 text-white">
          <div id="focus-editor-title" className="text-sm font-semibold">Focus / Crop Area</div>
          <div className="flex items-center gap-2">
            {activeId && (
              <button
                type="button"
                onClick={deleteActive}
                className="inline-flex items-center rounded bg-[var(--app-panel)] px-2 py-1 text-xs hover:bg-[var(--app-panel)]"
                title="Delete selected focus area"
              >
                Delete Area
              </button>
            )}
            <button
              type="button"
              onClick={() => onSave(boxes)}
              className="inline-flex items-center rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center rounded bg-[var(--app-panel)] px-3 py-1.5 text-xs text-white hover:bg-[var(--app-panel)]"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <div
            ref={wrapperRef}
            className="relative block w-full h-full select-none touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img ref={imgRef} src={imageUrl} alt="Focus area editor" className="w-full h-full object-contain block" />
            {/* Overlay layer */}
            <div className="absolute inset-0">
              {boxes.map((b) => (
                <div
                  key={b.id}
                  data-box
                  className={`absolute ${activeId === b.id ? "ring-2 ring-blue-400" : ""} cursor-move`}
                  style={{
                    left: `${b.x * 100}%`,
                    top: `${b.y * 100}%`,
                    width: `${b.w * 100}%`,
                    height: `${b.h * 100}%`,
                    border: "2px solid rgba(37,99,235,0.95)",
                    boxShadow: activeId === b.id ? "0 0 0 2px rgba(37,99,235,0.42) inset" : undefined,
                  }}
                  onPointerDown={(e) => {
                    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    startDragBox(e as any, b.id);
                  }}
                >
                  {/* handles */}
                  {(["tl", "tr", "bl", "br"] as const).map((corner) => (
                    <div
                      key={corner}
                      data-handle
                      onPointerDown={(e) => {
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                        startResize(e as any, b.id, corner);
                      }}
                      className="pointer-events-auto absolute h-4 w-4 bg-blue-600 border border-white rounded-sm"
                      style={{
                        left: corner.includes("l") ? -8 : undefined,
                        right: corner.includes("r") ? -8 : undefined,
                        top: corner.includes("t") ? -8 : undefined,
                        bottom: corner.includes("b") ? -8 : undefined,
                        cursor:
                          corner === "tl"
                            ? "nwse-resize"
                            : corner === "tr"
                            ? "nesw-resize"
                            : corner === "bl"
                            ? "nesw-resize"
                            : "nwse-resize",
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex-shrink-0 px-3 py-2 text-[11px] text-white/70 pb-[max(0px,env(safe-area-inset-bottom))]">
          Tip: Click and drag on the image to add a box. Drag a box to move. Use corner handles to resize. Select a box by clicking it; then use Delete Box.
        </div>
      </div>
    </Dialog>
  );
}
