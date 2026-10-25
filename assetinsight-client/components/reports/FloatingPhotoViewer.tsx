"use client";

/**
 * Floating photo viewer for report previews (owner request 2026-10-11).
 *
 * Clicking a lot photo opens this window instead of a full-screen overlay, so
 * the employee can keep reading and editing the lot while looking at photos:
 *
 * - drag the title bar to move it (double-click the title bar to maximize);
 * - Minimize docks it as a small bar in the bottom-right corner, Restore
 *   brings it back where it was; Maximize fills the browser window; Close;
 * - drag the bottom-right corner to resize;
 * - Left / Right arrow keys step through the photos (Home / End jump to the
 *   first / last). Arrow keys typed into a text field are left alone, and
 *   Alt/Ctrl/Cmd + arrow (browser back/forward) is never captured;
 * - Escape closes it when focus is inside the viewer.
 *
 * Phones (narrow screens) always get the maximized layout; dragging and
 * resizing need a pointer and room to move.
 *
 * The window is not modal: the preview behind it stays usable. It renders into
 * document.body so no transformed or scrolling ancestor can clip it, above the
 * preview's own dialogs.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Maximize2,
  Minus,
  X,
} from "lucide-react";

export type FloatingPhotoEntry = { url: string; key?: string };

type FloatingPhotoViewerProps = {
  entries: FloatingPhotoEntry[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Shown in the title bar, e.g. "Lot #10051". */
  title?: string;
};

type Geometry = { x: number; y: number; width: number; height: number };
type WindowMode = "normal" | "minimized" | "maximized";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 260;
const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 600;
const EDGE = 16;
/** Part of the title bar that must stay on screen so the window can be dragged back. */
const GRAB_MARGIN = 120;
const TITLE_BAR_HEIGHT = 44;
const NARROW_SCREEN = 640;
// Inline because the global :focus-visible outline and the arbitrary-value
// shadow class do not apply reliably (same approach as the app's other panels).
// The window frame itself takes focus only so its keys work; its buttons keep
// the normal focus ring.
const WINDOW_CHROME = { boxShadow: "var(--app-shadow-modal)", outline: "none" } as const;

// Reopening the viewer puts it back where the employee last left it during
// this visit (a page reload starts fresh).
let lastGeometry: Geometry | null = null;

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function defaultGeometry(): Geometry {
  const { width: vw, height: vh } = viewport();
  const width = Math.max(MIN_WIDTH, Math.min(DEFAULT_WIDTH, vw - EDGE * 2));
  const height = Math.max(MIN_HEIGHT, Math.min(DEFAULT_HEIGHT, vh - EDGE * 2));
  return { x: Math.round((vw - width) / 2), y: Math.round((vh - height) / 2), width, height };
}

