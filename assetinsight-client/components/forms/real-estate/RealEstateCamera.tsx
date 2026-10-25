"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronLeft, ChevronRight, RotateCw, Trash2, Upload, X, Zap, ZapOff, ZoomIn, ZoomOut } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  onAdd: (files: File[]) => void;
  maxCount?: number; // default 10
  downloadPrefix?: string; // optional prefix used for local filename when capturing
};

export default function RealEstateCamera({ open, onClose, onAdd, maxCount = 10, downloadPrefix }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");
  const [zoom, setZoom] = useState<number>(1);
  const [flashOn, setFlashOn] = useState<boolean>(false);
  const [isTorchSupported, setIsTorchSupported] = useState<boolean>(false);
  const [isSimulatingFlash, setIsSimulatingFlash] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // Reset files for a fresh capture session
    setFiles([]);
    (async () => {
      try {
        setCameraError(null);
        // Smart camera: Request maximum resolution available on any device
        // Using very high ideal values - device will use its maximum supported resolution
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            // Request extremely high resolution - device will fall back to its maximum
            // Works for: iPhone (up to 4032x3024), Samsung S25 Ultra (up to 4000x3000), etc.
            width: { ideal: 8000, min: 1920 },
            height: { ideal: 6000, min: 1080 },
          },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream as any;
          await videoRef.current.play().catch(() => {});
        }
        
        // Try to maximize resolution after getting stream
        try {
          const track = stream.getVideoTracks()[0];
          if (track) {
            const capabilities = track.getCapabilities?.() as any;
            if (capabilities?.width?.max && capabilities?.height?.max) {
              // Apply maximum resolution the device supports
              await track.applyConstraints({
                width: { ideal: capabilities.width.max },
                height: { ideal: capabilities.height.max },
              });
              console.log(`Camera: Using max resolution ${capabilities.width.max}x${capabilities.height.max}`);
            }
          }
        } catch (e) {
          console.log("Camera: Using default resolution", e);
        }
        
        // Capabilities for torch and zoom
        try {
          const track = stream.getVideoTracks?.()[0] as any;
          const caps = track?.getCapabilities?.() || {};
          const torchSupported = !!caps?.torch;
          setIsTorchSupported(torchSupported);
          const zoomSupported = typeof (caps as any).zoom !== "undefined" || typeof (caps as any)?.zoom?.min !== "undefined";
          if (zoomSupported) await track?.applyConstraints?.({ advanced: [{ zoom: 1 }] });
          if (flashOn && torchSupported) await track?.applyConstraints?.({ advanced: [{ torch: true }] });
        } catch {}
      } catch (e: any) {
        setCameraError(e?.message || "Unable to access camera");
        closeCamera();
      }
    })();

    return () => {
      try {
        const stream = streamRef.current;
        stream?.getTracks()?.forEach((t) => t.stop());
        streamRef.current = null;
        if (videoRef.current) (videoRef.current as any).srcObject = null;
      } catch {}
    };

  }, [open]);

  useEffect(() => {
    if (!open) return;
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks?.()[0] as any;
      track?.applyConstraints?.({
        width: { ideal: orientation === "landscape" ? 1920 : 1080 },
        height: { ideal: orientation === "landscape" ? 1080 : 1920 },
      });
      const caps = track?.getCapabilities?.() || {};
      const zoomSupported = typeof (caps as any).zoom !== "undefined" || typeof (caps as any)?.zoom?.min !== "undefined";
      if (zoomSupported) track?.applyConstraints?.({ advanced: [{ zoom: 1 }] });
      setZoom(1);
    } catch {}
  }, [orientation, open]);

  function closeCamera() {
    try {
      const stream = streamRef.current;
      stream?.getTracks()?.forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) (videoRef.current as any).srcObject = null;
    } catch {}
    onClose();
  }

  function addManual(filesList: FileList | null) {
    if (!filesList) return;
    const incoming = Array.from(filesList);
    setFiles((prev) => {
      const after = [...prev, ...incoming].slice(0, maxCount);
      return after;
    });
  }

  async function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const targetAR = orientation === "portrait" ? 9 / 16 : 16 / 9;
    const videoARNow = vw / vh;
    let cropW: number;
    let cropH: number;
    if (videoARNow > targetAR) {
      cropH = vh / zoom;
      cropW = cropH * targetAR;
    } else {
      cropW = vw / zoom;
      cropH = cropW / targetAR;
    }
    const sx = Math.max(0, (vw - cropW) / 2);
    const sy = Math.max(0, (vh - cropH) / 2);
    const outW = orientation === "landscape" ? 1920 : 1080;
    const outH = orientation === "landscape" ? 1080 : 1920;
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (flashOn && !isTorchSupported) {
      setIsSimulatingFlash(true);
      setTimeout(() => setIsSimulatingFlash(false), 120);
    }
    ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 1.0) // Maximum quality
    );
    if (!blob) return;
    const safePrefix = (downloadPrefix || 'real-estate').replace(/[^a-zA-Z0-9_-]/g, '-');
    const filename = `${safePrefix}-${Date.now()}.jpg`;
    const file = new File([blob], filename, { type: "image/jpeg" });
    // Do not trigger per-shot download; accumulate and zip on Done
    setFiles((prev) => (prev.length < maxCount ? [...prev, file] : prev));
  }

  function removeAt(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function exitAndClose() {
    closeCamera();
  }

  async function done() {
    if (files.length > 0) onAdd(files.slice(0, maxCount));
    closeCamera();
  }

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90  overflow-hidden">
      <div className="relative w-full sm:w-[98%] max-w-none sm:max-w-2xl md:max-w-3xl lg:max-w-5xl xl:max-w-6xl h-[100dvh] sm:h-[96dvh] max-h-[100dvh] sm:max-h-[96dvh] overflow-hidden flex flex-col rounded-none sm:rounded-lg border-0 sm:border border-blue-200/30 bg-black/30 ring-0 sm:ring-1  shadow-sm">
        <div className="relative flex-1 min-h-0 bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 h-full w-full object-contain pointer-events-none"
            style={zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: "center" } : undefined}
          />
          {isSimulatingFlash && <div className="absolute inset-0 bg-[var(--app-panel)] animate-pulse" />}

          {/* Top overlay */}
          <div className="pointer-events-auto absolute top-2 left-2 right-2 z-20 flex flex-wrap items-center justify-between gap-2 text-[12px] text-white/90">
            <button
              type="button"
              onClick={exitAndClose}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1  ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
              title="Exit"
            >
              <X className="h-3.5 w-3.5" />
              <span>Exit</span>
            </button>
            <button
              type="button"
              onClick={() => setOrientation((o) => (o === "portrait" ? "landscape" : "portrait"))}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1  ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
              title="Toggle orientation"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span className="capitalize">Change to {orientation == "portrait" ? "Full Screen" : "Half Screen"}</span>
            </button>
            <button
              type="button"
              onClick={async () => {
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
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1  ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
              title="Flash"
            >
              {flashOn ? <Zap className="h-3.5 w-3.5 text-yellow-300" /> : <ZapOff className="h-3.5 w-3.5" />}
              <span>{flashOn ? "On" : "Off"}</span>
            </button>
          </div>

          {/* Zoom */}
          <div className="pointer-events-auto absolute left-2 right-2 z-20 rounded-xl bg-[var(--app-panel)] p-2 ring-1 ring-white/20  flex flex-wrap items-center gap-2" style={{ bottom: `calc(120px + env(safe-area-inset-bottom))` }}>
            <ZoomOut className="h-4 w-4 text-white/90" />
            <input type="range" min={1} max={5} step={0.1} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="flex-1 min-w-[140px] accent-blue-500 cursor-pointer" />
            <ZoomIn className="h-4 w-4 text-white/90" />
            <div className="ml-2 w-10 text-right text-[11px] text-white/90">{zoom.toFixed(1)}x</div>
          </div>

          {/* Bottom controls */}
          <div className="pointer-events-auto absolute inset-x-0 z-20 border-t border-white/10 bg-black/40 px-2 sm:px-3 py-2 " style={{ bottom: "env(safe-area-inset-bottom)", paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 w-full">
              <button type="button" onClick={exitAndClose} className="h-12 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-semibold text-white ring-1 ring-white/10 hover:bg-blue-500 cursor-pointer" aria-label="Close">
                <ChevronLeft className="h-5 w-5" />
                <span className="text-xs">Cancel</span>
              </button>
              <button type="button" onClick={done} className="h-12 w-12 inline-flex items-center justify-center rounded-lg bg-[var(--app-panel)] from-blue-500 to-blue-600 text-white shadow-sm ring-2 ring-blue-300/60 hover:from-blue-400 hover:to-blue-600 focus:outline-none cursor-pointer" aria-label="Done" title="Done">
                <Check className="h-6 w-6" />
              </button>
              <button type="button" onClick={() => {}} className="h-12 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-green-600 px-3 text-sm font-semibold text-white ring-1 ring-white/10 hover:bg-green-500 cursor-default" aria-label="Next">
                <span className="text-xs">Ready</span>
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2 w-full">
              <button type="button" onClick={capture} className="h-11 inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-[var(--app-panel)] from-blue-500 to-blue-600 px-3 text-sm font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm" title="Capture">
                <Camera className="h-5 w-5" /> Capture
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="h-11 inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-[var(--app-panel)] border border-[var(--app-border)] px-3 text-sm font-semibold text-[var(--app-text)] shadow hover:bg-[var(--app-panel)]">
                <Upload className="h-5 w-5" /> Manual Upload
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => addManual(e.target.files)} />
            </div>
          </div>

          {/* Error overlay */}
          {cameraError && (
            <div className="pointer-events-auto absolute left-2 right-2 top-14 z-30 rounded-lg border border-red-200 bg-red-50/95 p-2 text-xs text-red-700">{cameraError}</div>
          )}

          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Preview bar */}
        <div className="border-t border-gray-800 bg-black/60 text-white/90 p-2">
          <div className="flex items-center gap-2 overflow-x-auto">
            {files.map((f, i) => {
              const url = URL.createObjectURL(f);
              return (
                <div key={i} className="relative group rounded-lg overflow-hidden border border-white/10">
                  { }
                  <img src={url} alt={f.name} className="h-16 w-16 object-cover" onLoad={() => URL.revokeObjectURL(url)} />
                  <button type="button" onClick={() => removeAt(i)} className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white shadow-sm hover:bg-black/80 transition" aria-label="Remove">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            {files.length === 0 && <div className="text-xs text-white/70">No images yet</div>}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
