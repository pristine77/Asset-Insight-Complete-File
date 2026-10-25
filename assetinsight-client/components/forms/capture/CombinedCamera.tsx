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
} from "lucide-react";
import { toast } from "@/components/ui/toast";

type CombinedMode = "single_lot" | "per_item" | "per_photo";
type Props = {
  value: File[];
  onChange: (files: File[]) => void;
  maxImages?: number; // default 20
  modes: CombinedMode[];
  onModesChange: (modes: CombinedMode[]) => void;
};

export default function CombinedCamera({ value, onChange, maxImages = 20, modes, onModesChange }: Props) {
  const [files, setFiles] = useState<File[]>(value || []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [flashOn, setFlashOn] = useState<boolean>(false);
  const [isTorchSupported, setIsTorchSupported] = useState<boolean>(false);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");

  useEffect(() => setFiles(value || []), [value]);
  useEffect(() => onChange(files), [files]);
  useEffect(() => {
    return () => {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) (videoRef.current as any).srcObject = null;
    };
  }, []);

  function ensureAudioContext(): AudioContext | null {
    try {
      if (!audioCtxRef.current) {
        const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return null;
        audioCtxRef.current = new Ctx();
      }
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

  function startManualUpload() {
    fileInputRef.current?.click();
  }

  function handleFilesSelected(list: FileList | null) {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => {
      const remain = Math.max(0, maxImages - prev.length);
      const toAdd = incoming.slice(0, remain);
      if (toAdd.length < incoming.length) {
        toast.warn(`Only ${remain} images allowed (max ${maxImages}).`);
      }
      return [...prev, ...toAdd];
    });
  }

  async function startInAppCamera() {
    try {
      setCameraError(null);
      setCameraOpen(true);
      setZoom(1);
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
      try {
        const track = (stream.getVideoTracks?.() || [])[0];
        const caps = (track as any)?.getCapabilities?.() || {};
        const torchSupported = !!caps.torch;
        setIsTorchSupported(torchSupported);
        const zoomSupported = typeof (caps as any).zoom !== "undefined" || typeof (caps as any)?.zoom?.min !== "undefined";
        if (zoomSupported) {
          await (track as any)?.applyConstraints?.({ advanced: [{ zoom: 1 }] });
        }
        if (flashOn && torchSupported) {
          await (track as any)?.applyConstraints?.({ advanced: [{ torch: true }] });
        }
      } catch {}
    } catch (err: any) {
      setCameraError(err?.message || "Unable to access camera. Using file capture instead.");
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

  async function captureFromStream() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (files.length >= maxImages) {
      toast.warn(`Limit reached (max ${maxImages} images).`);
      return;
    }

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const targetAR = orientation === "portrait" ? 9 / 16 : 16 / 9;
    const videoAR = vw / vh;

    // Determine crop size honoring zoom
    let cropW: number;
    let cropH: number;
    if (videoAR > targetAR) {
      cropH = vh / zoom;
      cropW = cropH * targetAR;
    } else {
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

    try { navigator.vibrate?.(30); } catch {}
    try { playShutterClick(); } catch {}
    if (flashOn && !isTorchSupported) {
      // simulate flash overlay by briefly filling white; handled via parent overlay in Catalogue
      // here we just proceed to capture
    }

    ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);
    await new Promise<void>((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) return resolve();
          const file = new File([blob], `img-${Date.now()}.jpg`, { type: "image/jpeg" });
          setFiles((prev) => {
            if (prev.length >= maxImages) return prev;
            return [...prev, file];
          });
          resolve();
        },
        "image/jpeg",
        0.92
      );
    });
  }

  function removeImage(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200/80 bg-[var(--app-panel)] from-white to-blue-50/60 p-3 shadow-sm ring-1 ">
        <div>
          <div className="text-sm font-medium text-[var(--app-text)]">Images</div>
          <div className="text-xs text-[var(--app-text-muted)]">{files.length}/{maxImages} image(s)</div>
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
            onClick={startManualUpload}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--app-panel)] from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
          >
            <ImageIcon className="h-4 w-4" /> Upload from device
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => {
          handleFilesSelected(e.target.files);
          e.currentTarget.value = "";
        }}
        className="sr-only"
      />

      {files.length > 0 ? (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-2 shadow ring-1  ">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {files.map((file, idx) => {
              const url = URL.createObjectURL(file);
              return (
                <div key={idx} className="relative group overflow-hidden rounded-xl shadow-md transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-sm">
                  { }
                  <img src={url} alt={file.name} className="h-28 w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} />
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() => removeImage(idx)}
                    className="absolute right-1 top-1 rounded-full bg-black/70 p-1.5 text-white shadow-sm hover:bg-black/80 transition"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] from-white/70 to-gray-50/50 p-5 text-center  shadow-inner">
          <ImageIcon className="mx-auto h-8 w-8 text-[var(--app-text-muted)]" />
          <p className="mt-2 text-sm text-[var(--app-text-muted)]">No images yet</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={startManualUpload}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-[var(--app-panel)] from-blue-500 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
            >
              <ImageIcon className="h-4 w-4" /> Upload images
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--app-text-muted)]">PNG, JPG. Up to {maxImages} images.</p>
        </div>
      )}

      {cameraOpen &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90  overflow-hidden" style={{ paddingTop: "max(env(safe-area-inset-top), 8px)", paddingBottom: "max(env(safe-area-inset-bottom), 8px)", paddingLeft: "max(env(safe-area-inset-left), 8px)", paddingRight: "max(env(safe-area-inset-right), 8px)" }}>
            <div className="relative w-full sm:w-[98%] max-w-none sm:max-w-2xl md:max-w-3xl lg:max-w-5xl xl:max-w-6xl h-[100dvh] sm:h-[96dvh] max-h-[100dvh] sm:max-h-[96dvh] overflow-hidden flex flex-col rounded-none sm:rounded-lg border-0 sm:border border-blue-200/30 bg-black/30 ring-0 sm:ring-1  shadow-sm">
              <div className="relative flex-1 min-h-0 bg-black">
                <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-contain pointer-events-none" style={zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: "center" } : undefined} />

                {/* Top overlay (orientation + counts + flash) */}
                <div className="pointer-events-auto absolute top-2 left-2 right-2 z-20 flex flex-wrap items-center justify-between gap-2 text-[12px] text-white/90">
                  <button type="button" onClick={() => setOrientation((o) => (o === "portrait" ? "landscape" : "portrait"))} className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1  ring-1 ring-white/20 hover:bg-[var(--app-panel)]" title="Toggle orientation">
                    <RotateCw className="h-3.5 w-3.5" />
                    <span className="capitalize">Change to {orientation == "portrait" ? "Full Screen" : "Half Screen"}</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-3">
                    <div>Total: {files.length}/{maxImages}</div>
                  </div>
                  <button type="button" onClick={async () => {
                    setFlashOn((v) => !v);
                    try {
                      const stream = videoRef.current?.srcObject as MediaStream | null;
                      const track = stream?.getVideoTracks?.()[0] as any;
                      if (track?.getCapabilities?.()?.torch) {
                        await track.applyConstraints({ advanced: [{ torch: !flashOn }] });
                        setIsTorchSupported(true);
                      } else {
                        setIsTorchSupported(false);
                      }
                    } catch {}
                  }} className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1  ring-1 ring-white/20 hover:bg-[var(--app-panel)]" title="Flash">
                    {flashOn ? <Zap className="h-3.5 w-3.5 text-yellow-300" /> : <ZapOff className="h-3.5 w-3.5" />}
                    <span>{flashOn ? "On" : "Off"}</span>
                  </button>
                </div>

                {/* Mode selector overlay */}
                <div className="pointer-events-auto absolute left-2 right-2 z-20 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--app-panel)] px-2 py-2 ring-1 ring-white/20 " style={{ top: 48 }}>
                  {([
                    { key: "single_lot", label: "Single Lot" },
                    { key: "per_item", label: "Per Item" },
                    { key: "per_photo", label: "Per Lot" },
                  ] as { key: CombinedMode; label: string }[]).map((m) => {
                    const active = modes.includes(m.key);
                    return (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => {
                          const next = active
                            ? modes.filter((x) => x !== m.key)
                            : [...modes, m.key];
                          onModesChange(next.length ? next : [m.key]);
                        }}
                        className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] shadow ${
                          active ? "bg-blue-500 text-white" : "bg-[var(--app-panel)] text-white/90"
                        }`}
                        title={m.label}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => onModesChange(["single_lot", "per_item", "per_photo"])}
                    className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] shadow bg-[var(--app-panel)] text-white/90 hover:bg-[var(--app-panel)]"
                    title="Select all"
                  >
                    All
                  </button>
                </div>

                {/* Zoom overlay */}
                <div className="pointer-events-auto absolute left-2 right-2 z-20 rounded-xl bg-[var(--app-panel)] p-2 ring-1 ring-white/20  flex flex-wrap items-center gap-2" style={{ bottom: `calc(96px + env(safe-area-inset-bottom))` }}>
                  <ZoomOut className="h-4 w-4 text-white/90" />
                  <input type="range" min={1} max={5} step={0.1} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="flex-1 min-w-[140px] accent-blue-500 cursor-pointer" />
                  <ZoomIn className="h-4 w-4 text-white/90" />
                  <div className="ml-2 w-10 text-right text-[11px] text-white/90">{zoom.toFixed(1)}x</div>
                </div>

                {/* Bottom controls overlay */}
                <div className="pointer-events-auto absolute inset-x-0 z-20 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-black/40 px-2 sm:px-3 py-2 " style={{ bottom: "env(safe-area-inset-bottom)", paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}>
                  <button type="button" onClick={captureFromStream} className="inline-flex cursor-pointer items-center gap-3 rounded-full bg-[var(--app-panel)] from-blue-500 to-blue-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600">
                    <Camera className="h-5 w-5 text-white" /> Capture
                  </button>
                  <button type="button" onClick={stopInAppCamera} className="group relative flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full bg-[var(--app-panel)] from-blue-500 to-blue-600 text-white shadow-sm ring-2 ring-blue-300/60 hover:from-blue-400 hover:to-blue-600 active:translate-y-0.5 active:shadow-sm focus:outline-none cursor-pointer" aria-label="Done" title="Done">
                    <Check className="h-7 w-7 sm:h-8 sm:w-8" />
                    <span className="sr-only">Done</span>
                  </button>
                </div>

                <canvas ref={canvasRef} className="hidden" />
                {cameraError && (
                  <div className="pointer-events-auto absolute left-2 right-2 top-14 z-30 rounded-lg border border-red-200 bg-red-50/95 p-2 text-xs text-red-700">
                    {cameraError}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
