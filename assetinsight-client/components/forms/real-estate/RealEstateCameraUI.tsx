"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "@/components/ui/toast";
import {
  Camera,
  Check,
  X,
  Zap,
  ZapOff,
  ZoomIn,
  ZoomOut,
  Square,
  Play,
} from "lucide-react";

type CaptureMode = "main" | "extra" | "video";

type Props = {
  open: boolean;
  onClose: () => void;
  onAddMainImages: (files: File[]) => void;
  onAddExtraImages: (files: File[]) => void;
  onAddVideo: (file: File) => void;
  downloadPrefix?: string;
  hasVideo?: boolean;
  mainImageCount: number;
  extraImageCount: number;
};

export default function RealEstateCameraUI({
  open,
  onClose,
  onAddMainImages,
  onAddExtraImages,
  onAddVideo,
  downloadPrefix,
  hasVideo = false,
  mainImageCount = 0,
  extraImageCount = 0,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bottomControlsRef = useRef<HTMLDivElement>(null);
  const cameraViewRef = useRef<HTMLDivElement>(null);

  const [captureMode, setCaptureMode] = useState<CaptureMode>("main");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "portrait"
  );
  const [zoom, setZoom] = useState<number>(1);
  const [flashOn, setFlashOn] = useState<boolean>(false);
  const [isTorchSupported, setIsTorchSupported] = useState<boolean>(false);
  const [isSimulatingFlash, setIsSimulatingFlash] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Video recording state
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recMillis, setRecMillis] = useState<number>(0);
  const recIntervalRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Auto-detect device/viewport orientation
  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;

    const mql = window.matchMedia("(orientation: landscape)");
    const apply = () => setOrientation(mql.matches ? "landscape" : "portrait");
    apply();

    const handler = (e: MediaQueryListEvent | MediaQueryList) =>
      setOrientation((e as MediaQueryList).matches ? "landscape" : "portrait");

    try {
      mql.addEventListener("change", handler as any);
    } catch {
      // Safari fallback
      (mql as any).addListener(handler as any);
    }

    const onResize = () => {
      try {
        const isLandscape = window.innerWidth >= window.innerHeight;
        setOrientation(isLandscape ? "landscape" : "portrait");
      } catch {}
    };
    window.addEventListener("resize", onResize);

    return () => {
      try {
        mql.removeEventListener("change", handler as any);
      } catch {
        (mql as any).removeListener(handler as any);
      }
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setZoom(1);
  }, [orientation, open]);

  // Initialize camera
  useEffect(() => {
    if (!open) return;

    setCameraError(null);
    setZoom(1);

    (async () => {
      try {
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
          audio: true,
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

        // Check capabilities for torch and zoom
        try {
          const track = (stream.getVideoTracks?.() || [])[0] as any;
          const caps = track?.getCapabilities?.() || {};
          const torchSupported = !!caps?.torch;
          setIsTorchSupported(torchSupported);

          const zoomSupported =
            typeof (caps as any).zoom !== "undefined" ||
            typeof (caps as any)?.zoom?.min !== "undefined";
          if (zoomSupported) {
            await track?.applyConstraints?.({ advanced: [{ zoom: 1 }] });
          }
          if (flashOn && torchSupported) {
            await track?.applyConstraints?.({ advanced: [{ torch: true }] });
          }
        } catch {}
      } catch (e: any) {
        setCameraError(e?.message || "Unable to access camera.");
        toast.error(e?.message || "Unable to access camera.");
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


  function closeCamera() {
    try {
      const stream = streamRef.current;
      stream?.getTracks()?.forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) (videoRef.current as any).srcObject = null;
    } catch {}
    onClose();
  }

  async function handleCapture(mode: CaptureMode) {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;

    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (flashOn && !isTorchSupported) {
      setIsSimulatingFlash(true);
      setTimeout(() => setIsSimulatingFlash(false), 120);
    }

    ctx.drawImage(video, 0, 0, vw, vh);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 1.0) // Maximum quality
    );
    if (!blob) return;

    const safePrefix = (downloadPrefix || "real-estate").replace(
      /[^a-zA-Z0-9_-]/g,
      "-"
    );
    const filename = `${safePrefix}-${Date.now()}.jpg`;
    const file = new File([blob], filename, { type: "image/jpeg" });

    if (mode === "main") {
      onAddMainImages([file]);
      toast.success("Main image captured!");
    } else if (mode === "extra") {
      onAddExtraImages([file]);
      toast.success("Extra image captured!");
    }
  }

  function finishAndClose() {
    closeCamera();
  }

  async function toggleFlash() {
    setFlashOn((prev) => !prev);
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks?.()[0] as any;
      if (isTorchSupported) {
        await track?.applyConstraints?.({ advanced: [{ torch: !flashOn }] });
      }
    } catch {}
  }

  function formatTimer(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60)
      .toString()
      .padStart(2, "0");
    const s = (totalSec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  async function startRecording() {
    try {
      if (!streamRef.current) return;
      if (isRecording) return;
      if (hasVideo) {
        toast.warn("Only 1 video allowed. Delete existing video first.");
        return;
      }

      recordedChunksRef.current = [];
      const mimeCandidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ];
      let chosen: string | undefined;
      for (const m of mimeCandidates) {
        if (
          (window as any).MediaRecorder &&
          (MediaRecorder as any).isTypeSupported?.(m)
        ) {
          chosen = m;
          break;
        }
      }
      const mr = new MediaRecorder(
        streamRef.current,
        chosen ? { mimeType: chosen } : undefined
      );
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        if (recordedChunksRef.current.length) {
          const blob = new Blob(recordedChunksRef.current, {
            type: mr.mimeType || "video/webm",
          });
          const safePrefix = (downloadPrefix || "real-estate").replace(
            /[^a-zA-Z0-9_-]/g,
            "-"
          );
          const ext =
            mr.mimeType && mr.mimeType.includes("mp4") ? ".mp4" : ".webm";
          const file = new File([blob], `${safePrefix}-${Date.now()}${ext}`, {
            type: mr.mimeType || "video/webm",
          });
          onAddVideo(file);
          toast.success("Video recorded!");
        }
      };
      mr.start(250);
      setIsRecording(true);
      setRecMillis(0);
      const startedAt = Date.now();
      recIntervalRef.current = setInterval(
        () => setRecMillis(Date.now() - startedAt),
        250
      );
    } catch (e: any) {
      toast.error(e?.message || "Unable to start recording");
    }
  }

  function stopRecording() {
    try {
      if (!isRecording) return;
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") mr.stop();
    } catch {}
    setIsRecording(false);
    if (recIntervalRef.current) {
      clearInterval(recIntervalRef.current);
      recIntervalRef.current = null;
    }
  }

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90 overflow-hidden touch-none overscroll-contain select-none">
      <div className="relative w-full h-full max-w-none max-h-full overflow-hidden flex flex-col rounded-none border-0 bg-black/30 ring-0 shadow-none">
        <div className="relative flex-1 min-h-0 bg-black" ref={cameraViewRef}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 h-full w-full object-cover pointer-events-none"
            style={
              zoom > 1
                ? { transform: `scale(${zoom})`, transformOrigin: "center" }
                : undefined
            }
          />
          {isSimulatingFlash && (
            <div className="absolute inset-0 bg-[var(--app-panel)] animate-pulse" />
          )}

          {/* Top Bar */}
          <div
            className="pointer-events-auto absolute top-0 left-0 right-0 z-30 flex flex-row items-center px-2 text-white  bg-black/40"
            style={{
              paddingTop: "calc(env(safe-area-inset-top) + 6px)",
              paddingBottom: "6px",
            }}
          >
            {orientation === "portrait" ? (
              <div className="sm:hidden flex flex-col w-full gap-0.5">
                <div className="flex items-center justify-between w-full">
                  <button
                    type="button"
                    onClick={finishAndClose}
                    className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)] shrink-0"
                    title="Exit"
                  >
                    <X className="h-5 w-5" />
                    <span className="text-[14px] leading-none font-medium whitespace-nowrap">
                      Exit
                    </span>
                  </button>
                  <div className="flex items-center justify-end gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={toggleFlash}
                      className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
                      title="Flash"
                    >
                      {flashOn ? (
                        <Zap className="h-5 w-5 text-yellow-300" />
                      ) : (
                        <ZapOff className="h-5 w-5" />
                      )}
                      <span className="text-[12px]">
                        {flashOn ? "On" : "Off"}
                      </span>
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 text-center text-[12px] font-medium truncate">
                  Main: {mainImageCount} | Extra: {extraImageCount}
                  {isRecording && (
                    <>
                      {" | "}REC {formatTimer(recMillis)}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-row flex-nowrap items-center justify-between gap-2 w-full">
                <button
                  type="button"
                  onClick={finishAndClose}
                  className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)] shrink-0"
                  title="Exit"
                >
                  <X className="h-5 w-5" />
                  <span className="text-[14px] leading-none font-medium whitespace-nowrap">
                    Exit
                  </span>
                </button>
                <div className="min-w-0 flex-1 text-center overflow-hidden px-2">
                  <span
                    className="block truncate whitespace-nowrap leading-none font-semibold tracking-tight"
                    style={{ fontSize: "clamp(14px, 3vw, 18px)" }}
                  >
                    Main: {mainImageCount} | Extra: {extraImageCount}
                    {isRecording && ` | REC ${formatTimer(recMillis)}`}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={toggleFlash}
                    className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)] whitespace-nowrap"
                    title="Flash"
                  >
                    {flashOn ? (
                      <Zap className="h-5 w-5 text-yellow-300" />
                    ) : (
                      <ZapOff className="h-5 w-5" />
                    )}
                    <span className="text-[13px] leading-none whitespace-nowrap">
                      {flashOn ? "On" : "Off"}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Landscape: Right side controls */}
          {orientation === "landscape" && (
            <div
              className="pointer-events-auto absolute right-0 z-30 flex flex-col gap-0.5 py-1 overflow-y-auto"
              style={{
                top: "calc(env(safe-area-inset-top) + 45px)",
                bottom: "max(env(safe-area-inset-bottom), 4px)",
                maxHeight:
                  "calc(100vh - env(safe-area-inset-top) - max(env(safe-area-inset-bottom), 4px) - 45px)",
              }}
            >
              {/* Zoom */}
              <div className="flex items-center gap-1 rounded-lg bg-black/40 px-1.5 py-0.5 ring-1 ring-white/10  flex-shrink-0">
                <ZoomOut className="h-3 w-3 text-white/90" />
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={0.1}
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  className="w-[65px] accent-blue-500 cursor-pointer text-[16px]"
                />
                <ZoomIn className="h-3 w-3 text-white/90" />
                <div className="w-6 text-right text-[9px] text-white/90">
                  {zoom.toFixed(1)}x
                </div>
              </div>

              {/* Capture buttons */}
              <div className="flex items-stretch gap-0.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => handleCapture("main")}
                  className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center gap-0.5 rounded-full bg-[var(--app-panel)] from-blue-500/60 to-blue-600/60 text-[9px] font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400/60 hover:to-blue-600/60"
                  title="Capture Main"
                >
                  <Camera className="h-3 w-3" />
                  <span className="whitespace-nowrap">Main</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleCapture("extra")}
                  className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center rounded-full bg-[var(--app-panel)] from-blue-500/60 to-blue-600/60 text-[9px] font-semibold text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400/60 hover:to-blue-600/60"
                  title="Capture Extra"
                >
                  <span className="whitespace-nowrap">Extra</span>
                </button>
              </div>

              {/* Video button */}
              <button
                type="button"
                disabled={hasVideo && !isRecording}
                onClick={() => {
                  if (isRecording) {
                    stopRecording();
                  } else {
                    startRecording();
                  }
                }}
                className={`h-9 w-full flex-shrink-0 inline-flex cursor-pointer items-center justify-center rounded-full px-1.5 text-[9px] font-semibold ring-1 ring-white/10 ${
                  isRecording
                    ? "bg-yellow-600/60 text-white hover:bg-yellow-700/60"
                    : "bg-yellow-500/60 text-white hover:bg-yellow-600/60"
                } ${
                  hasVideo && !isRecording
                    ? "opacity-50 cursor-not-allowed"
                    : ""
                }`}
                title={isRecording ? "Stop Recording" : "Start Recording"}
              >
                {isRecording ? "Stop" : "Video"}
              </button>

              {/* Done button */}
              <button
                type="button"
                onClick={finishAndClose}
                className="h-9 w-full inline-flex items-center justify-center gap-1 rounded-xl bg-[var(--app-panel)] from-blue-500/60 to-blue-600/60 text-white shadow-sm ring-2 ring-blue-300/30 hover:from-blue-400/60 hover:to-blue-600/60 active:translate-y-0.5 active:shadow-sm focus:outline-none cursor-pointer flex-shrink-0"
              >
                <Check className="h-3.5 w-3.5" />
                <span className="text-[10px] font-bold">Done</span>
              </button>
            </div>
          )}

          {/* Portrait: Bottom controls */}
          {orientation !== "landscape" && (
            <div
              ref={bottomControlsRef}
              className="pointer-events-auto absolute inset-x-0 z-20 border-t border-white/10 bg-black/40 px-2 sm:px-3 py-2 "
              style={{
                bottom: 0,
                paddingBottom: "calc(env(safe-area-inset-bottom) + 6px)",
              }}
            >
              <div className="mx-auto w-full max-w-[560px] sm:max-w-[780px]">
                {/* Zoom */}
                <div className="mb-1 flex items-center gap-2 rounded-lg bg-[var(--app-panel)] px-2 py-1 ring-1 ring-white/15 ">
                  <ZoomOut className="h-3.5 w-3.5 text-white/90" />
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={0.1}
                    value={zoom}
                    onChange={(e) => setZoom(parseFloat(e.target.value))}
                    className="flex-1 min-w-[100px] accent-blue-500 cursor-pointer text-[16px]"
                  />
                  <ZoomIn className="h-3.5 w-3.5 text-white/90" />
                  <div className="ml-2 w-8 text-right text-[10px] text-white/90">
                    {zoom.toFixed(1)}x
                  </div>
                </div>

                {/* Main Done button */}
                <div className="grid items-center gap-2 w-full grid-cols-[1fr_80px_1fr] mb-2">
                  <div></div>
                  <button
                    type="button"
                    onClick={finishAndClose}
                    className="h-12 sm:h-14 w-full inline-flex items-center justify-center rounded-lg bg-[var(--app-panel)] from-blue-500 to-blue-600 text-white shadow-sm ring-2 ring-blue-300/60 hover:from-blue-400 hover:to-blue-600 active:translate-y-0.5 active:shadow-sm focus:outline-none cursor-pointer"
                  >
                    <Check className="h-7 w-7" />
                  </button>
                  <div></div>
                </div>

                {/* Capture buttons */}
                <div className="grid grid-cols-3 gap-2 w-full">
                  <button
                    type="button"
                    onClick={() => handleCapture("main")}
                    className="h-12 inline-flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl bg-[var(--app-panel)] from-blue-500 to-blue-600 text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
                    title="Capture Main"
                  >
                    <Camera className="h-6 w-6" />
                    <span className="text-[11px] font-bold">Main</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCapture("extra")}
                    className="h-12 inline-flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl bg-[var(--app-panel)] from-blue-500 to-blue-600 text-white shadow-sm transition active:translate-y-0.5 active:shadow-sm hover:from-blue-400 hover:to-blue-600"
                    title="Capture Extra"
                  >
                    <Camera className="h-6 w-6" />
                    <span className="text-[11px] font-bold">Extra</span>
                  </button>
                  <button
                    type="button"
                    disabled={hasVideo && !isRecording}
                    onClick={() => {
                      if (isRecording) {
                        stopRecording();
                      } else {
                        startRecording();
                      }
                    }}
                    className={`h-12 inline-flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl px-2 text-white shadow-sm ring-1 ring-white/20 ${
                      isRecording
                        ? "bg-red-700 hover:bg-red-800"
                        : "bg-yellow-600 hover:bg-yellow-500"
                    } ${
                      hasVideo && !isRecording
                        ? "opacity-50 cursor-not-allowed"
                        : ""
                    }`}
                    title={
                      isRecording
                        ? "Stop Recording"
                        : hasVideo
                        ? "Video limit reached"
                        : "Start Recording"
                    }
                  >
                    {isRecording ? (
                      <>
                        <Square className="h-6 w-6 fill-white" />
                        <span className="text-[11px] font-bold">Stop</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-6 w-6" />
                        <span className="text-[11px] font-bold">Video</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

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
  );
}
