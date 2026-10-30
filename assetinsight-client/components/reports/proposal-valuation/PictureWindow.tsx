"use client";

import { ChevronLeft, ChevronRight, ExternalLink, GripHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

/**
 * One lot's pictures in a floating window over the valuation grid (owner,
 * 2026-10-30: "Can the image viewer be a floating window with next and
 * previous control", "Show preview on the right side", "the floating window
 * is dragable").
 *
 * - Opens on the right the first time, then where it was last dragged to
 *   (remembered in this browser), always kept on screen.
 * - Dragged by its title bar; resized from its bottom-right corner.
 * - Not a modal: the grid stays usable, and another row's "N pictures" link
 *   swaps its lot in place. Its keys (Left, Right, Esc) act only while focus
 *   is inside it, so the grid keeps its own arrow keys and Esc.
 *
 * Phones keep the full-screen viewer; a floating window would cover the cards.
 */

type Position = { x: number; y: number };

const POSITION_KEY = "pv-picture-window-position";
const EDGE = 8; // Gap kept between the window and the edge of the screen.
const DEFAULT_TOP = 140; // Level with the top of the grid.

function readSavedPosition(): Position | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(POSITION_KEY) || "null");
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : null;
  } catch {
    return null;
  }
}

function savePosition(position: Position) {
  try {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  } catch {
    // Private windows and blocked storage: the window simply opens on the right next time.
  }
}

/** The position moved, if needed, so the whole window stays on screen. */
function onScreen(position: Position, panel: HTMLElement | null): Position {
  const width = panel?.offsetWidth ?? 0;
  const height = panel?.offsetHeight ?? 0;
  const maxX = Math.max(EDGE, window.innerWidth - width - EDGE);
  const maxY = Math.max(EDGE, window.innerHeight - height - EDGE);
  return {
    x: Math.round(Math.min(Math.max(position.x, EDGE), maxX)),
    y: Math.round(Math.min(Math.max(position.y, EDGE), maxY)),
  };
}

export default function PictureWindow({
  label,
  urls,
  index,
  panelRef,
  blocked = false,
  onMove,
  onSelect,
  onClose,
}: {
  label: string;
  urls: string[];
  index: number;
  panelRef: RefObject<HTMLElement | null>;
  /** True while a modal (formula details) is open over the page. */
  blocked?: boolean;
  onMove: (offset: number) => void;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const count = urls.length;
  const thumbsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPositionState] = useState<Position | null>(null);
  // The latest position, for saving when a drag ends.
  const positionRef = useRef<Position | null>(null);
  const setPosition = useCallback((next: Position) => {
    if (positionRef.current?.x === next.x && positionRef.current?.y === next.y) return;
    positionRef.current = next;
    setPositionState(next);
  }, []);

  // First placement, before paint: the last place it was dragged to, else the right-hand side.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const width = panel?.offsetWidth ?? 0;
    const start = readSavedPosition() ?? { x: window.innerWidth - width - 16, y: DEFAULT_TOP };
    setPosition(onScreen(start, panel));
  }, [panelRef, setPosition]);

  // Native corner resizing does not emit window.resize. Observe the panel too,
  // using its current measured size and position; left/top-only changes do not
  // resize the observed box, and setPosition ignores an unchanged result.
  useEffect(() => {
    let active = true;
    const keepOnScreen = () => {
      if (active && positionRef.current) setPosition(onScreen(positionRef.current, panelRef.current));
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepOnScreen);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener("resize", keepOnScreen);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", keepOnScreen);
    };
  }, [panelRef, setPosition]);

  // Keep the current picture's thumbnail in view as Previous / Next move on.
  useEffect(() => {
    const current = thumbsRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [index, urls]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, a")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    event.preventDefault();
    // Keeps the drag going when the pointer outruns the bar. Capture is only
    // a nicety; a pointer the browser no longer tracks must not stop the drag.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // The moves still arrive while the pointer stays over the bar.
    }
  }, [panelRef]);

  const drag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setPosition(onScreen({ x: event.clientX - active.offsetX, y: event.clientY - active.offsetY }, panelRef.current));
  }, [panelRef, setPosition]);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (positionRef.current) savePosition(positionRef.current);
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Already released.
    }
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (count > 1 && event.key === "ArrowLeft") {
      event.preventDefault();
      onMove(-1);
    } else if (count > 1 && event.key === "ArrowRight") {
      event.preventDefault();
      onMove(1);
    }
  };

  const roundButton =
    "absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-white/25 bg-black/60 text-white shadow-lg transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label={`Pictures for ${label}`}
      inert={blocked || undefined}
      style={position ? {
        left: position.x,
        top: position.y,
        // Limit native resizing from its existing anchor instead of moving that
        // anchor under the pointer. CSS viewport units also track a smaller
        // browser when clamping does not need to change left/top.
        maxWidth: `calc(100vw - ${position.x + EDGE}px)`,
        maxHeight: `calc(100dvh - ${position.y + EDGE}px)`,
      } : { right: 16, top: DEFAULT_TOP, visibility: "hidden" }}
      // `resize` gives the bottom-right corner its resize handle; the size
      // limits keep it usable and on screen.
      className="fixed z-[110] flex h-[min(620px,calc(100dvh-180px))] min-h-[min(16rem,calc(100dvh-16px))] w-[440px] min-w-72 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] resize flex-col overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-shadow-modal)] outline-none"
    >
      <header
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="Drag to move"
        className="flex shrink-0 cursor-move touch-none select-none items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-panel-alt)] px-3 py-2"
      >
        <GripHorizontal className="size-4 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold text-[var(--app-text-strong)]" title={label}>
            Pictures for {label}
          </h3>
          <p className="text-[11px] tabular-nums text-[var(--app-text-muted)]" aria-live="polite">
            {index + 1} of {count}
          </p>
        </div>
        <a
          href={urls[index]}
          target="_blank"
          rel="noreferrer"
          title="Open full size in a new tab"
          aria-label="Open this picture full size in a new tab"
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-[var(--app-text-muted)] hover:bg-[var(--app-panel)] hover:text-[var(--app-accent)]"
        >
          <ExternalLink className="size-4" />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close picture gallery"
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border border-[var(--app-border)] text-[var(--app-text)] hover:bg-[var(--app-panel)]"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={urls[index]}
          alt={`${label} picture ${index + 1}`}
          className="absolute inset-0 size-full object-contain"
        />
        {count > 1 ? (
          <>
            <button type="button" onClick={() => onMove(-1)} className={`${roundButton} left-2`} aria-label="Previous picture">
              <ChevronLeft className="size-6" />
            </button>
            <button type="button" onClick={() => onMove(1)} className={`${roundButton} right-2`} aria-label="Next picture">
              <ChevronRight className="size-6" />
            </button>
          </>
        ) : null}
      </div>

      {count > 1 ? (
        <div ref={thumbsRef} className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-[var(--app-border)] p-2 pr-5" aria-label="All pictures">
          {urls.map((url, thumb) => (
            <button
              key={`${thumb}-${url}`}
              type="button"
              onClick={() => onSelect(thumb)}
              aria-label={`Show picture ${thumb + 1}`}
              aria-current={thumb === index ? "true" : undefined}
              className={`size-12 shrink-0 overflow-hidden rounded border-2 ${
                thumb === index ? "border-[var(--app-accent)]" : "border-transparent opacity-70 hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" loading="lazy" className="size-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
