"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Camera,
  Image as ImageIcon,
  Trash2,
  Check,
  ZoomIn,
  ZoomOut,
  Zap,
  ZapOff,
  RotateCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { toast } from "@/components/ui/toast";

export type CatalogueLot = {
  id: string;
  files: File[];
  coverIndex: number; // 0-based within files
};

type Props = {
  value: CatalogueLot[];
  onChange: (lots: CatalogueLot[]) => void;
  // caps (defaults align with backend today)
  maxImagesPerLot?: number; // default 20
  maxTotalImages?: number; // default 500
};

export default function CatalogueSection({
  value,
  onChange,
  maxImagesPerLot = 20,
  maxTotalImages = 500,
}: Props) {
  const [lots, setLots] = useState<CatalogueLot[]>(value || []);
  const [activeIdx, setActiveIdx] = useState<number>(
    value?.length ? value.length - 1 : -1
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // When true, after a manual device upload we should move to the next lot automatically
  const advanceAfterUploadRef = useRef(false);
  // Camera UX controls
  const [zoom, setZoom] = useState<number>(1); // 1x - 5x (digital zoom)
  const [flashOn, setFlashOn] = useState<boolean>(false);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "landscape"
  );
  const [isTorchSupported, setIsTorchSupported] = useState<boolean>(false);
  const [isSimulatingFlash, setIsSimulatingFlash] = useState<boolean>(false);
  const [videoAR, setVideoAR] = useState<number | null>(null);

  useEffect(() => setLots(value || []), [value]);
  useEffect(() => onChange(lots), [lots]);
  useEffect(() => {
    return () => {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) (videoRef.current as any).srcObject = null;
    };
  }, []);

  // Re-apply constraints when orientation changes while camera is open
  useEffect(() => {
    if (!cameraOpen) return;
    const stream = videoRef.current?.srcObject as MediaStream | null;
    const track = stream?.getVideoTracks?.()[0] as any;
    try {
      track?.applyConstraints({
        width: { ideal: orientation === "landscape" ? 1920 : 1080 },
        height: { ideal: orientation === "landscape" ? 1080 : 1920 },
      });
      // Reset hardware lens zoom to 1x if supported so preview is not zoomed-in
      const caps = (track as any)?.getCapabilities?.() || {};
      const hasZoom =
        typeof (caps as any).zoom !== "undefined" ||
        typeof (caps as any)?.zoom?.min !== "undefined";
      if (hasZoom) {
        (track as any)?.applyConstraints?.({ advanced: [{ zoom: 1 }] });
      }
    } catch {}
  }, [orientation, cameraOpen]);

  // Reset digital zoom when user toggles orientation
  useEffect(() => {
    if (cameraOpen) setZoom(1);
  }, [orientation, cameraOpen]);

  const totalImages = useMemo(
    () => lots.reduce((s, l) => s + l.files.length, 0),
    [lots]
  );

  function createLot() {
    const id = `lot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nextLots = [...lots, { id, files: [], coverIndex: 0 }];
    setLots(nextLots);
    setActiveIdx(nextLots.length - 1);
    // do not trigger native file input anymore; in-app camera will be used
  }

  function removeLot(idx: number) {
    const next = lots.filter((_, i) => i !== idx);
    setLots(next);
    if (activeIdx === idx) setActiveIdx(next.length ? next.length - 1 : -1);
  }

  function setCover(idx: number, imgIdx: number) {
    setLots((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, coverIndex: imgIdx } : l))
    );
  }

  function removeImage(idx: number, imgIdx: number) {
    setLots((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const files = l.files.filter((_, j) => j !== imgIdx);
        const coverIndex = Math.max(
          0,
          Math.min(files.length - 1, l.coverIndex)
        );
        return { ...l, files, coverIndex };
      })
    );
  }

  function appendToActiveLot(newFiles: File[]) {
    if (activeIdx < 0 || newFiles.length === 0) return;
    setLots((prev) => {
      const out = [...prev];
      const cur = out[activeIdx];
      if (!cur) return prev;
      const prevTotal = prev.reduce((s, l) => s + l.files.length, 0);
      const remainingTotal = Math.max(0, maxTotalImages - prevTotal);
      const remainingLot = Math.max(0, maxImagesPerLot - cur.files.length);
      const allowed = Math.min(remainingTotal, remainingLot, newFiles.length);
      if (allowed <= 0) {
        toast.warn(
          `Limit reached (caps: ${maxImagesPerLot}/lot, ${maxTotalImages} total).`
        );
        return prev;
      }
      if (allowed < newFiles.length) {
        toast.warn(
          `Only ${allowed} images allowed (caps: ${maxImagesPerLot}/lot, ${maxTotalImages} total).`
        );
      }
      const toAdd = newFiles.slice(0, allowed);
      out[activeIdx] = { ...cur, files: [...cur.files, ...toAdd] };
      return out;
    });
  }

  function handleFilesSelected(files: FileList | null) {
    if (files == null) return;
    const incoming = Array.from(files);
    appendToActiveLot(incoming);
    if (advanceAfterUploadRef.current) {
      // reset the flag and proceed to next lot
      advanceAfterUploadRef.current = false;
      goNextLot();
    }
  }

  function startManualUpload(createIfNone: boolean = true) {
    if (createIfNone && activeIdx < 0) {
      // Create a lot first so uploads have a destination
      createLot();
      // Defer click so state updates before selection dialog returns
      setTimeout(() => fileInputRef.current?.click(), 0);
      return;
    }
    fileInputRef.current?.click();
  }

  async function startInAppCamera() {
    try {
      setCameraError(null);
      setCameraOpen(true);
      setZoom(1);
      if (activeIdx < 0) {
        // ensure there is a lot to receive captures
        createLot();
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: orientation === "landscape" ? 1920 : 1080 },
          height: { ideal: orientation === "landscape" ? 1080 : 1920 },
        },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream as any;
        await videoRef.current.play().catch(() => {});
      }
      // Detect torch support and apply if flashOn
      try {
        const track = (stream.getVideoTracks?.() || [])[0];
        const caps = (track as any)?.getCapabilities?.() || {};
        const torchSupported = !!caps.torch;
        setIsTorchSupported(torchSupported);
        // Ensure lens zoom is 1x if device supports zoom
        const zoomSupported =
          typeof (caps as any).zoom !== "undefined" ||
          typeof (caps as any)?.zoom?.min !== "undefined";
        if (zoomSupported) {
          await (track as any)?.applyConstraints?.({ advanced: [{ zoom: 1 }] });
        }
        if (flashOn && torchSupported) {
          await (track as any)?.applyConstraints?.({
            advanced: [{ torch: true }],
          });
        }
      } catch {}
    } catch (err: any) {
      setCameraError(
        err?.message || "Unable to access camera. Using file capture instead."
      );
      setCameraOpen(false);
      setTimeout(() => fileInputRef.current?.click(), 50);
    }
  }

  function stopInAppCamera() {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) (videoRef.current as any).srcObject = null;
    } finally {
      setCameraOpen(false);
    }
  }

  // Audio helpers for shutter click
  function ensureAudioContext(): AudioContext | null {
    try {
      if (!audioCtxRef.current) {
        const Ctx: any =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return null;
        audioCtxRef.current = new Ctx();
      }
      // resume on user gesture contexts (mobile)
      audioCtxRef.current?.resume?.();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }

  function playShutterClick() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Pulse 1
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.type = "square";
    osc1.frequency.setValueAtTime(900, now);
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.28, now + 0.01);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc1.connect(g1);
    g1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.08);
    // Pulse 2 (slightly lower freq, quick after)
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(600, now + 0.06);
    g2.gain.setValueAtTime(0, now + 0.06);
    g2.gain.linearRampToValueAtTime(0.22, now + 0.08);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc2.connect(g2);
    g2.connect(ctx.destination);
    osc2.start(now + 0.06);
    osc2.stop(now + 0.16);
  }

  async function captureFromStream() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    // Respect caps before drawing
    const cur = lots[activeIdx];
    if (!cur) return;
    const totalCount = lots.reduce((s, l) => s + l.files.length, 0);
    if (cur.files.length >= maxImagesPerLot || totalCount >= maxTotalImages) {
      toast.warn(
        `Limit reached (caps: ${maxImagesPerLot}/lot, ${maxTotalImages} total).`
      );
      return;
    }
    // Target aspect ratio based on orientation (portrait 9:16, landscape 16:9)
    const targetAR = orientation === "portrait" ? 9 / 16 : 16 / 9;
    const videoAR = vw / vh;

    // Determine crop size honoring zoom
    let cropW: number;
    let cropH: number;
    if (videoAR > targetAR) {
      // video is wider than target
      cropH = vh / zoom;
      cropW = cropH * targetAR;
    } else {
      // video is narrower/taller than target
      cropW = vw / zoom;
      cropH = cropW / targetAR;
    }
    const sx = Math.max(0, (vw - cropW) / 2);
    const sy = Math.max(0, (vh - cropH) / 2);

    // Output canvas at 1080p dimensions respecting orientation
    const outW = orientation === "landscape" ? 1920 : 1080;
    const outH = orientation === "landscape" ? 1080 : 1920;
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Haptics + shutter click
    try {
      navigator.vibrate?.(30);
    } catch {}
    try {
      playShutterClick();
    } catch {}
    if (flashOn && !isTorchSupported) {
      setIsSimulatingFlash(true);
      setTimeout(() => setIsSimulatingFlash(false), 120);
    }
    ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);
    await new Promise<void>((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) return resolve();
          const file = new File(
            [blob],
            `lot-${activeIdx + 1}-${Date.now()}.jpg`,
            {
              type: "image/jpeg",
            }
          );
          appendToActiveLot([file]);
          resolve();
        },
        "image/jpeg",
        0.92
      );
    });
  }

  function goPrevLot() {
    setActiveIdx((i) => Math.max(0, i - 1));
  }

  function goNextLot() {
    if (activeIdx >= lots.length - 1) {
      createLot();
    } else {
      setActiveIdx((i) => Math.min(i + 1, lots.length - 1));
    }
  }

  const activeLot = lots[activeIdx];

  return (
    <div className="space-y-4">
      {/* Summary/header */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200/80 bg-[var(--app-panel)] from-white to-blue-50/60 p-3 shadow-sm ring-1 ">
        <div>
          <div className="text-sm font-medium text-[var(--app-text)]">Lots</div>
          <div className="text-xs text-[var(--app-text-muted)]">
            {lots.length} lot(s), {totalImages}/{maxTotalImages} image(s) total
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={startInAppCamera}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--app-panel)] from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
          >
            <Camera className="h-4 w-4" /> Open Camera
          </button>
          <button
            type="button"
            onClick={() => startManualUpload(true)}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--app-panel)] from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
          >
            <ImageIcon className="h-4 w-4" /> Upload from device
          </button>
        </div>
      </div>

      {/* Hidden camera/file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => {
          handleFilesSelected(e.target.files);
          // reset input so selecting same files again still triggers
          e.currentTarget.value = "";
        }}
        className="sr-only"
      />

      {/* Active capture panel */}
      {activeIdx >= 0 && (
        <div className="rounded-lg border border-blue-200/80 bg-[var(--app-panel)] p-3 shadow-sm ring-1  ">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-[var(--app-text)]">
              Lot #{activeIdx + 1}
            </div>
            <div className="text-xs text-[var(--app-text-muted)]">
              {activeLot?.files.length}/{maxImagesPerLot} images
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => startManualUpload(false)}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[var(--app-panel)] from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
            >
              <ImageIcon className="h-4 w-4" /> Upload images
            </button>
            <button
              type="button"
              onClick={() => setActiveIdx(-1)}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[var(--app-panel)] from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
            >
              Done
            </button>
          </div>

          {activeLot?.files.length ? (
            <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow ring-1  ">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {activeLot.files.map((file, i) => {
                  const url = URL.createObjectURL(file);
                  const isCover = i === activeLot.coverIndex;
                  return (
                    <div
                      key={i}
                      className="relative group overflow-hidden rounded-xl shadow-md transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-sm"
                    >
                      { }
                      <img
                        src={url}
                        alt={file.name}
                        className="h-28 w-full object-cover"
                        onLoad={() => URL.revokeObjectURL(url)}
                      />
                      <div className="absolute inset-x-1 bottom-1 flex items-center justify-between gap-1">
                        <button
                          type="button"
                          onClick={() => setCover(activeIdx, i)}
                          className={`rounded-md cursor-pointer px-2 py-1 text-[10px] font-semibold shadow-sm  ${
                            isCover
                              ? "bg-blue-600/90 text-white"
                              : "bg-black/50 text-white"
                          }`}
                        >
                          {isCover ? "Cover" : "Set cover"}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeImage(activeIdx, i)}
                          className="rounded-full cursor-pointer bg-black/60 p-1.5 text-white shadow-sm hover:bg-black/70 transition"
                          aria-label="Remove image"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] from-white/70 to-gray-50/50 p-5 text-center  shadow-inner">
              <ImageIcon className="mx-auto h-8 w-8 text-[var(--app-text-muted)]" />
              <p className="mt-2 text-sm text-[var(--app-text-muted)]">No images yet</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => startManualUpload(false)}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[var(--app-panel)] from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
                >
                  <ImageIcon className="h-4 w-4" /> Upload images
                </button>
              </div>
              <p className="mt-1 text-xs text-[var(--app-text-muted)]">
                PNG, JPG. Up to {maxImagesPerLot} images in this lot.
              </p>
            </div>
          )}

          <div className="mt-2 text-[11px] text-[var(--app-text-muted)]">
            Tip: Use "Open Camera" above to create a new lot if needed and
            capture, or "Upload images" to add photos to this lot. Use "Done"
            to finish catalogue capture.
          </div>
        </div>
      )}

      {/* Lots summary */}
      {lots.length > 0 && (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 shadow ring-1  ">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {lots.map((lot, idx) => {
              const cover = lot.files[lot.coverIndex];
              const coverUrl = cover ? URL.createObjectURL(cover) : undefined;
              return (
                <div
                  key={lot.id}
                  className={`flex items-center gap-3 rounded-xl border p-2 bg-[var(--app-panel)] shadow-sm transition active:translate-y-0.5 ${
                    idx === activeIdx ? "border-blue-300" : "border-[var(--app-border)]"
                  } hover:shadow-md`}
                >
                  {cover ? (

                    <img
                      src={coverUrl}
                      alt={`Lot ${idx + 1}`}
                      className="h-16 w-16 rounded-xl object-cover shadow"
                      onLoad={() => coverUrl && URL.revokeObjectURL(coverUrl)}
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--app-panel-alt)] text-[var(--app-text-muted)] shadow-inner">
                      #{idx + 1}
                    </div>
                  )}
                  <div className="flex-1">
                    <div className="text-sm font-medium text-[var(--app-text)]">
                      Lot #{idx + 1}
                    </div>
                    <div className="text-xs text-[var(--app-text-muted)]">
                      {lot.files.length} image(s)
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveIdx(idx)}
                      className="rounded-lg cursor-pointer border border-[var(--app-border)] bg-[var(--app-panel)] px-2.5 py-1.5 text-xs text-[var(--app-text-muted)] shadow hover:bg-[var(--app-panel)] transition"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeLot(idx)}
                      className="rounded-lg cursor-pointer border border-red-300 bg-[var(--app-panel)] px-2.5 py-1.5 text-xs text-red-600 shadow hover:bg-red-50 transition"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="text-xs text-[var(--app-text-muted)]">
        Limits: up to {maxImagesPerLot} images per lot; {maxTotalImages} images
        total per report.
      </div>

      {/* In-app camera overlay */}
      {cameraOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90  overflow-hidden"
            style={{
              paddingTop: "max(env(safe-area-inset-top), 8px)",
              paddingBottom: "max(env(safe-area-inset-bottom), 8px)",
              paddingLeft: "max(env(safe-area-inset-left), 8px)",
              paddingRight: "max(env(safe-area-inset-right), 8px)",
            }}
          >
            <div className="relative w-full sm:w-[98%] max-w-none sm:max-w-2xl md:max-w-3xl lg:max-w-5xl xl:max-w-6xl h-[100dvh] sm:h-[96dvh] max-h-[100dvh] sm:max-h-[96dvh] overflow-hidden flex flex-col rounded-none sm:rounded-lg border-0 sm:border border-blue-200/30 bg-black/30 ring-0 sm:ring-1  shadow-sm">
              <div className="relative flex-1 min-h-0 bg-black">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  onLoadedMetadata={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    const w = v.videoWidth || 0;
                    const h = v.videoHeight || 0;
                    if (w > 0 && h > 0) setVideoAR(w / h);
                  }}
                  className="absolute inset-0 h-full w-full object-contain pointer-events-none"
                  style={
                    zoom > 1
                      ? {
                          transform: `scale(${zoom})`,
                          transformOrigin: "center",
                        }
                      : undefined
                  }
                />
                {/* Simulated flash overlay */}
                {isSimulatingFlash && (
                  <div className="absolute inset-0 bg-[var(--app-panel)] animate-pulse" />
                )}

                {/* Top overlay: orientation, counters, flash */}
                <div className="pointer-events-auto absolute top-2 left-2 right-2 z-20 flex flex-wrap items-center justify-between gap-2 text-[12px] text-white/90">
                  <button
                    type="button"
                    onClick={() =>
                      setOrientation((o) =>
                        o === "portrait" ? "landscape" : "portrait"
                      )
                    }
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1  ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
                    title="Toggle orientation"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    <span className="capitalize">
                      Change to{" "}
                      {orientation == "portrait"
                        ? "Full Screen"
                        : "Half Screen"}
                    </span>
                  </button>
                  <div className="flex flex-wrap items-center gap-3">
                    <div>
                      Total: {totalImages}/{maxTotalImages}
                    </div>
                    <div>
                      Lot {activeIdx + 1}: {lots[activeIdx]?.files.length ?? 0}/
                      {maxImagesPerLot}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      setFlashOn((v) => !v);
                      try {
                        const stream = videoRef.current
                          ?.srcObject as MediaStream | null;
                        const track = stream?.getVideoTracks?.()[0] as any;
                        if (track?.getCapabilities?.()?.torch) {
                          await track.applyConstraints({
                            advanced: [{ torch: !flashOn }],
                          });
                          setIsTorchSupported(true);
                        } else {
                          setIsTorchSupported(false);
                        }
                      } catch {}
                    }}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1  ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
                    title="Flash"
                  >
                    {flashOn ? (
                      <Zap className="h-3.5 w-3.5 text-yellow-300" />
                    ) : (
                      <ZapOff className="h-3.5 w-3.5" />
                    )}
                    <span>{flashOn ? "On" : "Off"}</span>
                  </button>
                </div>

                {/* Zoom overlay */}
                <div
                  className="pointer-events-auto absolute left-2 right-2 z-20 rounded-xl bg-[var(--app-panel)] p-2 ring-1 ring-white/20  flex flex-wrap items-center gap-2"
                  style={{ bottom: `calc(96px + env(safe-area-inset-bottom))` }}
                >
                  <ZoomOut className="h-4 w-4 text-white/90" />
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={0.1}
                    value={zoom}
                    onChange={(e) => setZoom(parseFloat(e.target.value))}
                    className="flex-1 min-w-[140px] accent-blue-500 cursor-pointer"
                  />
                  <ZoomIn className="h-4 w-4 text-white/90" />
                  <div className="ml-2 w-10 text-right text-[11px] text-white/90">
                    {zoom.toFixed(1)}x
                  </div>
                </div>

                {/* Bottom controls overlay */}
                <div
                  className="pointer-events-auto absolute inset-x-0 z-20 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-black/40 px-2 sm:px-3 py-2 "
                  style={{
                    bottom: "env(safe-area-inset-bottom)",
                    paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
                  }}
                >
                  <button
                    type="button"
                    onClick={goPrevLot}
                    disabled={activeIdx <= 0}
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/20 hover:bg-[var(--app-panel)] disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    aria-label="Previous lot"
                  >
                    <ChevronLeft className="h-4 w-4 text-white" />{" "}
                    <span className="hidden sm:inline">Prev</span>
                  </button>
                  <button
                    type="button"
                    onClick={captureFromStream}
                    className="inline-flex cursor-pointer items-center gap-3 rounded-full bg-[var(--app-panel)] from-blue-500 to-blue-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
                  >
                    <Camera className="h-5 w-5 text-white" /> Capture
                  </button>
                  <button
                    type="button"
                    onClick={goNextLot}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-green-500 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
                    aria-label="Next lot"
                  >
                    <span className="hidden sm:inline">Next</span>{" "}
                    <ChevronRight className="h-4 w-4 text-white" />
                  </button>
                  <button
                    type="button"
                    onClick={stopInAppCamera}
                    className="group relative flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full bg-[var(--app-panel)] from-blue-500 to-blue-600 text-white shadow-sm ring-2 ring-blue-300/60 hover:from-blue-400 hover:to-blue-600 active:translate-y-0.5 active:shadow-sm focus:outline-none cursor-pointer"
                    aria-label="Done"
                    title="Done"
                  >
                    <Check className="h-7 w-7 sm:h-8 sm:w-8" />
                    <span className="sr-only">Done</span>
                  </button>
                </div>

                {/* Error overlay */}
                {cameraError && (
                  <div className="pointer-events-auto absolute left-2 right-2 top-14 z-30 rounded-lg border border-red-200 bg-red-50/95 p-2 text-xs text-red-700">
                    {cameraError}
                  </div>
                )}

                <canvas ref={canvasRef} className="hidden" />
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