/** Keeps the window's size within the screen and enough of its title bar visible to grab. */
function clampGeometry(geometry: Geometry): Geometry {
  const { width: vw, height: vh } = viewport();
  const width = Math.max(MIN_WIDTH, Math.min(geometry.width, vw));
  const height = Math.max(MIN_HEIGHT, Math.min(geometry.height, vh));
  const x = Math.min(Math.max(geometry.x, GRAB_MARGIN - width), vw - GRAB_MARGIN);
  const y = Math.min(Math.max(geometry.y, 0), vh - TITLE_BAR_HEIGHT);
  return { x, y, width, height };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export default function FloatingPhotoViewer({
  entries,
  index,
  onIndexChange,
  onClose,
  title,
}: FloatingPhotoViewerProps) {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<WindowMode>("normal");
  const [geometry, setGeometry] = useState<Geometry>({ x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [narrow, setNarrow] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const thumbnailRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dragRef = useRef<{ kind: "move" | "resize"; pointerX: number; pointerY: number; start: Geometry } | null>(null);

  const count = entries.length;
  const current = count > 0 ? entries[Math.min(Math.max(index, 0), count - 1)] : undefined;
  const position = count > 0 ? Math.min(Math.max(index, 0), count - 1) : 0;
  const effectiveMode: WindowMode = narrow && mode === "normal" ? "maximized" : mode;

  // Place the window before the first paint so it never flashes at 0,0.
  useLayoutEffect(() => {
    setGeometry(clampGeometry(lastGeometry ?? defaultGeometry()));
    setNarrow(window.innerWidth < NARROW_SCREEN);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) lastGeometry = geometry;
  }, [geometry, mounted]);

  // Keep the window on screen when the browser window is resized.
  useEffect(() => {
    const handleResize = () => {
      setNarrow(window.innerWidth < NARROW_SCREEN);
      setGeometry((previous) => clampGeometry(previous));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // A removed photo can leave the index past the end.
  useEffect(() => {
    if (count > 0 && index > count - 1) onIndexChange(count - 1);
  }, [count, index, onIndexChange]);

  // Move keyboard focus into the viewer when it opens so Escape and the
  // arrow keys act on it straight away.
  useEffect(() => {
    if (mounted) windowRef.current?.focus({ preventScroll: true });
  }, [mounted]);

  const goTo = useCallback(
    (next: number) => {
      if (count === 0) return;
      onIndexChange(Math.min(Math.max(next, 0), count - 1));
    },
    [count, onIndexChange]
  );

  // Arrow keys work wherever focus is, except inside a text field (the
  // employee may be typing in the lot form behind the viewer).
  useEffect(() => {
    if (effectiveMode === "minimized") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowLeft") goTo(position - 1);
      else if (event.key === "ArrowRight") goTo(position + 1);
      else if (event.key === "Home") goTo(0);
      else if (event.key === "End") goTo(count - 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [count, effectiveMode, goTo, position]);

  // Fetch the neighbouring photos ahead so stepping through them is instant.
  useEffect(() => {
    for (const neighbour of [entries[position - 1], entries[position + 1]]) {
      if (!neighbour?.url) continue;
      const image = new Image();
      image.src = neighbour.url;
    }
  }, [entries, position]);

  // Keep the current thumbnail in view in the strip.
  useEffect(() => {
    const thumbnail = thumbnailRefs.current[position];
    if (typeof thumbnail?.scrollIntoView === "function") {
      thumbnail.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [position, effectiveMode]);

  const handleViewerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  const startPointer = (kind: "move" | "resize") => (event: ReactPointerEvent<HTMLElement>) => {
    if (effectiveMode !== "normal" || event.button !== 0) return;
    if (kind === "move" && (event.target as HTMLElement).closest("button, a")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind, pointerX: event.clientX, pointerY: event.clientY, start: geometry };
  };

  const movePointer = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.pointerX;
    const dy = event.clientY - drag.pointerY;
    setGeometry(
      clampGeometry(
        drag.kind === "move"
          ? { ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy }
          : { ...drag.start, width: drag.start.width + dx, height: drag.start.height + dy }
      )
    );
  };

  const endPointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleMaximize = () => setMode((previous) => (previous === "maximized" ? "normal" : "maximized"));

  if (!mounted || count === 0 || !current) return null;

  const label = title ? `${title} photos` : "Photos";
  const counter = `Photo ${position + 1} of ${count}`;
  const iconButton =
    "inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)]";

  if (effectiveMode === "minimized") {
    return createPortal(
      <div
        ref={windowRef}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={handleViewerKeyDown}
        style={WINDOW_CHROME}
        className="fixed bottom-4 right-4 z-[1100] flex w-[300px] max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-2"
      >
        <button
          type="button"
          onClick={() => setMode("normal")}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)]"
          aria-label={`Restore ${label}`}
          title="Restore"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={current.url} alt="" className="h-10 w-10 flex-shrink-0 rounded-md object-cover" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-[var(--app-text)]">{label}</span>
            <span className="block text-xs text-[var(--app-text-muted)]">{counter}</span>
          </span>
        </button>
        <button type="button" onClick={() => setMode("normal")} className={iconButton} aria-label="Restore photo viewer" title="Restore">
          <Copy className="h-4 w-4" />
        </button>
        <button type="button" onClick={onClose} className={iconButton} aria-label="Close photo viewer" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>,
      document.body
    );
  }

  const maximized = effectiveMode === "maximized";
  const frameStyle = maximized
    ? { left: narrow ? 0 : 8, top: narrow ? 0 : 8, width: narrow ? "100vw" : "calc(100vw - 16px)", height: narrow ? "100dvh" : "calc(100dvh - 16px)" }
    : { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height };

  return createPortal(
    <div
      ref={windowRef}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={handleViewerKeyDown}
      style={{ ...WINDOW_CHROME, ...frameStyle }}
      className={`fixed z-[1100] flex flex-col overflow-hidden border border-[var(--app-border)] bg-[var(--app-panel)] ${
        narrow ? "" : "rounded-xl"
      }`}
    >
      {/* Title bar: drag to move, double-click to maximize or restore. */}
      <div
        className={`flex h-11 flex-shrink-0 items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-panel-alt)] pl-3 pr-1.5 select-none ${
          maximized ? "" : "cursor-move touch-none"
        }`}
        onPointerDown={startPointer("move")}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(event) => {
          if (narrow || (event.target as HTMLElement).closest("button, a")) return;
          toggleMaximize();
        }}
      >
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-text)]">
          {title ? `${title} · ` : ""}
          <span className="font-normal text-[var(--app-text-muted)]" aria-live="polite">
            {counter}
          </span>
        </div>
        <a
          href={current.url}
          target="_blank"
          rel="noopener noreferrer"
          className={iconButton}
          aria-label="Open full-size photo in a new tab"
          title="Open full size"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <span className="mx-1 h-5 w-px bg-[var(--app-border)]" aria-hidden="true" />
        <button type="button" onClick={() => setMode("minimized")} className={iconButton} aria-label="Minimize photo viewer" title="Minimize">
          <Minus className="h-4 w-4" />
        </button>
        {narrow ? null : (
          <button
            type="button"
            onClick={toggleMaximize}
            className={iconButton}
            aria-label={maximized ? "Restore photo viewer size" : "Maximize photo viewer"}
            title={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? <Copy className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={`${iconButton} hover:!bg-[var(--app-danger)] hover:!text-[var(--app-on-accent)]`}
          aria-label="Close photo viewer"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Photo. A dark ground suits photos in either theme. */}
      <div className="relative min-h-0 flex-1 bg-[#0b1220]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current.key ?? current.url}
          src={current.url}
          alt={counter}
          className="absolute inset-0 h-full w-full object-contain"
          draggable={false}
        />
        <button
          type="button"
          onClick={() => goTo(position - 1)}
          disabled={position === 0}
          className="absolute left-2 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:pointer-events-none disabled:opacity-0"
          aria-label="Previous photo (Left arrow)"
          title="Previous (←)"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={() => goTo(position + 1)}
          disabled={position >= count - 1}
          className="absolute right-2 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:pointer-events-none disabled:opacity-0"
          aria-label="Next photo (Right arrow)"
          title="Next (→)"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>

      {/* Thumbnails. */}
      {count > 1 ? (
        <div className="flex flex-shrink-0 gap-1.5 overflow-x-auto border-t border-[var(--app-border)] bg-[var(--app-panel)] p-2">
          {entries.map((entry, entryIndex) => (
            <button
              type="button"
              key={entry.key ?? `${entryIndex}-${entry.url}`}
              ref={(node) => {
                thumbnailRefs.current[entryIndex] = node;
              }}
              onClick={() => goTo(entryIndex)}
              aria-label={`Show photo ${entryIndex + 1}`}
              aria-current={entryIndex === position ? "true" : undefined}
              className={`h-14 w-14 flex-shrink-0 overflow-hidden rounded-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
                entryIndex === position
                  ? "ring-2 ring-[var(--app-accent)] ring-offset-1 ring-offset-[var(--app-panel)]"
                  : "opacity-60 hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={entry.url} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
            </button>
          ))}
        </div>
      ) : null}

      {/* Resize grip (bottom-right corner). */}
      {maximized ? null : (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
          onPointerDown={startPointer("resize")}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-[var(--app-text-subtle)]">
            <path d="M15 6 6 15M15 11l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>,
    document.body
  );
}
