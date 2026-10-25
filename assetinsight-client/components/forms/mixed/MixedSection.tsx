"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "@/components/ui/toast";
import {
  Plus,
  Trash2,
  Camera,
  Upload,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Zap,
  ZapOff,
  Check,
  X,
  Download,
  Lock,
  Unlock,
  FileImage,
  MoreHorizontal,
  RotateCcw,
  Video,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  ListItemIcon,
  Menu,
  MenuItem,
} from "@/components/ui/legacy";
import type { AnnBox } from "./ImageAnnotator";
import { ImageMediaCard, VideoMediaCard } from "./MediaCard";
import { getMixedFileKey } from "./types";
import type { CameraLens, MixedLot, MixedMode } from "./types";

export { getMixedFileKey } from "./types";
export type { CameraLens, MixedLot, MixedMode } from "./types";

const ImageAnnotator = dynamic(() => import("./ImageAnnotator"), {
  ssr: false,
});

const IMAGE_UPLOAD_ACCEPT = "image/*,.heic,.heif,image/heic,image/heif";
const MODE_OPTIONS: Array<{
  value: MixedMode;
  label: string;
  description: string;
}> = [
  {
    value: "single_lot",
    label: "Bundle",
    description: "Value the photos together as one lot.",
  },
  {
    value: "per_item",
    label: "Per item",
    description: "Group multiple photos around each item.",
  },
  {
    value: "per_photo",
    label: "Per photo",
    description: "Treat every main photo as a separate item.",
  },
];

function getModeLabel(mode?: MixedMode) {
  return MODE_OPTIONS.find((option) => option.value === mode)?.label || "Mode required";
}

type Props = {
  value: MixedLot[];
  onChange: (lots: MixedLot[]) => void;
  maxImagesPerLot?: number; // No storage limit; backend applies mode-specific AI caps.
  maxExtraImagesPerLot?: number; // No limit
  maxTotalImages?: number; // No limit
  downloadPrefix?: string; // optional: used for saving captured images locally
  actionButtons?: React.ReactNode; // Extra action buttons to show in toolbar
  onImageCapture?: () => void; // Callback when image is captured/added (for auto-save)
  allowVideo?: boolean;
  analysisImageLimit?: number;
  /**
   * The lots in this form map to upstream Schedule A lines.
   *
   * It does NOT mean the lot list is fixed. An added lot inherits its parent's
   * identity and records parentKey; a lot Auctioneer sent is refused deletion
   * through its own source.locked, not through this.
   */
  sourceMappedLots?: boolean;
};

type RemovedMedia = {
  lotId: string;
  kind: "main" | "extra" | "video";
  index: number;
  file: File;
  coverIndex?: number;
  annotations?: AnnBox[];
};
export default function MixedSection({
  value,
  onChange,
  maxImagesPerLot = Number.MAX_SAFE_INTEGER,
  maxExtraImagesPerLot = Number.MAX_SAFE_INTEGER, // Unlimited
  maxTotalImages = Number.MAX_SAFE_INTEGER, // Unlimited
  downloadPrefix,
  actionButtons,
  onImageCapture,
  allowVideo = true,
  analysisImageLimit,
  sourceMappedLots = false,
}: Props) {
  const [lots, setLots] = useState<MixedLot[]>(value || []);
  const lotsRef = useRef<MixedLot[]>(value || []);
  const onChangeRef = useRef(onChange);
  const [activeIdx, setActiveIdx] = useState<number>(
    value?.length ? value.length - 1 : -1
  );
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [removeLotPendingId, setRemoveLotPendingId] = useState<string | null>(null);
  const [removedMedia, setRemovedMedia] = useState<RemovedMedia | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitLots = useCallback(
    (updater: MixedLot[] | ((current: MixedLot[]) => MixedLot[])) => {
      const current = lotsRef.current;
      const next =
        typeof updater === "function" ? updater(current) : updater;
      if (next === current) return;
      lotsRef.current = next;
      setLots(next);
      onChangeRef.current(next);
    },
    []
  );

  // Camera overlay state
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Track files captured in this camera session for zipping on Done
  const sessionFilesRef = useRef<File[]>([]);
  const [zoom, setZoom] = useState<number>(1);
  const [flashOn, setFlashOn] = useState<boolean>(false);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "portrait"
  );
  const [isTorchSupported, setIsTorchSupported] = useState<boolean>(false);
  const [isSimulatingFlash, setIsSimulatingFlash] = useState<boolean>(false);
  // Camera lens selection (ultra-wide 0.5x, main 1x, telephoto 2x+)
  const [availableLenses, setAvailableLenses] = useState<CameraLens[]>([]);
  const [selectedLens, setSelectedLens] = useState<string>(""); // deviceId
  const [focusOn, setFocusOn] = useState<boolean>(false);
  const FOCUS_BOX_FRACTION = 0.62; // fraction of min(image width/height)
  const [focusBoxFrac, setFocusBoxFrac] = useState<number>(0.62);
  const [focusBoxFW, setFocusBoxFW] = useState<number>(0.62);
  const [focusBoxFH, setFocusBoxFH] = useState<number>(0.62);
  const [focusBoxCX, setFocusBoxCX] = useState<number>(0.5);
  const [focusBoxCY, setFocusBoxCY] = useState<number>(0.5);
  const pinchStateRef = useRef<{
    active: boolean;
    startDist: number;
    startFW: number;
    startFH: number;
  } | null>(null);
  const [focusLockAR, setFocusLockAR] = useState<boolean>(false);
  const focusARRef = useRef<number>(1);
  const dragStateRef = useRef<{
    type: "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
    startX: number;
    startY: number;
    startCx: number;
    startCy: number;
    startW: number;
    startH: number;
    anchorX: number;
    anchorY: number;
    startCornerX: number;
    startCornerY: number;
  } | null>(null);
  const bottomControlsRef = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState<number>(0);
  const cameraViewRef = useRef<HTMLDivElement>(null);
  const [cameraViewSize, setCameraViewSize] = useState<{
    w: number;
    h: number;
  }>({ w: 0, h: 0 });
  const [videoAR, setVideoAR] = useState<number | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extraFileInputRef = useRef<HTMLInputElement>(null);
  const videoUploadInputRef = useRef<HTMLInputElement>(null);
  // Video recording state
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recMillis, setRecMillis] = useState<number>(0);
  const recIntervalRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  // Image annotation editor state
  const [editing, setEditing] = useState<{
    lotIdx: number;
    imgIdx: number;
    url: string;
  } | null>(null);

  // Format file size helper
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const next = value || [];
    lotsRef.current = next;
    setLots(next);
    setActiveIdx((current) => {
      if (!next.length) return -1;
      if (current < 0) return 0;
      return Math.min(current, next.length - 1);
    });
  }, [value]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Removed: no re-applying constraints or zoom reset on orientation change; UI only adapts

  // Auto-detect device/viewport orientation while camera is open
  useEffect(() => {
    if (!cameraOpen) return;
    if (typeof window === "undefined") return;
    // Prefer Media Query orientation
    const mql = window.matchMedia("(orientation: landscape)");
    const apply = () => setOrientation(mql.matches ? "landscape" : "portrait");
    apply();
    const handler = (e: MediaQueryListEvent | MediaQueryList) =>
      setOrientation((e as MediaQueryList).matches ? "landscape" : "portrait");
    try {
      mql.addEventListener("change", handler as any);
    } catch {
      // Safari
      // @ts-ignore
      mql.addListener(handler as any);
    }
    // Fallback to window resize heuristic Required
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
        // @ts-ignore
        mql.removeListener(handler as any);
      }
      window.removeEventListener("resize", onResize);
    };
  }, [cameraOpen]);

  useEffect(() => {
    if (!cameraOpen) return;
    setZoom(1);
  }, [orientation, cameraOpen]);

  // Measure bottom controls height to keep focus box fully visible above it
  useEffect(() => {
    if (!cameraOpen) {
      setControlsHeight(0);
      return;
    }
    const measure = () => {
      try {
        const el = bottomControlsRef.current;
        const h = el ? el.offsetHeight || 0 : 0;
        setControlsHeight(h);
      } catch {}
    };
    measure();
    let ro: ResizeObserver | null = null;
    try {
      // @ts-ignore - ResizeObserver available in browser
      ro = new ResizeObserver(measure);
      if (bottomControlsRef.current) ro.observe(bottomControlsRef.current);
    } catch {}
    window.addEventListener("resize", measure);
    return () => {
      try {
        ro?.disconnect();
      } catch {}
      window.removeEventListener("resize", measure);
    };
  }, [cameraOpen, orientation]);

  useEffect(() => {
    if (!cameraOpen) {
      setCameraViewSize({ w: 0, h: 0 });
      return;
    }
    const measure = () => {
      try {
        const el = cameraViewRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setCameraViewSize({ w: Math.round(r.width), h: Math.round(r.height) });
      } catch {}
    };
    measure();
    let ro: ResizeObserver | null = null;
    try {
      // @ts-ignore
      ro = new ResizeObserver(measure);
      if (cameraViewRef.current) ro.observe(cameraViewRef.current);
    } catch {}
    window.addEventListener("resize", measure);
    return () => {
      try {
        ro?.disconnect();
      } catch {}
      window.removeEventListener("resize", measure);
    };
  }, [cameraOpen, orientation]);

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      try {
        const stream = videoRef.current?.srcObject as MediaStream | null;
        stream?.getTracks()?.forEach((t) => t.stop());
        if (videoRef.current) (videoRef.current as any).srcObject = null;
      } catch {}
    };
  }, []);

  function createLot() {
    const id = `lot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    /*
       On a source-mapped form the new lot is a SPLIT of the lot being worked
       on, not a free-standing one: Auctioneer named that line and has to be
       able to place whatever comes back against it. The parent's identity is
       carried across and parentKey records where it came from, while the new
       lot takes its own key so nothing downstream collides.

       A split of a split still points at the ORIGINAL line — parentKey first,
       then key — so the chain never grows past one level and Auctioneer always
       receives a reference to something it actually sent.

       locked is deliberately false: the lot Auctioneer sent stays undeletable,
       one the appraiser created is theirs to discard.
    */
    const parent = sourceMappedLots ? lotsRef.current[activeIdx]?.source : undefined;
    const parentKey = parent?.parentKey || parent?.key;
    if (sourceMappedLots && !parentKey) return;
    const source: MixedLot["source"] | undefined = parentKey
      ? {
          key: `${parentKey}:split:${id}`,
          parentKey,
          lotId: parent?.lotId,
          submissionId: parent?.submissionId,
          label: parent?.label ? `${parent.label} — added lot` : "Added lot",
          locked: false,
        }
      : undefined;
    const next: MixedLot[] = [
      ...lotsRef.current,
      { id, source, ...(sourceMappedLots ? { mode: "single_lot" as const } : {}), files: [], extraFiles: [], videoFiles: [], coverIndex: 0 },
    ];
    commitLots(next);
    setActiveIdx(next.length - 1);
  }


  function removeLot(lotId: string) {
    const idx = lotsRef.current.findIndex((lot) => lot.id === lotId);
    if (idx < 0) {
      setRemoveLotPendingId(null);
      return;
    }
    // Per lot, not per form: a lot Auctioneer sent may never be deleted, but
    // one the appraiser split out of it may.
    if (lotsRef.current[idx]?.source?.locked) return;
    const next = lotsRef.current.filter((_, i) => i !== idx);
    commitLots(next);
    setActiveIdx((current) => {
      if (!next.length) return -1;
      if (current > idx) return current - 1;
      if (current === idx) return Math.min(idx, next.length - 1);
      return current;
    });
    setRemoveLotPendingId(null);
  }

  function setLotMode(idx: number, mode: MixedMode) {
    commitLots((prev) => {
      const out = [...prev];
      const lot = out[idx];
      if (!lot) return prev;
      if (lot.source?.locked) return prev;
      if (lot.mode && lot.mode !== mode && lot.files.length > 0) {
        toast.warn("Cannot change mode after images are added to this lot.");
        return prev;
      }
      out[idx] = { ...lot, mode };
      return out;
    });
  }

  const getLotPhotoCount = (lot: MixedLot) =>
    lot.files.length + (lot.extraFiles || []).length;

  function limitIncomingForLot(
    lot: MixedLot,
    incoming: File[],
    isExtra: boolean
  ) {
    const remainingByLot = Math.max(0, maxTotalImages - getLotPhotoCount(lot));
    const remainingByBucket = Math.max(
      0,
      (isExtra ? maxExtraImagesPerLot : maxImagesPerLot) -
        (isExtra ? (lot.extraFiles || []).length : lot.files.length)
    );
    const allowed = Math.min(incoming.length, remainingByLot, remainingByBucket);
    if (allowed < incoming.length) {
      toast.warn(
        `This lot can accept ${allowed} more photo(s). Maximum ${maxTotalImages} total photos per lot.`
      );
    }
    return incoming.slice(0, allowed);
  }

  function addFilesToLot(idx: number, incoming: File[]) {
    commitLots((prev) => {
      const out = [...prev];
      const lot = out[idx];
      if (!lot) return prev;
      if (!lot.mode) {
        toast.warn("Select a mode for this lot first.");
        return prev;
      }
      const accepted = limitIncomingForLot(lot, incoming, false);
      if (!accepted.length) return prev;
      out[idx] = { ...lot, files: [...lot.files, ...accepted] };
      return out;
    });
  }

  // Add files and set mode in one atomic update when capturing via camera
  function addFilesToLotWithMode(
    idx: number,
    incoming: File[],
    _selectedMode?: MixedMode,
    isExtra: boolean = false
  ) {
    commitLots((prev) => {
      const out = [...prev];
      const lot = out[idx];
      if (!lot) return prev;
      if (!lot.mode) {
        toast.warn("Select a mode for this lot first.");
        return prev;
      }

      if (isExtra) {
        const current = out[idx];
        const accepted = limitIncomingForLot(current, incoming, true);
        if (!accepted.length) return prev;
        out[idx] = {
          ...current,
          extraFiles: [...current.extraFiles, ...accepted],
        };
        // Trigger auto-save callback
        setTimeout(() => onImageCapture?.(), 0);
        return out;
      }

      // Main files handling
      const current = out[idx];
      const accepted = limitIncomingForLot(current, incoming, false);
      if (!accepted.length) return prev;
      out[idx] = { ...current, files: [...current.files, ...accepted] };
      // Trigger auto-save callback
      setTimeout(() => onImageCapture?.(), 0);
      return out;
    });
  }

  // Videos: report-only, per-lot
  function addVideosToLot(idx: number, incoming: File[]) {
    commitLots((prev) => {
      const out = [...prev];
      const lot = out[idx];
      if (!lot) return prev;
      if (!allowVideo || !lot.mode) {
        if (!lot.mode) toast.warn("Select a mode for this lot first.");
        return prev;
      }
      const videoFiles = [...(lot.videoFiles || []), ...incoming];
      out[idx] = { ...lot, videoFiles } as MixedLot;
      return out;
    });
  }

  function queueUndo(item: RemovedMedia) {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setRemovedMedia(item);
    undoTimerRef.current = setTimeout(() => {
      setRemovedMedia(null);
      undoTimerRef.current = null;
    }, 8000);
  }

  function removeVideo(idx: number, vidIdx: number) {
    const lot = lotsRef.current[idx];
    const file = lot?.videoFiles?.[vidIdx];
    if (!lot || !file) return;
    commitLots((prev) => {
      const out = [...prev];
      const current = out[idx];
      if (!current) return prev;
      const videoFiles = (current.videoFiles || []).filter((_, i) => i !== vidIdx);
      out[idx] = { ...current, videoFiles } as MixedLot;
      return out;
    });
    queueUndo({ lotId: lot.id, kind: "video", index: vidIdx, file });
  }

  function removeImage(idx: number, imgIdx: number) {
    const lot = lotsRef.current[idx];
    const fileToRemove = lot?.files?.[imgIdx];
    if (!lot || !fileToRemove) return;
    const key = getMixedFileKey(fileToRemove);
    const removedAnnotations = lot.annotations?.[key];
    commitLots((prev) => {
      const out = [...prev];
      const current = out[idx];
      if (!current) return prev;
      const files = current.files.filter((_, i) => i !== imgIdx);
      const coverIndex = files.length
        ? imgIdx < current.coverIndex
          ? current.coverIndex - 1
          : Math.min(current.coverIndex, files.length - 1)
        : 0;
      const annotations = { ...(current.annotations || {}) };
      delete annotations[key];
      out[idx] = { ...current, files, coverIndex, annotations };
      return out;
    });
    queueUndo({
      lotId: lot.id,
      kind: "main",
      index: imgIdx,
      file: fileToRemove,
      coverIndex: lot.coverIndex,
      annotations: removedAnnotations,
    });
  }

  function removeExtraImage(idx: number, imgIdx: number) {
    const lot = lotsRef.current[idx];
    const file = lot?.extraFiles?.[imgIdx];
    if (!lot || !file) return;
    commitLots((prev) => {
      const out = [...prev];
      const current = out[idx];
      if (!current) return prev;
      const extraFiles = (current.extraFiles || []).filter((_, i) => i !== imgIdx);
      out[idx] = { ...current, extraFiles } as MixedLot;
      return out;
    });
    queueUndo({ lotId: lot.id, kind: "extra", index: imgIdx, file });
  }

  function undoMediaRemoval() {
    const removed = removedMedia;
    if (!removed) return;
    commitLots((prev) => {
      const lotIdx = prev.findIndex((lot) => lot.id === removed.lotId);
      if (lotIdx < 0) return prev;
      const out = [...prev];
      const lot = out[lotIdx];
      if (removed.kind === "main") {
        const files = [...lot.files];
        files.splice(Math.min(removed.index, files.length), 0, removed.file);
        const annotations = { ...(lot.annotations || {}) };
        if (removed.annotations) {
          annotations[getMixedFileKey(removed.file)] = removed.annotations;
        }
        out[lotIdx] = {
          ...lot,
          files,
          coverIndex: Math.min(removed.coverIndex ?? lot.coverIndex, files.length - 1),
          annotations,
        };
      } else if (removed.kind === "extra") {
        const extraFiles = [...(lot.extraFiles || [])];
        extraFiles.splice(Math.min(removed.index, extraFiles.length), 0, removed.file);
        out[lotIdx] = { ...lot, extraFiles };
      } else {
        const videoFiles = [...(lot.videoFiles || [])];
        videoFiles.splice(Math.min(removed.index, videoFiles.length), 0, removed.file);
        out[lotIdx] = { ...lot, videoFiles };
      }
      return out;
    });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    setRemovedMedia(null);
  }

  function setCover(idx: number, imgIdx: number) {
    commitLots((prev) => {
      const out = [...prev];
      const lot = out[idx];
      if (!lot) return prev;
      out[idx] = { ...lot, coverIndex: imgIdx };
      return out;
    });
  }

  function openEditor(lotIdx: number, imgIdx: number) {
    try {
      const file = lots[lotIdx]?.files?.[imgIdx];
      if (!file) return;
      const url = URL.createObjectURL(file);
      setEditing({ lotIdx, imgIdx, url });
    } catch {}
  }

  function closeEditor() {
    try {
      if (editing?.url) URL.revokeObjectURL(editing.url);
    } catch {}
    setEditing(null);
  }

  function handleSaveAnnotations(boxes: AnnBox[]) {
    if (!editing) return;
    const { lotIdx, imgIdx } = editing;
    commitLots((prev) => {
      const out = [...prev];
      const lot = out[lotIdx];
      if (!lot) return prev;
      const file = lot.files?.[imgIdx];
      if (!file) return prev;
      const key = getMixedFileKey(file);
      const annotations = { ...(lot.annotations || {}) };
      annotations[key] = boxes;
      out[lotIdx] = { ...lot, annotations };
      return out;
    });
    closeEditor();
  }

  // Manual upload
  function onManualUpload(files: FileList | null) {
    if (!files) return;
    if (activeIdx < 0 || !lotsRef.current[activeIdx]?.mode) {
      toast.warn("Create a lot and select its mode before adding photos.");
      return;
    }
    const incoming = Array.from(files);
    addFilesToLot(activeIdx, incoming);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Manual upload for Extra images (report-only)
  function onManualUploadExtra(files: FileList | null) {
    if (!files) return;
    if (activeIdx < 0 || !lotsRef.current[activeIdx]?.mode) {
      toast.warn("Create a lot and select its mode before adding photos.");
      return;
    }
    const incoming = Array.from(files);
    addFilesToLotWithMode(
      activeIdx,
      incoming,
      undefined,
      true
    );
    if (extraFileInputRef.current) extraFileInputRef.current.value = "";
  }

  // Manual upload for Videos (report-only)
  function onManualUploadVideo(files: FileList | null) {
    if (!files) return;
    if (!allowVideo || activeIdx < 0 || !lotsRef.current[activeIdx]?.mode) {
      toast.warn("Create a lot and select its mode before adding video.");
      return;
    }
    const incoming = Array.from(files);
    addVideosToLot(activeIdx, incoming);
    if (videoUploadInputRef.current) videoUploadInputRef.current.value = "";
  }

  // Camera overlay logic
  async function openCamera() {
    const activeLot = lotsRef.current[activeIdx];
    if (!activeLot || !activeLot.mode) {
      toast.warn("Create a lot and select its mode before opening the camera.");
      return;
    }
    try {
      setCameraError(null);
      setZoom(1);
      sessionFilesRef.current = [];
      // Open overlay first so the <video> element mounts
      setCameraOpen(true);
      // Wait a tick to ensure portal mounts and ref is available
      await new Promise((r) => setTimeout(r, 0));
      // Determine current device orientation and sync state before requesting media
      try {
        const isLandscape =
          typeof window !== "undefined" &&
          window.matchMedia &&
          window.matchMedia("(orientation: landscape)").matches;
        setOrientation(isLandscape ? "landscape" : "portrait");
      } catch {}
      // MULTI-LENS CAMERA SUPPORT: Detect ultra-wide (0.5x), main (1x), telephoto (2x+)
      let stream: MediaStream | null = null;
      const detectedLenses: CameraLens[] = [];
      
      // Enumerate all cameras and categorize them
      try {
        // First get temporary stream to access device labels (required on some browsers)
        const tempStream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: "environment" }, 
          audio: true 
        });
        tempStream.getTracks().forEach(t => t.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === "videoinput");
        console.log("Camera: Found devices:", videoDevices.map(d => d.label));
        
        // Categorize back-facing cameras
        for (const device of videoDevices) {
          const label = (device.label || "").toLowerCase();
          
          // Skip front cameras
          if (label.includes("front") || label.includes("selfie") || label.includes("user")) {
            continue;
          }
          
          // Skip if no label and not back-facing
          if (!label && !label.includes("back") && !label.includes("rear") && !label.includes("0")) {
            continue;
          }
          
          // Detect lens type from label
          let lensType: "ultrawide" | "main" | "telephoto" = "main";
          let zoomLevel = 1;
          let displayLabel = "1x";
          
          // Ultra-wide detection (0.5x, 0.6x, ultra, wide-angle)
          if (label.includes("ultra") || label.includes("0.5") || label.includes("0.6") ||
              (label.includes("wide") && !label.includes("main"))) {
            lensType = "ultrawide";
            zoomLevel = 0.5;
            displayLabel = "0.5x";
          }
          // Telephoto detection (2x, 3x, 5x, 10x, tele, periscope, zoom)
          else if (label.includes("tele") || label.includes("periscope") ||
                   label.match(/[2-9]x/) || label.match(/10x/) || label.includes("zoom")) {
            lensType = "telephoto";
            const match = label.match(/(\d+)x/);
            zoomLevel = match ? parseInt(match[1]) : 2;
            displayLabel = `${zoomLevel}x`;
          }
          // Main camera (1x, main, back, rear, wide but not ultra-wide)
          else if (label.includes("back") || label.includes("rear") || label.includes("main") ||
                   label.includes("camera 0") || label.includes("camera0") || !label) {
            lensType = "main";
            zoomLevel = 1;
            displayLabel = "1x";
          }
          
          detectedLenses.push({
            id: device.deviceId,
            label: displayLabel,
            type: lensType,
            zoom: zoomLevel,
          });
        }
        
        // Sort: ultra-wide first, then main, then telephoto
        detectedLenses.sort((a, b) => a.zoom - b.zoom);
        
        // Remove duplicates (some devices list same camera multiple times)
        const uniqueLenses = detectedLenses.filter((lens, idx, arr) => 
          arr.findIndex(l => l.type === lens.type) === idx
        );
        
        console.log("Camera: Detected lenses:", uniqueLenses);
        setAvailableLenses(uniqueLenses);
        
        // Select main (1x) camera by default, or first available
        const mainLens = uniqueLenses.find(l => l.type === "main") || uniqueLenses[0];
        if (mainLens) {
          setSelectedLens(mainLens.id);
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: mainLens.id },
              width: { ideal: 12000 }, // Request max possible
              height: { ideal: 9000 },
            },
            audio: true,
          });
          console.log(`Camera: Using ${mainLens.label} lens`);
        }
      } catch (e) {
        console.log("Camera: Lens detection failed", e);
      }
      
      // Fallback if lens detection failed
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: "environment",
              width: { ideal: 4032 },
              height: { ideal: 3024 },
            },
            audio: true,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
            audio: true,
          });
        }
      }
      
      if (!stream) throw new Error("Could not access camera");
      streamRef.current = stream;
      
      // MAXIMIZE QUALITY: Full sensor resolution, no zoom, continuous focus
      try {
        const track = stream.getVideoTracks()[0];
        if (track) {
          const capabilities = track.getCapabilities?.() as any;
          console.log("Camera capabilities:", capabilities);
          
          // Force zoom to MINIMUM (1x for main, 0.5x for ultra-wide)
          if (capabilities?.zoom) {
            const minZoom = capabilities.zoom.min || 1;
            try {
              await track.applyConstraints({ 
                advanced: [{ zoom: minZoom } as any] 
              });
              console.log(`Camera: Zoom set to ${minZoom}x (minimum)`);
            } catch (e) {
              console.log("Camera: Could not set zoom", e);
            }
          }
          
          // Apply MAXIMUM sensor resolution for best quality
          if (capabilities?.width?.max && capabilities?.height?.max) {
            try {
              await track.applyConstraints({
                width: { exact: capabilities.width.max },
                height: { exact: capabilities.height.max },
              });
              console.log(`Camera: Full resolution ${capabilities.width.max}x${capabilities.height.max}`);
            } catch {
              // Try ideal if exact fails
              try {
                await track.applyConstraints({
                  width: { ideal: capabilities.width.max },
                  height: { ideal: capabilities.height.max },
                });
              } catch {}
            }
          }
          
          // Enable continuous autofocus
          if (capabilities?.focusMode?.includes?.("continuous")) {
            try {
              await track.applyConstraints({
                advanced: [{ focusMode: "continuous" } as any]
              });
            } catch {}
          }
          
          // Log final settings
          const finalSettings = track.getSettings?.() as any;
          console.log("Camera final:", {
            resolution: `${finalSettings?.width}x${finalSettings?.height}`,
            zoom: finalSettings?.zoom,
          });
        }
      } catch (e) {
        console.log("Camera: Optimization error", e);
      }
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream as any;
        await videoRef.current.play().catch(() => {});
      }
      
      // Torch capabilities (zoom already handled above)
      try {
        const track = (stream.getVideoTracks?.() || [])[0] as any;
        const caps = track?.getCapabilities?.() || {};
        const torchSupported = !!caps?.torch;
        setIsTorchSupported(torchSupported);
        if (flashOn && torchSupported) {
          await track?.applyConstraints?.({ advanced: [{ torch: true }] });
        }
      } catch {}

    } catch (e: any) {
      setCameraError(e?.message || "Unable to access camera.");
      toast.error(e?.message || "Unable to access camera.");
      // Ensure overlay is closed and stream cleared on failure
      closeCamera();
    }
  }

  function closeCamera() {
    setCameraOpen(false);
    setAvailableLenses([]);
    setSelectedLens("");
    try {
      const tracks = streamRef.current?.getTracks();
      tracks?.forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) (videoRef.current as any).srcObject = null;
    } catch {}
  }

  // Switch to a different camera lens (ultra-wide, main, telephoto)
  async function switchLens(lens: CameraLens) {
    if (lens.id === selectedLens) return;
    
    try {
      // Stop current stream
      streamRef.current?.getTracks().forEach(t => t.stop());
      
      // Start new stream with selected lens
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: lens.id },
          width: { ideal: 12000 },
          height: { ideal: 9000 },
        },
        audio: true,
      });
      
      streamRef.current = newStream;
      setSelectedLens(lens.id);
      
      // Optimize the new stream
      const track = newStream.getVideoTracks()[0];
      if (track) {
        const capabilities = track.getCapabilities?.() as any;
        
        // Force minimum zoom
        if (capabilities?.zoom) {
          const minZoom = capabilities.zoom.min || 1;
          await track.applyConstraints({ 
            advanced: [{ zoom: minZoom } as any] 
          }).catch(() => {});
        }
        
        // Apply max resolution
        if (capabilities?.width?.max && capabilities?.height?.max) {
          await track.applyConstraints({
            width: { ideal: capabilities.width.max },
            height: { ideal: capabilities.height.max },
          }).catch(() => {});
        }
        
        // Continuous focus
        if (capabilities?.focusMode?.includes?.("continuous")) {
          await track.applyConstraints({
            advanced: [{ focusMode: "continuous" } as any]
          }).catch(() => {});
        }
        
        const settings = track.getSettings?.() as any;
        console.log(`Camera: Switched to ${lens.label}`, {
          resolution: `${settings?.width}x${settings?.height}`,
          zoom: settings?.zoom,
        });
      }
      
      // Update video element
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        await videoRef.current.play().catch(() => {});
      }
      
      // Check torch support on new camera
      const newTrack = newStream.getVideoTracks()[0];
      const caps = newTrack?.getCapabilities?.() as any;
      setIsTorchSupported(!!caps?.torch);
      
      // Reset digital zoom
      setZoom(1);
      
    } catch (e) {
      console.error("Camera: Failed to switch lens", e);
      toast.error("Failed to switch camera lens");
    }
  }

  async function finishAndClose() {
    closeCamera();
  }

  // Recording helpers
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
          const idx = activeIdx < 0 ? 0 : activeIdx;
          const safePrefix = (downloadPrefix || "asset").replace(
            /[^a-zA-Z0-9_-]/g,
            "-"
          );
          const lotLabel = String(idx + 1).padStart(2, "0");
          const ext =
            mr.mimeType && mr.mimeType.includes("mp4") ? ".mp4" : ".webm";
          const file = new File(
            [blob],
            `${safePrefix}-lot-${lotLabel}-${Date.now()}${ext}`,
            { type: mr.mimeType || "video/webm" }
          );
          addVideosToLot(idx, [file]);
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

  type DragType = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  function startDrag(type: DragType, e: React.PointerEvent | PointerEvent) {
    try {
      const dispW = cameraViewSize.w;
      const dispH = cameraViewSize.h;
      if (!(dispW > 0 && dispH > 0)) return;
      const minDisp = Math.min(dispW, dispH);
      const startW = Math.round(
        (typeof focusBoxFW === "number"
          ? focusBoxFW
          : focusBoxFrac || FOCUS_BOX_FRACTION) * Math.max(1, dispW)
      );
      const startH = Math.round(
        (typeof focusBoxFH === "number"
          ? focusBoxFH
          : focusBoxFrac || FOCUS_BOX_FRACTION) * Math.max(1, dispH)
      );
      const cx = Math.round(
        (typeof focusBoxCX === "number" ? focusBoxCX : 0.5) * dispW
      );
      const cy = Math.round(
        (typeof focusBoxCY === "number" ? focusBoxCY : 0.5) * dispH
      );
      let anchorX = cx;
      let anchorY = cy;
      let startCornerX = cx;
      let startCornerY = cy;
      const halfW = startW / 2;
      const halfH = startH / 2;
      switch (type) {
        case "ne":
          anchorX = cx - halfW;
          anchorY = cy + halfH;
          startCornerX = cx + halfW;
          startCornerY = cy - halfH;
          break;
        case "nw":
          anchorX = cx + halfW;
          anchorY = cy + halfH;
          startCornerX = cx - halfW;
          startCornerY = cy - halfH;
          break;
        case "se":
          anchorX = cx - halfW;
          anchorY = cy - halfH;
          startCornerX = cx + halfW;
          startCornerY = cy + halfH;
          break;
        case "sw":
          anchorX = cx + halfW;
          anchorY = cy - halfH;
          startCornerX = cx - halfW;
          startCornerY = cy + halfH;
          break;
        case "n":
          anchorX = cx;
          anchorY = cy + halfH;
          startCornerX = cx;
          startCornerY = cy - halfH;
          break;
        case "s":
          anchorX = cx;
          anchorY = cy - halfH;
          startCornerX = cx;
          startCornerY = cy + halfH;
          break;
        case "e":
          anchorX = cx - halfW;
          anchorY = cy;
          startCornerX = cx + halfW;
          startCornerY = cy;
          break;
        case "w":
          anchorX = cx + halfW;
          anchorY = cy;
          startCornerX = cx - halfW;
          startCornerY = cy;
          break;
        default:
          anchorX = cx;
          anchorY = cy;
          startCornerX = cx;
          startCornerY = cy;
      }
      dragStateRef.current = {
        type,
        startX: (e as PointerEvent).clientX,
        startY: (e as PointerEvent).clientY,
        startCx: cx,
        startCy: cy,
        startW,
        startH,
        anchorX,
        anchorY,
        startCornerX,
        startCornerY,
      };
      const onMove = (ev: PointerEvent) => {
        const s = dragStateRef.current;
        if (!s) return;
        const dx = ev.clientX - s.startX;
        const dy = ev.clientY - s.startY;
        let newCx = s.startCx;
        let newCy = s.startCy;
        let newW = s.startW;
        let newH = s.startH;

        const minDim = Math.max(40, Math.floor(0.08 * minDisp));
        const maxW = Math.max(minDim, Math.floor(0.98 * dispW));
        const maxH = Math.max(minDim, Math.floor(0.98 * dispH));

        const px = s.startCornerX + dx;
        const py = s.startCornerY + dy;

        switch (s.type) {
          case "move": {
            newCx = s.startCx + dx;
            newCy = s.startCy + dy;
            newW = s.startW;
            newH = s.startH;
            let l = newCx - newW / 2;
            let t = newCy - newH / 2;
            l = Math.max(0, Math.min(dispW - newW, Math.floor(l)));
            t = Math.max(0, Math.min(dispH - newH, Math.floor(t)));
            newCx = Math.floor(l + newW / 2);
            newCy = Math.floor(t + newH / 2);
            break;
          }
          case "ne": {
            const clampedX = Math.max(0, Math.min(dispW, px));
            const clampedY = Math.max(0, Math.min(dispH, py));
            const w = Math.max(minDim, Math.min(maxW, clampedX - s.anchorX));
            const h = Math.max(minDim, Math.min(maxH, s.anchorY - clampedY));
            newW = Math.min(w, dispW - s.anchorX);
            newH = Math.min(h, s.anchorY);
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const maxWLimit = Math.min(dispW - s.anchorX, maxW);
              const maxHLimit = Math.min(s.anchorY, maxH);
              const wCand = Math.min(w, maxWLimit);
              const hCand = Math.min(h, maxHLimit);
              let wFinal = Math.max(
                minDim,
                Math.min(wCand, hCand * ar, maxWLimit, maxHLimit * ar)
              );
              let hFinal = Math.max(
                minDim,
                Math.min(hCand, wCand / ar, maxHLimit, maxWLimit / ar)
              );
              wFinal = Math.min(wFinal, hFinal * ar);
              hFinal = Math.min(hFinal, wFinal / ar);
              newW = wFinal;
              newH = hFinal;
            }
            newCx = s.anchorX + newW / 2;
            newCy = s.anchorY - newH / 2;
            break;
          }
          case "nw": {
            const clampedX = Math.max(0, Math.min(dispW, px));
            const clampedY = Math.max(0, Math.min(dispH, py));
            const w = Math.max(minDim, Math.min(maxW, s.anchorX - clampedX));
            const h = Math.max(minDim, Math.min(maxH, s.anchorY - clampedY));
            newW = Math.min(w, s.anchorX);
            newH = Math.min(h, s.anchorY);
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const maxWLimit = Math.min(s.anchorX, maxW);
              const maxHLimit = Math.min(s.anchorY, maxH);
              const wCand = Math.min(w, maxWLimit);
              const hCand = Math.min(h, maxHLimit);
              let wFinal = Math.max(
                minDim,
                Math.min(wCand, hCand * ar, maxWLimit, maxHLimit * ar)
              );
              let hFinal = Math.max(
                minDim,
                Math.min(hCand, wCand / ar, maxHLimit, maxWLimit / ar)
              );
              wFinal = Math.min(wFinal, hFinal * ar);
              hFinal = Math.min(hFinal, wFinal / ar);
              newW = wFinal;
              newH = hFinal;
            }
            newCx = s.anchorX - newW / 2;
            newCy = s.anchorY - newH / 2;
            break;
          }
          case "se": {
            const clampedX = Math.max(0, Math.min(dispW, px));
            const clampedY = Math.max(0, Math.min(dispH, py));
            const w = Math.max(minDim, Math.min(maxW, clampedX - s.anchorX));
            const h = Math.max(minDim, Math.min(maxH, clampedY - s.anchorY));
            newW = Math.min(w, dispW - s.anchorX);
            newH = Math.min(h, dispH - s.anchorY);
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const maxWLimit = Math.min(dispW - s.anchorX, maxW);
              const maxHLimit = Math.min(dispH - s.anchorY, maxH);
              const wCand = Math.min(w, maxWLimit);
              const hCand = Math.min(h, maxHLimit);
              let wFinal = Math.max(
                minDim,
                Math.min(wCand, hCand * ar, maxWLimit, maxHLimit * ar)
              );
              let hFinal = Math.max(
                minDim,
                Math.min(hCand, wCand / ar, maxHLimit, maxWLimit / ar)
              );
              wFinal = Math.min(wFinal, hFinal * ar);
              hFinal = Math.min(hFinal, wFinal / ar);
              newW = wFinal;
              newH = hFinal;
            }
            newCx = s.anchorX + newW / 2;
            newCy = s.anchorY + newH / 2;
            break;
          }
          case "sw": {
            const clampedX = Math.max(0, Math.min(dispW, px));
            const clampedY = Math.max(0, Math.min(dispH, py));
            const w = Math.max(minDim, Math.min(maxW, s.anchorX - clampedX));
            const h = Math.max(minDim, Math.min(maxH, clampedY - s.anchorY));
            newW = Math.min(w, s.anchorX);
            newH = Math.min(h, dispH - s.anchorY);
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const maxWLimit = Math.min(s.anchorX, maxW);
              const maxHLimit = Math.min(dispH - s.anchorY, maxH);
              const wCand = Math.min(w, maxWLimit);
              const hCand = Math.min(h, maxHLimit);
              let wFinal = Math.max(
                minDim,
                Math.min(wCand, hCand * ar, maxWLimit, maxHLimit * ar)
              );
              let hFinal = Math.max(
                minDim,
                Math.min(hCand, wCand / ar, maxHLimit, maxWLimit / ar)
              );
              wFinal = Math.min(wFinal, hFinal * ar);
              hFinal = Math.min(hFinal, wFinal / ar);
              newW = wFinal;
              newH = hFinal;
            }
            newCx = s.anchorX - newW / 2;
            newCy = s.anchorY + newH / 2;
            break;
          }
          case "n": {
            const clampedY = Math.max(0, Math.min(dispH, py));
            const h = Math.max(minDim, Math.min(maxH, s.anchorY - clampedY));
            newH = Math.min(h, s.anchorY);
            newW = s.startW;
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const horiz = Math.min(
                2 * Math.min(s.anchorX, dispW - s.anchorX),
                maxW
              );
              const wFromH = Math.max(minDim, Math.min(horiz, newH * ar));
              const hFromW = Math.max(minDim, Math.min(newH, wFromH / ar));
              newW = wFromH;
              newH = hFromW;
            }
            newCx = s.anchorX;
            newCy = s.anchorY - newH / 2;
            break;
          }
          case "s": {
            const clampedY = Math.max(0, Math.min(dispH, py));
            const h = Math.max(minDim, Math.min(maxH, clampedY - s.anchorY));
            newH = Math.min(h, dispH - s.anchorY);
            newW = s.startW;
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const horiz = Math.min(
                2 * Math.min(s.anchorX, dispW - s.anchorX),
                maxW
              );
              const wFromH = Math.max(minDim, Math.min(horiz, newH * ar));
              const hFromW = Math.max(minDim, Math.min(newH, wFromH / ar));
              newW = wFromH;
              newH = hFromW;
            }
            newCx = s.anchorX;
            newCy = s.anchorY + newH / 2;
            break;
          }
          case "e": {
            const clampedX = Math.max(0, Math.min(dispW, px));
            const w = Math.max(minDim, Math.min(maxW, clampedX - s.anchorX));
            newW = Math.min(w, dispW - s.anchorX);
            newH = s.startH;
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const vert = Math.min(
                2 * Math.min(s.anchorY, dispH - s.anchorY),
                maxH
              );
              const hFromW = Math.max(minDim, Math.min(vert, newW / ar));
              const wFromH = Math.max(minDim, Math.min(newW, hFromW * ar));
              newW = wFromH;
              newH = hFromW;
            }
            newCx = s.anchorX + newW / 2;
            newCy = s.anchorY;
            break;
          }
          case "w": {
            const clampedX = Math.max(0, Math.min(dispW, px));
            const w = Math.max(minDim, Math.min(maxW, s.anchorX - clampedX));
            newW = Math.min(w, s.anchorX);
            newH = s.startH;
            if (focusLockAR) {
              const ar = Math.max(0.0001, focusARRef.current || 1);
              const vert = Math.min(
                2 * Math.min(s.anchorY, dispH - s.anchorY),
                maxH
              );
              const hFromW = Math.max(minDim, Math.min(vert, newW / ar));
              const wFromH = Math.max(minDim, Math.min(newW, hFromW * ar));
              newW = wFromH;
              newH = hFromW;
            }
            newCx = s.anchorX - newW / 2;
            newCy = s.anchorY;
            break;
          }
        }

        let l = newCx - newW / 2;
        let t = newCy - newH / 2;
        l = Math.max(0, Math.min(dispW - newW, Math.floor(l)));
        t = Math.max(0, Math.min(dispH - newH, Math.floor(t)));
        newCx = Math.floor(l + newW / 2);
        newCy = Math.floor(t + newH / 2);

        setFocusBoxFW(newW / Math.max(1, dispW));
        setFocusBoxFH(newH / Math.max(1, dispH));
        setFocusBoxCX(newCx / Math.max(1, dispW));
        setFocusBoxCY(newCy / Math.max(1, dispH));
        try {
          ev.preventDefault();
        } catch {}
      };
      const onUp = () => {
        try {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        } catch {}
        dragStateRef.current = null;
      };
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp, { passive: true });
    } catch {}
  }

  // Manual per-lot ZIP download
  async function downloadLotZip(idx: number) {
    try {
      const lot = lots[idx];
      if (!lot || lot.files.length === 0) return;
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const f of lot.files) zip.file(f.name, f);
      const safePrefix = (downloadPrefix || "asset").replace(
        /[^a-zA-Z0-9_-]/g,
        "-"
      );
      const lotLabel = String(idx + 1).padStart(2, "0");
      const blob = await zip.generateAsync({ type: "blob" });
      const zipName = `${safePrefix}-lot-${lotLabel}-images-${Date.now()}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 2000);
    } catch {}
  }

  // Audio helpers for shutter
  function ensureAudioContext(): AudioContext | null {
    try {
      if (!audioCtxRef.current) {
        const Ctx: any =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return null;
        audioCtxRef.current = new Ctx();
      }
      audioCtxRef.current?.resume?.();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }

  // Simple tone helper for UI sounds
  function playBeep(
    freq: number,
    duration: number = 0.12,
    type: OscillatorType = "sine",
    vol: number = 0.25,
    delay: number = 0
  ) {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const start = ctx.currentTime + Math.max(0, delay);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(Math.max(0.001, vol), start + 0.01);
    g.gain.exponentialRampToValueAtTime(
      0.0009,
      start + Math.max(0.02, duration)
    );
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + Math.max(0.03, duration));
  }

  // Distinct sounds per action
  function playRecordStart() {
    // Low -> High
    playBeep(440, 0.12, "sine", 0.28, 0);
    playBeep(660, 0.12, "sine", 0.28, 0.12);
  }
  function playRecordStop() {
    // High -> Low
    playBeep(700, 0.12, "sine", 0.28, 0);
    playBeep(440, 0.14, "sine", 0.28, 0.12);
  }
  function playBundleSound() {
    // Two medium beeps
    playBeep(520, 0.12, "triangle", 0.24, 0);
    playBeep(520, 0.12, "triangle", 0.24, 0.12);
  }
  function playItemSound() {
    // Three short ascending beeps
    playBeep(500, 0.08, "square", 0.22, 0);
    playBeep(600, 0.08, "square", 0.22, 0.09);
    playBeep(720, 0.1, "square", 0.22, 0.18);
  }
  function playExtraSound() {
    // Single short high chirp
    playBeep(900, 0.09, "sawtooth", 0.2, 0);
  }
  function playCaptureSound(mode: MixedMode, isExtra: boolean) {
    if (isExtra) return playExtraSound();
    if (mode === "single_lot") return playBundleSound();
    if (mode === "per_item") return playItemSound();
    return playShutterClick(); // per_photo
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

  async function captureFromStream(
    selectedMode?: MixedMode,
    isExtra: boolean = false
  ) {
    const idx = activeIdx < 0 ? 0 : activeIdx;
    const lot = lots[idx];
    if (!lot) return;

    const lotPhotoCount = getLotPhotoCount(lot);
    const bucketFull = isExtra
      ? lot.extraFiles.length >= maxExtraImagesPerLot
      : lot.files.length >= maxImagesPerLot;
    if (lotPhotoCount >= maxTotalImages || bucketFull) {
      toast.warn(`This lot is at the ${maxTotalImages} photo limit.`);
      return;
    }
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    // Capture full frame; only crop when zoom > 1 to simulate digital zoom
    const cropW = vw / (zoom > 1 ? zoom : 1);
    const cropH = vh / (zoom > 1 ? zoom : 1);
    const sx = Math.max(0, (vw - cropW) / 2);
    const sy = Math.max(0, (vh - cropH) / 2);
    const outW = vw;
    const outH = vh;
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      navigator.vibrate?.(30);
    } catch {}
    if (flashOn && !isTorchSupported) {
      setIsSimulatingFlash(true);
      setTimeout(() => setIsSimulatingFlash(false), 120);
    }
    ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, outW, outH);
    if (focusOn) {
      let fw = Math.floor(
        (focusBoxFW || focusBoxFrac || FOCUS_BOX_FRACTION) * outW
      );
      let fh = Math.floor(
        (focusBoxFH || focusBoxFrac || FOCUS_BOX_FRACTION) * outH
      );
      let fx = Math.floor((outW - fw) / 2);
      let fy = Math.floor((outH - fh) / 2);
      try {
        const dispW = cameraViewSize.w;
        const dispH = cameraViewSize.h;
        if (dispW > 0 && dispH > 0 && vw > 0 && vh > 0) {
          const s = Math.max(dispW / vw, dispH / vh);
          const scaledW = vw * s;
          const scaledH = vh * s;
          const offsetX = Math.max(0, (scaledW - dispW) / 2);
          const offsetY = Math.max(0, (scaledH - dispH) / 2);
          const boxWDisp =
            (focusBoxFW || focusBoxFrac || FOCUS_BOX_FRACTION) * dispW;
          const boxHDisp =
            (focusBoxFH || focusBoxFrac || FOCUS_BOX_FRACTION) * dispH;
          fw = Math.max(1, Math.floor(boxWDisp / s));
          fh = Math.max(1, Math.floor(boxHDisp / s));
          const cxDisp =
            (typeof focusBoxCX === "number" ? focusBoxCX : 0.5) * dispW;
          const cyDisp =
            (typeof focusBoxCY === "number" ? focusBoxCY : 0.5) * dispH;
          const cxVid = (cxDisp + offsetX) / s;
          const cyVid = (cyDisp + offsetY) / s;
          fx = Math.max(0, Math.min(outW - fw, Math.floor(cxVid - fw / 2)));
          fy = Math.max(0, Math.min(outH - fh, Math.floor(cyVid - fh / 2)));
        }
      } catch {}
      ctx.save();
      ctx.lineWidth = Math.max(3, Math.floor(outW * 0.01));
      ctx.strokeStyle = "#2563eb";
      ctx.strokeRect(fx, fy, fw, fh);
      ctx.restore();
    }
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 1.0) // Maximum quality
    );
    if (!blob) return;
    const safePrefix = (downloadPrefix || "asset").replace(
      /[^a-zA-Z0-9_-]/g,
      "-"
    );
    const lotLabel = String(idx + 1).padStart(2, "0");
    const filename = `${safePrefix}-lot-${lotLabel}-${Date.now()}.jpg`;
    const file = new File([blob], filename, {
      type: "image/jpeg",
    });
    // Do not download per-shot; accumulate and zip on Done
    sessionFilesRef.current.push(file);
    addFilesToLotWithMode(idx, [file], selectedMode, isExtra);
  }

  function goPrevLot() {
    setActiveIdx((i) => Math.max(0, i - 1));
  }
  function goNextLot() {
    setActiveIdx((current) =>
      Math.min(Math.max(0, lotsRef.current.length - 1), current + 1)
    );
  }

  function handleCapture(_mode: MixedMode, isExtra: boolean = false) {
    const idx = activeIdx < 0 ? 0 : activeIdx;
    const lot = lots[idx];
    if (!lot?.mode) {
      toast.warn("Select a mode for this lot before capturing photos.");
      return;
    }
    try {
      playCaptureSound(lot.mode, isExtra);
    } catch {}
    captureFromStream(lot.mode, isExtra);
  }

  const totals = useMemo(() => {
    let main = 0;
    let extra = 0;
    let videos = 0;
    let bytes = 0;
    for (const lot of lots) {
      main += lot.files.length;
      extra += (lot.extraFiles || []).length;
      if (allowVideo) videos += (lot.videoFiles || []).length;
      for (const file of lot.files) bytes += file.size;
      for (const file of lot.extraFiles || []) bytes += file.size;
      if (allowVideo) {
        for (const file of lot.videoFiles || []) bytes += file.size;
      }
    }
    return { main, extra, videos, bytes };
  }, [allowVideo, lots]);
  const activeLot = activeIdx >= 0 ? lots[activeIdx] : undefined;
  const activeLotHasMode = Boolean(activeLot?.mode);
  const lotLabel = (lot: MixedLot, index: number) =>
    lot.source?.label ||
    (lot.source?.lotNumber ? `Lot ${lot.source.lotNumber}` : `Lot ${index + 1}`);
  return (
    <div className="@container min-w-0 space-y-4 overflow-x-hidden text-[var(--app-text)]">
      <div className="flex min-w-0 flex-col gap-3 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--app-text-muted)]">
          <span>{lots.length} {lots.length === 1 ? "lot" : "lots"}</span>
          <span>{totals.main} main</span>
          <span>{totals.extra} report-only</span>
          {allowVideo ? <span>{totals.videos} video</span> : null}
          {totals.bytes > 0 ? <span>{formatFileSize(totals.bytes)}</span> : null}
        </div>
        {/*
          Offered on both kinds now. The label differs because the act differs:
          on an Unknown contract this is a new lot outright, on a Schedule A one
          it is another lot beneath the line being worked on. It used to read
          "Source lot mapping locked", which described the mapping accurately
          and told the reader nothing about what they could do instead.
        */}
        <button
          type="button"
          onClick={createLot}
          title={
            sourceMappedLots
              ? "Add another lot beneath this Schedule A line. It is sent back against the same line."
              : "Add another lot to this contract."
          }
          className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--app-text)] px-4 py-2.5 text-sm font-semibold text-[var(--app-panel)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-2 @min-[560px]:w-auto"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {sourceMappedLots ? "Add lot to this line" : "New lot"}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_UPLOAD_ACCEPT}
        multiple
        className="sr-only"
        aria-label="Add main photos"
        onChange={(event) => onManualUpload(event.target.files)}
      />
      <input
        ref={extraFileInputRef}
        type="file"
        accept={IMAGE_UPLOAD_ACCEPT}
        multiple
        className="sr-only"
        aria-label="Add report-only photos"
        onChange={(event) => onManualUploadExtra(event.target.files)}
      />
      {allowVideo ? (
        <input
          ref={videoUploadInputRef}
          type="file"
          accept="video/*"
          multiple
          className="sr-only"
          aria-label="Add report-only videos"
          onChange={(event) => onManualUploadVideo(event.target.files)}
        />
      ) : null}

      {lots.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] px-5 py-8 text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
            <FileImage className="h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold text-[var(--app-text)]">Create your first lot</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--app-text-muted)]">
            Add a lot, choose how its photos should be analyzed, then upload files or use the camera.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 @min-[720px]:hidden">
            <button
              type="button"
              onClick={goPrevLot}
              disabled={activeIdx <= 0}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] transition hover:bg-[var(--app-panel-alt)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Previous lot"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <label className="sr-only" htmlFor="mixed-lot-select">Active lot</label>
            <select
              id="mixed-lot-select"
              value={Math.max(0, activeIdx)}
              onChange={(event) => setActiveIdx(Number(event.target.value))}
              className="min-h-11 min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm font-semibold text-[var(--app-text)] outline-none focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent-soft)]"
            >
              {lots.map((lot, index) => (
                <option key={lot.id} value={index}>
                  {lotLabel(lot, index)} · {getModeLabel(lot.mode)} · {getLotPhotoCount(lot)} {getLotPhotoCount(lot) === 1 ? "photo" : "photos"}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={goNextLot}
              disabled={activeIdx >= lots.length - 1}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] transition hover:bg-[var(--app-panel-alt)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Next lot"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="grid min-w-0 gap-4 @min-[720px]:grid-cols-[14rem_minmax(0,1fr)]">
            <aside className="hidden min-w-0 border-r border-[var(--app-border)] pr-4 @min-[720px]:block">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--app-text-muted)]">Lots</span>
                <span className="text-xs tabular-nums text-[var(--app-text-muted)]">{activeIdx + 1}/{lots.length}</span>
              </div>
              <div role="tablist" aria-label="Lots" aria-orientation="vertical" className="max-h-[34rem] space-y-1 overflow-y-auto pr-1">
                {lots.map((lot, index) => {
                  const selected = index === activeIdx;
                  return (
                    <button
                      key={lot.id}
                      id={`mixed-lot-tab-${lot.id}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls={`mixed-lot-panel-${lot.id}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setActiveIdx(index)}
                      className={`min-h-14 w-full rounded-xl border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
                        selected
                          ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)]"
                          : "border-transparent hover:border-[var(--app-border)] hover:bg-[var(--app-panel-alt)]"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-[var(--app-text)]">{lotLabel(lot, index)}</span>
                        <span className="text-[11px] tabular-nums text-[var(--app-text-muted)]">{getLotPhotoCount(lot)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--app-text-muted)]">{getModeLabel(lot.mode)}</span>
                    </button>
                  );
                })}
              </div>
            </aside>

            {activeLot ? (
              <section
                id={`mixed-lot-panel-${activeLot.id}`}
                role="tabpanel"
                aria-labelledby={`mixed-lot-tab-${activeLot.id}`}
                className="min-w-0"
              >
                <div className="flex min-w-0 flex-col gap-3 border-b border-[var(--app-border)] pb-4 @min-[560px]:flex-row @min-[560px]:items-start @min-[560px]:justify-between">
                  <div className="min-w-0">
                    <h4 className="text-base font-semibold text-[var(--app-text)]">{lotLabel(activeLot, activeIdx)}</h4>
                    {activeLot.source?.title || activeLot.source?.description ? (
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--app-text-muted)]">
                        {[activeLot.source.title, activeLot.source.description]
                          .filter(Boolean)
                          .join(" — ")}
                      </p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">
                      {activeLot.files.length} main · {(activeLot.extraFiles || []).length} report-only
                      {allowVideo ? ` · ${(activeLot.videoFiles || []).length} video` : ""}
                    </p>
                  </div>
                  <div className="flex w-full items-center gap-2 @min-[560px]:w-auto">
                    <button
                      type="button"
                      disabled={!activeLotHasMode}
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--app-on-accent)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45 @min-[560px]:flex-none"
                    >
                      <Upload className="h-4 w-4" aria-hidden="true" /> Add photos
                    </button>
                    <button
                      type="button"
                      disabled={!activeLotHasMode}
                      onClick={openCamera}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] transition hover:bg-[var(--app-panel-alt)] disabled:cursor-not-allowed disabled:opacity-45 @min-[560px]:flex-none"
                    >
                      <Camera className="h-4 w-4" aria-hidden="true" /> Camera
                    </button>
                    <button
                      type="button"
                      onClick={(event) => setMoreAnchor(event.currentTarget)}
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] transition hover:bg-[var(--app-panel-alt)]"
                      aria-label={`More actions for lot ${activeIdx + 1}`}
                      aria-haspopup="menu"
                      aria-expanded={Boolean(moreAnchor)}
                    >
                      <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <fieldset className="mt-4">
                  <legend className="text-sm font-semibold text-[var(--app-text)]">
                    Analysis mode <span className="text-[var(--app-accent)]" aria-hidden="true">*</span>
                  </legend>
                  <p className="mt-1 text-xs leading-5 text-[var(--app-text-muted)]">
                    Choose how the main photos in this lot should be interpreted.
                  </p>
                  <div role="radiogroup" className="mt-3 grid gap-2 @min-[560px]:grid-cols-3">
                    {MODE_OPTIONS.map((option) => {
                      const checked = activeLot.mode === option.value;
                      const disabled = Boolean(
                        sourceMappedLots ||
                          (activeLot.mode &&
                            !checked &&
                            activeLot.files.length > 0)
                      );
                      return (
                        <label
                          key={option.value}
                          className={`relative min-h-16 cursor-pointer rounded-xl border px-3 py-2.5 transition ${
                            checked
                              ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)]"
                              : "border-[var(--app-border)] bg-[var(--app-panel)] hover:bg-[var(--app-panel-alt)]"
                          } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                        >
                          <input
                            type="radio"
                            name={`mixed-mode-${activeLot.id}`}
                            value={option.value}
                            checked={checked}
                            disabled={disabled}
                            onChange={() => setLotMode(activeIdx, option.value)}
                            className="sr-only"
                          />
                          <span className="flex items-center gap-2 text-sm font-semibold text-[var(--app-text)]">
                            <span className={`h-3.5 w-3.5 rounded-full border ${checked ? "border-[5px] border-[var(--app-accent)]" : "border-[var(--app-text-muted)]"}`} aria-hidden="true" />
                            {option.label}
                          </span>
                          <span className="mt-1 block pl-[22px] text-[11px] leading-4 text-[var(--app-text-muted)]">{option.description}</span>
                        </label>
                      );
                    })}
                  </div>
                  {!activeLot.mode ? (
                    <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300" role="status">
                      Select a mode to enable photo and camera actions.
                    </p>
                  ) : null}
                </fieldset>

                {activeLot.mode === "single_lot" ? (
                  <div
                    className="mt-4 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2.5 text-xs leading-5 text-sky-900 dark:text-sky-100"
                    role="note"
                  >
                    Keep the lot-number card as the final main photo. Software
                    checks that final photo for the lot number. If no valid
                    number is found, lots follow their current order; you can
                    edit each number in Preview. For Bundle lots numbered 1000
                    or higher, only the first 10 main photos are analyzed for
                    asset details. All photos remain included.
                  </div>
                ) : null}

                {analysisImageLimit && activeLot.files.length > analysisImageLimit ? (
                  <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:text-amber-200" role="note">
                    At most the first {analysisImageLimit} main photos are analyzed. All {activeLot.files.length} main photos remain included in the report.
                  </div>
                ) : null}

                <div className="mt-5 space-y-6">
                  <section aria-labelledby={`main-media-${activeLot.id}`}>
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <h5 id={`main-media-${activeLot.id}`} className="text-sm font-semibold text-[var(--app-text)]">Main photos</h5>
                        <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">Used for analysis and included in the report.</p>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-[var(--app-text-muted)]">{activeLot.files.length}</span>
                    </div>
                    {activeLot.files.length ? (
                      <div className="mt-3 grid grid-cols-2 gap-3 @min-[520px]:grid-cols-3 @min-[900px]:grid-cols-4">
                        {activeLot.files.map((file, index) => {
                          const fileKey = getMixedFileKey(file);
                          return (
                            <ImageMediaCard
                              key={fileKey}
                              file={file}
                              kind="main"
                              isCover={activeLot.coverIndex === index}
                              annotationCount={(activeLot.annotations?.[fileKey] || []).length}
                              onSetCover={() => setCover(activeIdx, index)}
                              onEditFocus={() => openEditor(activeIdx, index)}
                              onRemove={() => removeImage(activeIdx, index)}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={!activeLotHasMode}
                        onClick={() => fileInputRef.current?.click()}
                        className="mt-3 flex min-h-32 w-full flex-col items-center justify-center rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] px-4 text-center text-[var(--app-text-muted)] transition hover:border-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        <Upload className="mb-2 h-5 w-5" aria-hidden="true" />
                        <span className="text-sm font-semibold text-[var(--app-text)]">Add main photos</span>
                        <span className="mt-1 text-xs">Choose a mode first, then upload or use the camera.</span>
                      </button>
                    )}
                  </section>

                  {(activeLot.extraFiles || []).length ? (
                    <section aria-labelledby={`extra-media-${activeLot.id}`}>
                      <div className="flex items-end justify-between gap-3 border-t border-[var(--app-border)] pt-5">
                        <div>
                          <h5 id={`extra-media-${activeLot.id}`} className="text-sm font-semibold text-[var(--app-text)]">Report-only photos</h5>
                          <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">Included in the final report without analysis.</p>
                        </div>
                        <span className="shrink-0 text-xs tabular-nums text-[var(--app-text-muted)]">{activeLot.extraFiles.length}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3 @min-[520px]:grid-cols-3 @min-[900px]:grid-cols-4">
                        {activeLot.extraFiles.map((file, index) => (
                          <ImageMediaCard
                            key={getMixedFileKey(file)}
                            file={file}
                            kind="extra"
                            onRemove={() => removeExtraImage(activeIdx, index)}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {allowVideo && (activeLot.videoFiles || []).length ? (
                    <section aria-labelledby={`video-media-${activeLot.id}`}>
                      <div className="flex items-end justify-between gap-3 border-t border-[var(--app-border)] pt-5">
                        <div>
                          <h5 id={`video-media-${activeLot.id}`} className="text-sm font-semibold text-[var(--app-text)]">Report-only videos</h5>
                          <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">Included with the report and original files.</p>
                        </div>
                        <span className="shrink-0 text-xs tabular-nums text-[var(--app-text-muted)]">{activeLot.videoFiles?.length || 0}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2 @min-[900px]:grid-cols-3">
                        {(activeLot.videoFiles || []).map((file, index) => (
                          <VideoMediaCard key={getMixedFileKey(file)} file={file} onRemove={() => removeVideo(activeIdx, index)} />
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </>
      )}

      <Menu
        anchorEl={moreAnchor}
        open={Boolean(moreAnchor)}
        onClose={() => setMoreAnchor(null)}
        slotProps={{
          paper: {
            sx: {
              mt: 0.75,
              minWidth: 220,
              border: "1px solid var(--app-border)",
              bgcolor: "var(--app-panel)",
              color: "var(--app-text)",
              boxShadow: "var(--app-shadow-card)",
            },
          },
        }}
      >
        <MenuItem
          disabled={!activeLotHasMode}
          onClick={() => {
            setMoreAnchor(null);
            extraFileInputRef.current?.click();
          }}
          sx={{ minHeight: 44 }}
        >
          <ListItemIcon sx={{ color: "inherit" }}><FileImage size={18} /></ListItemIcon>
          Add report-only photos
        </MenuItem>
        {allowVideo ? (
          <MenuItem
            disabled={!activeLotHasMode}
            onClick={() => {
              setMoreAnchor(null);
              videoUploadInputRef.current?.click();
            }}
            sx={{ minHeight: 44 }}
          >
            <ListItemIcon sx={{ color: "inherit" }}><Video size={18} /></ListItemIcon>
            Add video
          </MenuItem>
        ) : null}
        <MenuItem
          disabled={!activeLot || getLotPhotoCount(activeLot) + (activeLot.videoFiles?.length || 0) === 0}
          onClick={() => {
            setMoreAnchor(null);
            if (activeIdx >= 0) void downloadLotZip(activeIdx);
          }}
          sx={{ minHeight: 44 }}
        >
          <ListItemIcon sx={{ color: "inherit" }}><Download size={18} /></ListItemIcon>
          Download lot ZIP
        </MenuItem>
        <MenuItem
          disabled={Boolean(activeLot?.source?.locked)}
          onClick={() => {
            setMoreAnchor(null);
            if (activeLot) setRemoveLotPendingId(activeLot.id);
          }}
          sx={{ minHeight: 44, color: "error.main" }}
        >
          <ListItemIcon sx={{ color: "inherit" }}><Trash2 size={18} /></ListItemIcon>
          Remove lot
        </MenuItem>
      </Menu>

      <Dialog
        open={removeLotPendingId !== null}
        onClose={() => setRemoveLotPendingId(null)}
        aria-labelledby="remove-lot-title"
        slotProps={{
          // This confirmation is launched from inside BottomDrawer (z-index 90).
          // Keep it above the drawer so the destructive action remains visible.
          backdrop: {
            sx: {
              zIndex: 120,
            },
          },
          paper: {
            sx: {
              border: "1px solid var(--app-border)",
              bgcolor: "var(--app-panel)",
              color: "var(--app-text)",
              boxShadow: "var(--app-shadow-modal)",
            },
          },
        }}
      >
        <DialogTitle id="remove-lot-title">Remove this lot?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: "var(--app-text-muted)" }}>
            Its photos, videos, cover choice, and focus areas will be removed. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setRemoveLotPendingId(null)} sx={{ color: "var(--app-text)" }}>Keep lot</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (removeLotPendingId) removeLot(removeLotPendingId);
            }}
          >
            Remove lot
          </Button>
        </DialogActions>
      </Dialog>

      {removedMedia ? (
        <div
          className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-[95] mx-auto flex min-h-12 max-w-sm items-center justify-between gap-3 rounded-xl bg-[var(--app-text)] px-3 py-2 text-sm text-[var(--app-panel)] shadow-sm"
          role="status"
          aria-live="polite"
        >
          <span className="min-w-0 truncate">Removed {removedMedia.file.name}</span>
          <button
            type="button"
            onClick={undoMediaRemoval}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 font-semibold text-[var(--app-accent)] hover:bg-[var(--app-panel-alt)]"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Undo
          </button>
        </div>
      ) : null}

      {actionButtons ? (
        <div className="border-t border-[var(--app-border)] pt-4">{actionButtons}</div>
      ) : null}


      {/* Camera dialog */}
      {cameraOpen ? (
        <Dialog
          open
          fullScreen
          onClose={(_event, reason) => {
            if (reason === "escapeKeyDown") void finishAndClose();
          }}
          aria-labelledby="mixed-camera-title"
          slotProps={{
            paper: {
              sx: {
                m: 0,
                bgcolor: "#000",
                overflow: "hidden",
              },
            },
          }}
        >
          <DialogTitle id="mixed-camera-title" className="sr-only">
            Capture photos for lot {activeIdx + 1}
          </DialogTitle>
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90 overflow-hidden touch-none overscroll-contain select-none">
            <div className="relative w-full h-full max-w-none max-h-full overflow-hidden flex flex-col rounded-none border-0 bg-black/30 ring-0 shadow-none">
              <div
                className="relative flex-1 min-h-0 bg-black"
                ref={cameraViewRef}
              >
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
                  className="absolute inset-0 h-full w-full object-cover pointer-events-none"
                  style={
                    zoom > 1
                      ? {
                          transform: `scale(${zoom})`,
                          transformOrigin: "center",
                        }
                      : undefined
                  }
                />
                {isSimulatingFlash && (
                  <div className="absolute inset-0 bg-[var(--app-panel)] animate-pulse" />
                )}

                {focusOn && (
                  <div
                    className="pointer-events-auto absolute inset-0 z-10"
                    style={{ touchAction: "none" }}
                    onTouchStart={(e) => {
                      if (e.touches.length >= 2) {
                        const dx = e.touches[0].clientX - e.touches[1].clientX;
                        const dy = e.touches[0].clientY - e.touches[1].clientY;
                        const dist = Math.hypot(dx, dy) || 1;
                        pinchStateRef.current = {
                          active: true,
                          startDist: dist,
                          startFW:
                            focusBoxFW || focusBoxFrac || FOCUS_BOX_FRACTION,
                          startFH:
                            focusBoxFH || focusBoxFrac || FOCUS_BOX_FRACTION,
                        };
                      }
                    }}
                    onTouchMove={(e) => {
                      const s = pinchStateRef.current;
                      if (!s?.active || e.touches.length < 2) return;
                      const dx = e.touches[0].clientX - e.touches[1].clientX;
                      const dy = e.touches[0].clientY - e.touches[1].clientY;
                      const dist = Math.hypot(dx, dy) || 1;
                      const ratio = dist / (s.startDist || 1);
                      const dispW = cameraViewSize.w || 1;
                      const dispH = cameraViewSize.h || 1;
                      const cx =
                        (typeof focusBoxCX === "number" ? focusBoxCX : 0.5) *
                        dispW;
                      const cy =
                        (typeof focusBoxCY === "number" ? focusBoxCY : 0.5) *
                        dispH;
                      const startFW = s.startFW || 0.62;
                      const startFH = s.startFH || 0.62;
                      if (focusLockAR) {
                        const maxHalfW = Math.min(cx, dispW - cx);
                        const maxHalfH = Math.min(cy, dispH - cy);
                        const maxFW = Math.max(
                          0,
                          (2 * maxHalfW) / Math.max(1, dispW)
                        );
                        const maxFH = Math.max(
                          0,
                          (2 * maxHalfH) / Math.max(1, dispH)
                        );
                        const minScaleByW = 40 / Math.max(1, startFW * dispW);
                        const minScaleByH = 40 / Math.max(1, startFH * dispH);
                        const sMin = Math.max(minScaleByW, minScaleByH);
                        const sMaxW =
                          (maxFW > 0 ? maxFW : 0.98) /
                          Math.max(0.0001, startFW);
                        const sMaxH =
                          (maxFH > 0 ? maxFH : 0.98) /
                          Math.max(0.0001, startFH);
                        const sMax = Math.max(0.0001, Math.min(sMaxW, sMaxH));
                        const sClamped = Math.max(sMin, Math.min(sMax, ratio));
                        const nextFW = Math.max(
                          40 / dispW,
                          Math.min(0.98, startFW * sClamped)
                        );
                        const nextFH = Math.max(
                          40 / dispH,
                          Math.min(0.98, startFH * sClamped)
                        );
                        setFocusBoxFW(nextFW);
                        setFocusBoxFH(nextFH);
                      } else {
                        let nextFW = startFW * ratio;
                        let nextFH = startFH * ratio;
                        const minW = 40 / Math.max(1, dispW);
                        const minH = 40 / Math.max(1, dispH);
                        const maxWByCenter =
                          (2 * Math.min(cx, dispW - cx)) / Math.max(1, dispW);
                        const maxHByCenter =
                          (2 * Math.min(cy, dispH - cy)) / Math.max(1, dispH);
                        nextFW = Math.max(
                          minW,
                          Math.min(0.98, Math.min(nextFW, maxWByCenter || 0.98))
                        );
                        nextFH = Math.max(
                          minH,
                          Math.min(0.98, Math.min(nextFH, maxHByCenter || 0.98))
                        );
                        setFocusBoxFW(nextFW);
                        setFocusBoxFH(nextFH);
                      }
                    }}
                    onTouchEnd={(e) => {
                      if (e.touches.length < 2) pinchStateRef.current = null;
                    }}
                  >
                    <div
                      onPointerDown={(e) => startDrag("move", e)}
                      className="absolute border-4 border-blue-600 rounded-sm"
                      style={{
                        width:
                          cameraViewSize.w > 0
                            ? Math.round(
                                (focusBoxFW ||
                                  focusBoxFrac ||
                                  FOCUS_BOX_FRACTION) * cameraViewSize.w
                              )
                            : undefined,
                        height:
                          cameraViewSize.h > 0
                            ? Math.round(
                                (focusBoxFH ||
                                  focusBoxFrac ||
                                  FOCUS_BOX_FRACTION) * cameraViewSize.h
                              )
                            : undefined,
                        left:
                          cameraViewSize.w > 0
                            ? Math.round(
                                (typeof focusBoxCX === "number"
                                  ? focusBoxCX
                                  : 0.5) *
                                  cameraViewSize.w -
                                  ((focusBoxFW ||
                                    focusBoxFrac ||
                                    FOCUS_BOX_FRACTION) *
                                    cameraViewSize.w) /
                                    2
                              )
                            : undefined,
                        top:
                          cameraViewSize.h > 0
                            ? Math.round(
                                (typeof focusBoxCY === "number"
                                  ? focusBoxCY
                                  : 0.5) *
                                  cameraViewSize.h -
                                  ((focusBoxFH ||
                                    focusBoxFrac ||
                                    FOCUS_BOX_FRACTION) *
                                    cameraViewSize.h) /
                                    2
                              )
                            : undefined,
                        cursor: "move",
                      }}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        const dispW = cameraViewSize.w;
                        const dispH = cameraViewSize.h;
                        if (!(dispW > 0 && dispH > 0)) return;
                        const step = e.shiftKey ? 5 : 1;
                        const w =
                          (focusBoxFW || focusBoxFrac || FOCUS_BOX_FRACTION) *
                          dispW;
                        const h =
                          (focusBoxFH || focusBoxFrac || FOCUS_BOX_FRACTION) *
                          dispH;
                        let cx =
                          (typeof focusBoxCX === "number" ? focusBoxCX : 0.5) *
                          dispW;
                        let cy =
                          (typeof focusBoxCY === "number" ? focusBoxCY : 0.5) *
                          dispH;
                        if (e.key === "ArrowLeft") cx -= step;
                        else if (e.key === "ArrowRight") cx += step;
                        else if (e.key === "ArrowUp") cy -= step;
                        else if (e.key === "ArrowDown") cy += step;
                        else return;
                        cx = Math.max(
                          w / 2,
                          Math.min(dispW - w / 2, Math.round(cx))
                        );
                        cy = Math.max(
                          h / 2,
                          Math.min(dispH - h / 2, Math.round(cy))
                        );
                        setFocusBoxCX(cx / Math.max(1, dispW));
                        setFocusBoxCY(cy / Math.max(1, dispH));
                        try {
                          e.preventDefault();
                          e.stopPropagation();
                        } catch {}
                      }}
                    >
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("nw", e);
                        }}
                        style={{
                          position: "absolute",
                          left: -8,
                          top: -8,
                          width: 16,
                          height: 16,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "nwse-resize",
                          touchAction: "none",
                        }}
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("ne", e);
                        }}
                        style={{
                          position: "absolute",
                          right: -8,
                          top: -8,
                          width: 16,
                          height: 16,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "nesw-resize",
                          touchAction: "none",
                        }}
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("se", e);
                        }}
                        style={{
                          position: "absolute",
                          right: -8,
                          bottom: -8,
                          width: 16,
                          height: 16,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "nwse-resize",
                          touchAction: "none",
                        }}
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("sw", e);
                        }}
                        style={{
                          position: "absolute",
                          left: -8,
                          bottom: -8,
                          width: 16,
                          height: 16,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "nesw-resize",
                          touchAction: "none",
                        }}
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("n", e);
                        }}
                        style={{
                          position: "absolute",
                          left: "50%",
                          top: -8,
                          transform: "translateX(-50%)",
                          width: 24,
                          height: 12,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "ns-resize",
                          touchAction: "none",
                        }}
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("s", e);
                        }}
                        style={{
                          position: "absolute",
                          left: "50%",
                          bottom: -8,
                          transform: "translateX(-50%)",
                          width: 24,
                          height: 12,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "ns-resize",
                          touchAction: "none",
                        }}
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("e", e);
                        }}
                        style={{
                          position: "absolute",
                          top: "50%",
                          right: -8,
                          transform: "translateY(-50%)",
                          width: 12,
                          height: 24,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "ew-resize",
                          touchAction: "none",
                        }}
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startDrag("w", e);
                        }}
                        style={{
                          position: "absolute",
                          top: "50%",
                          left: -8,
                          transform: "translateY(-50%)",
                          width: 12,
                          height: 24,
                          background: "#fff",
                          border: "2px solid #2563eb",
                          borderRadius: 4,
                          cursor: "ew-resize",
                          touchAction: "none",
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Top overlay: counters / flash */}
                <div className="pointer-events-auto absolute top-0 left-0 right-0 z-30">
                  <div
                    className={`w-full px-1.5 sm:px-2`}
                    style={{
                      paddingTop: "calc(env(safe-area-inset-top) + 2px)",
                      paddingBottom: 0,
                    }}
                  >
                    <div className="sm:hidden text-white">
                      {orientation !== "landscape" ? (
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={finishAndClose}
                              className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
                              title="Exit"
                            >
                              <X className="h-5 w-5" />
                              <span className="text-[13px]">Exit</span>
                            </button>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  setFlashOn((v) => !v);
                                  try {
                                    const stream = videoRef.current
                                      ?.srcObject as MediaStream | null;
                                    const track =
                                      stream?.getVideoTracks?.()[0] as any;
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
                              <button
                                type="button"
                                onClick={() => setFocusOn((v) => !v)}
                                className={`inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)] ${
                                  focusOn
                                    ? "bg-blue-600/80 text-white"
                                    : "bg-[var(--app-panel)] text-white"
                                }`}
                                title="Focus"
                              >
                                <span className="text-[13px]">Focus</span>
                                <span className="text-[11px] ml-1 opacity-90">
                                  {focusOn ? "On" : "Off"}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const dispW = cameraViewSize.w;
                                  const dispH = cameraViewSize.h;
                                  setFocusLockAR((prev) => {
                                    const next = !prev;
                                    if (next) {
                                      const fw =
                                        (focusBoxFW ||
                                          focusBoxFrac ||
                                          FOCUS_BOX_FRACTION) * (dispW || 1);
                                      const fh =
                                        (focusBoxFH ||
                                          focusBoxFrac ||
                                          FOCUS_BOX_FRACTION) * (dispH || 1);
                                      const ar = Math.max(
                                        0.0001,
                                        fw / Math.max(1, fh)
                                      );
                                      focusARRef.current = ar;
                                    }
                                    return next;
                                  });
                                }}
                                className={`inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)] ${
                                  focusLockAR
                                    ? "bg-blue-600/80 text-white"
                                    : "bg-[var(--app-panel)] text-white"
                                }`}
                                title="Aspect Lock"
                                aria-label="Aspect Lock"
                              >
                                {focusLockAR ? (
                                  <Lock className="h-4 w-4" />
                                ) : (
                                  <Unlock className="h-4 w-4" />
                                )}
                                <span className="text-[12px] ml-1">
                                  {focusLockAR ? "Lock On" : "Lock Off"}
                                </span>
                              </button>
                            </div>
                          </div>
                          <div className="mt-0.5 text-center text-[12px] font-medium truncate">
                            Total:{" "}
                            {lots.reduce((s, l) => s + l.files.length, 0)}{" "}
                            images
                            {" | "}Lot {activeIdx + 1}:{" "}
                            {lots[activeIdx]?.files.length ?? 0} main
                            {" | "}Extra:{" "}
                            {lots[activeIdx]?.extraFiles.length ?? 0}
                            {" | "}Mode:{" "}
                            {lots[activeIdx]?.mode === "single_lot"
                              ? "Bundle"
                              : lots[activeIdx]?.mode === "per_item"
                              ? "Per Item"
                              : lots[activeIdx]?.mode === "per_photo"
                              ? "Per Photo"
                              : "—"}
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
                            aria-label="Exit"
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
                              Total:{" "}
                              {lots.reduce((s, l) => s + l.files.length, 0)}{" "}
                              images
                              {" | "}Lot {activeIdx + 1}:{" "}
                              {lots[activeIdx]?.files.length ?? 0} main
                              {" | "}Extra:{" "}
                              {lots[activeIdx]?.extraFiles.length ?? 0}
                              {" | "}Mode:{" "}
                              {lots[activeIdx]?.mode === "single_lot"
                                ? "Bundle"
                                : lots[activeIdx]?.mode === "per_item"
                                ? "Per Item"
                                : lots[activeIdx]?.mode === "per_photo"
                                ? "Per Photo"
                                : "—"}
                              {isRecording &&
                                ` | REC ${formatTimer(recMillis)}`}
                            </span>
                          </div>
                          <div className="flex items-center justify-end gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={async () => {
                                setFlashOn((v) => !v);
                                try {
                                  const stream = videoRef.current
                                    ?.srcObject as MediaStream | null;
                                  const track =
                                    stream?.getVideoTracks?.()[0] as any;
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
                              className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-1 ring-1 ring-white/20 hover:bg-[var(--app-panel)] whitespace-nowrap"
                              title="Flash"
                              aria-label="Flash"
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
                            <button
                              type="button"
                              onClick={() => setFocusOn((v) => !v)}
                              className={`inline-flex h-9 cursor-pointer items-center rounded-lg px-2 ring-1 ring-white/20 hover:bg-[var(--app-panel)] whitespace-nowrap ${
                                focusOn
                                  ? "bg-blue-600/80 text-white"
                                  : "bg-[var(--app-panel)] text-white"
                              }`}
                              title="Focus"
                              aria-label="Focus"
                            >
                              <span className="text-[13px] leading-none whitespace-nowrap">
                                Focus
                              </span>
                              <span className="text-[12px] ml-1 opacity-90 whitespace-nowrap">
                                {focusOn ? "On" : "Off"}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const dispW = cameraViewSize.w;
                                const dispH = cameraViewSize.h;
                                setFocusLockAR((prev) => {
                                  const next = !prev;
                                  if (next) {
                                    const fw =
                                      (focusBoxFW ||
                                        focusBoxFrac ||
                                        FOCUS_BOX_FRACTION) * (dispW || 1);
                                    const fh =
                                      (focusBoxFH ||
                                        focusBoxFrac ||
                                        FOCUS_BOX_FRACTION) * (dispH || 1);
                                    const ar = Math.max(
                                      0.0001,
                                      fw / Math.max(1, fh)
                                    );
                                    focusARRef.current = ar;
                                  }
                                  return next;
                                });
                              }}
                              className={`inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg px-2 ring-1 ring-white/20 hover:bg-[var(--app-panel)] whitespace-nowrap ${
                                focusLockAR
                                  ? "bg-blue-600/80 text-white"
                                  : "bg-[var(--app-panel)] text-white"
                              }`}
                              title="Aspect Lock"
                              aria-label="Aspect Lock"
                            >
                              {focusLockAR ? (
                                <Lock className="h-4 w-4" />
                              ) : (
                                <Unlock className="h-4 w-4" />
                              )}
                              <span className="text-[12px] ml-1 whitespace-nowrap">
                                {focusLockAR ? "Lock On" : "Lock Off"}
                              </span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="hidden sm:flex flex-row flex-nowrap w-full items-center justify-between gap-2 text-[15px] leading-tight text-white">
                      <button
                        type="button"
                        onClick={finishAndClose}
                        className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-0 ring-1 ring-white/20 hover:bg-[var(--app-panel)] shrink-0"
                        title="Exit"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span>Exit</span>
                      </button>
                      <div className="min-w-0 flex-1 text-center overflow-hidden px-2">
                        <span
                          className="block truncate leading-none text-white/95"
                          title={`Total: ${lots.reduce(
                            (s, l) => s + l.files.length,
                            0
                          )} images | Lot ${activeIdx + 1}: ${
                            lots[activeIdx]?.files.length ?? 0
                          } main (${lots[activeIdx]?.mode === "single_lot"
                            ? "final photo checked for lot number; first 10 analyzed for lots 1000+, otherwise up to 50"
                            : "up to the first 50 analyzed by Software"}) | Extra: ${
                            lots[activeIdx]?.extraFiles.length ?? 0
                          } | Mode: ${
                            lots[activeIdx]?.mode === "single_lot"
                              ? "Bundle"
                              : lots[activeIdx]?.mode === "per_item"
                              ? "Per Item"
                              : lots[activeIdx]?.mode === "per_photo"
                              ? "Per Photo"
                              : "—"
                          }${
                            isRecording
                              ? ` | REC ${formatTimer(recMillis)}`
                              : ""
                          }`}
                        >
                          Total: {lots.reduce((s, l) => s + l.files.length, 0)}{" "}
                          images
                          {" | "}Lot {activeIdx + 1}:{" "}
                          {lots[activeIdx]?.files.length ?? 0} main
                          {" | "}Extra:{" "}
                          {lots[activeIdx]?.extraFiles.length ?? 0}
                          {" | "}Mode:{" "}
                          {lots[activeIdx]?.mode === "single_lot"
                            ? "Bundle"
                            : lots[activeIdx]?.mode === "per_item"
                            ? "Per Item"
                            : lots[activeIdx]?.mode === "per_photo"
                            ? "Per Photo"
                            : "—"}
                          {isRecording && (
                            <>
                              {" | "}REC {formatTimer(recMillis)}
                            </>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center justify-end gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={async () => {
                            setFlashOn((v) => !v);
                            try {
                              const stream = videoRef.current
                                ?.srcObject as MediaStream | null;
                              const track =
                                stream?.getVideoTracks?.()[0] as any;
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
                          className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg bg-[var(--app-panel)] px-2 py-0 ring-1 ring-white/20 hover:bg-[var(--app-panel)]"
                          title="Flash"
                        >
                          {flashOn ? (
                            <Zap className="h-3.5 w-3.5 text-yellow-300" />
                          ) : (
                            <ZapOff className="h-3.5 w-3.5" />
                          )}
                          <span>{flashOn ? "On" : "Off"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setFocusOn((v) => !v)}
                          className={`inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 py-0 ring-1 ring-white/20 hover:bg-[var(--app-panel)] ${
                            focusOn
                              ? "bg-blue-600/80 text-white"
                              : "bg-[var(--app-panel)] text-white"
                          }`}
                          title="Focus"
                        >
                          <span>Focus</span>
                          <span className="text-[12px] ml-1 opacity-90">
                            {focusOn ? "On" : "Off"}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const dispW = cameraViewSize.w;
                            const dispH = cameraViewSize.h;
                            setFocusLockAR((prev) => {
                              const next = !prev;
                              if (next) {
                                const fw =
                                  (focusBoxFW ||
                                    focusBoxFrac ||
                                    FOCUS_BOX_FRACTION) * (dispW || 1);
                                const fh =
                                  (focusBoxFH ||
                                    focusBoxFrac ||
                                    FOCUS_BOX_FRACTION) * (dispH || 1);
                                const ar = Math.max(
                                  0.0001,
                                  fw / Math.max(1, fh)
                                );
                                focusARRef.current = ar;
                              }
                              return next;
                            });
                          }}
                          className={`inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg px-2 py-0 ring-1 ring-white/20 hover:bg-[var(--app-panel)] ${
                            focusLockAR
                              ? "bg-blue-600/80 text-white"
                              : "bg-[var(--app-panel)] text-white"
                          }`}
                          title="Aspect Lock"
                        >
                          {focusLockAR ? (
                            <Lock className="h-3.5 w-3.5" />
                          ) : (
                            <Unlock className="h-3.5 w-3.5" />
                          )}
                          <span className="text-[12px] ml-1">
                            {focusLockAR ? "Lock On" : "Lock Off"}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Landscape: All controls on right side */}
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
                    {/* Lens switcher (0.5x, 1x, 2x, etc.) */}
                    {availableLenses.length > 1 && (
                      <div className="flex items-center gap-0.5 rounded-lg bg-black/50 p-0.5 ring-1 ring-white/20  flex-shrink-0">
                        {availableLenses.map((lens) => (
                          <button
                            key={lens.id}
                            type="button"
                            onClick={() => switchLens(lens)}
                            className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all ${
                              selectedLens === lens.id
                                ? "bg-yellow-500 text-black shadow-sm"
                                : "bg-[var(--app-panel)] text-white hover:bg-[var(--app-panel)]"
                            }`}
                          >
                            {lens.label}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Digital zoom slider */}
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
                        onClick={() => handleCapture("single_lot")}
                        className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center gap-0.5 rounded-full bg-blue-600/80 text-[9px] font-semibold text-white transition hover:bg-blue-500/80"
                        title="Capture - Bundle"
                      >
                        <Camera className="h-3 w-3" />
                        <span className="whitespace-nowrap">Bundle</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCapture("single_lot", true)}
                        className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center rounded-full bg-blue-600/80 text-[9px] font-semibold text-white transition hover:bg-blue-500/80"
                        title="Capture - Bundle Extra (Report Only)"
                      >
                        <span className="whitespace-nowrap">Extra</span>
                      </button>
                    </div>
                    <div className="flex items-stretch gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleCapture("per_item")}
                        className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center gap-0.5 rounded-full bg-blue-600/80 text-[9px] font-semibold text-white transition hover:bg-blue-500/80"
                        title="Capture - Item"
                      >
                        <Camera className="h-3 w-3" />
                        <span className="whitespace-nowrap">Item</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCapture("per_item", true)}
                        className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center rounded-full bg-blue-600/80 text-[9px] font-semibold text-white transition hover:bg-blue-500/80"
                        title="Capture - Item Extra (Report Only)"
                      >
                        <span className="whitespace-nowrap">Extra</span>
                      </button>
                    </div>
                    <div className="flex items-stretch gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleCapture("per_photo")}
                        className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center gap-0.5 rounded-full bg-blue-600/80 text-[9px] font-semibold text-white transition hover:bg-blue-500/80"
                        title="Capture - Photo"
                      >
                        <Camera className="h-3 w-3" />
                        <span className="whitespace-nowrap">Photo</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCapture("per_photo", true)}
                        className="h-11 flex-1 inline-flex cursor-pointer items-center justify-center rounded-full bg-blue-600/80 text-[9px] font-semibold text-white transition hover:bg-blue-500/80"
                        title="Capture - Photo Extra (Report Only)"
                      >
                        <span className="whitespace-nowrap">Extra</span>
                      </button>
                    </div>

                    {/* Record button */}
                    {allowVideo ? (
                    <button
                      type="button"
                      disabled={!lots[activeIdx]?.mode}
                      onClick={() => {
                        if (!lots[activeIdx]?.mode) return;
                        if (isRecording) {
                          try {
                            playRecordStop();
                          } catch {}
                          stopRecording();
                        } else {
                          try {
                            playRecordStart();
                          } catch {}
                          startRecording();
                        }
                      }}
                      className={`h-9 w-full flex-shrink-0 inline-flex cursor-pointer items-center justify-center rounded-full px-1.5 text-[9px] font-semibold ring-1 ring-white/10 ${
                        isRecording
                          ? "bg-yellow-600/60 text-white hover:bg-yellow-700/60"
                          : "bg-yellow-500/60 text-white hover:bg-yellow-600/60"
                      } ${
                        !lots[activeIdx]?.mode
                          ? "opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                      title={isRecording ? "Stop Recording" : "Start Recording"}
                    >
                      {isRecording ? "Stop" : "Record"}
                    </button>
                    ) : null}

                    {/* Previous/Next navigation buttons 1-50 */}
                    <div className="flex items-stretch gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={goPrevLot}
                        disabled={activeIdx <= 0}
                        className="h-8 flex-1 inline-flex flex-col items-center justify-center gap-0 rounded-md bg-blue-600/60 px-1 text-[9px] font-semibold text-white ring-1 ring-white/10 hover:bg-blue-500/60 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        aria-label="Previous lot"
                      >
                        <span className="leading-none">Prev</span>
                        <span className="leading-none">Lot</span>
                      </button>
                      <button
                        type="button"
                        onClick={goNextLot}
                        disabled={activeIdx >= lots.length - 1}
                        className="h-8 flex-1 inline-flex flex-col items-center justify-center gap-0 rounded-md bg-green-600/60 px-1 text-[9px] font-semibold text-white ring-1 ring-white/10 hover:bg-green-500/60 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Next lot"
                      >
                        <span className="leading-none">Next</span>
                        <span className="leading-none">Lot</span>
                      </button>
                    </div>

                    {/* Done button at bottom */}
                    <button
                      type="button"
                      onClick={finishAndClose}
                      className="h-9 w-full inline-flex items-center justify-center gap-1 rounded-xl bg-blue-600/80 text-white ring-2 ring-blue-300/30 focus:outline-none cursor-pointer flex-shrink-0"
                      aria-label="Done"
                      title="Done"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span className="text-[10px] font-bold">Done</span>
                    </button>
                  </div>
                )}

                {/* Bottom controls - hidden in landscape */}
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
                      {/* Lens switcher (0.5x, 1x, 2x, etc.) */}
                      {availableLenses.length > 1 && (
                        <div className="mb-1 flex items-center justify-center gap-1 rounded-lg bg-black/50 px-2 py-1.5 ring-1 ring-white/20 ">
                          {availableLenses.map((lens) => (
                            <button
                              key={lens.id}
                              type="button"
                              onClick={() => switchLens(lens)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                selectedLens === lens.id
                                  ? "bg-yellow-500 text-black shadow-sm scale-110"
                                  : "bg-[var(--app-panel)] text-white hover:bg-[var(--app-panel)]"
                              }`}
                            >
                              {lens.label}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Portrait: digital zoom slider */}
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
                      {/* Portrait: 3 button controls */}
                      <div className="grid items-center gap-2 w-full grid-cols-[2fr_1fr_2fr]">
                        <button
                          type="button"
                          onClick={goPrevLot}
                          disabled={activeIdx <= 0}
                          className="h-8 w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-2 text-[11px] font-bold text-white ring-1 ring-white/10 hover:bg-blue-500 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                          aria-label="Previous lot"
                        >
                          <ChevronLeft className="h-3 w-3" />
                          <span className="text-[11px]">Prev Lot</span>
                        </button>
                        <button
                          type="button"
                          onClick={finishAndClose}
                          className="h-12 sm:h-14 w-full inline-flex items-center justify-center rounded-lg bg-blue-600 text-white ring-2 ring-blue-300/60 focus:outline-none cursor-pointer"
                          aria-label="Done"
                          title="Done"
                        >
                          <Check className="h-7 w-7" />
                        </button>
                        <button
                          type="button"
                          onClick={goNextLot}
                          disabled={activeIdx >= lots.length - 1}
                          className="h-8 w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-green-600 px-2 text-[11px] font-bold text-white ring-1 ring-white/10 hover:bg-green-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label="Next lot"
                        >
                          <span className="text-[11px]">Next Lot</span>
                          <ChevronRight className="h-3 w-3" />
                        </button>
                      </div>
                      {/* Row 2: Capture buttons - bottom for portrait */}
                      <div className={`mt-2 grid gap-2 w-full ${allowVideo ? "grid-cols-4" : "grid-cols-3"}`}>
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => handleCapture("single_lot")}
                            className="h-7 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full bg-blue-600 px-2 text-[11px] font-bold text-white transition hover:bg-blue-500"
                            title="Capture - Bundle"
                          >
                            <Camera className="h-4 w-4" /> Bundle
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCapture("single_lot", true)}
                            className="h-7 inline-flex cursor-pointer items-center justify-center gap-1 rounded-full bg-blue-600 px-2 text-[11px] font-bold text-white transition hover:bg-blue-500"
                            title="Capture - Bundle Extra (Report Only)"
                          >
                            + Extra
                          </button>
                        </div>
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => handleCapture("per_item")}
                            className="h-7 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full bg-blue-600 px-2 text-[11px] font-bold text-white transition hover:bg-blue-500"
                            title="Capture - Item"
                          >
                            <Camera className="h-4 w-4" /> Item
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCapture("per_item", true)}
                            className="h-7 inline-flex cursor-pointer items-center justify-center gap-1 rounded-full bg-blue-600 px-2 text-[11px] font-bold text-white transition hover:bg-blue-500"
                            title="Capture - Item Extra (Report Only)"
                          >
                            + Extra
                          </button>
                        </div>
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => handleCapture("per_photo")}
                            className="h-7 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full bg-blue-600 px-2 text-[11px] font-bold text-white transition hover:bg-blue-500"
                            title="Capture - Photo"
                          >
                            <Camera className="h-4 w-4" /> Photo
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCapture("per_photo", true)}
                            className="h-7 inline-flex cursor-pointer items-center justify-center gap-1 rounded-full bg-blue-600 px-2 text-[11px] font-bold text-white transition hover:bg-blue-500"
                            title="Capture - Photo Extra (Report Only)"
                          >
                            + Extra
                          </button>
                        </div>
                        {allowVideo ? (
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            disabled={!lots[activeIdx]?.mode}
                            onClick={() => {
                              if (!lots[activeIdx]?.mode) return;
                              if (isRecording) {
                                try {
                                  playRecordStop();
                                } catch {}
                                stopRecording();
                              } else {
                                try {
                                  playRecordStart();
                                } catch {}
                                startRecording();
                              }
                            }}
                            className={`h-7 inline-flex cursor-pointer items-center justify-center rounded-full px-2 text-[11px] font-bold ring-1 ring-white/20 ${
                              isRecording
                                ? "bg-blue-900 text-white hover:bg-blue-800"
                                : "bg-blue-600 text-white hover:bg-blue-500"
                            } ${
                              !lots[activeIdx]?.mode
                                ? "opacity-50 cursor-not-allowed"
                                : ""
                            }`}
                            title={
                              isRecording ? "Stop Recording" : "Start Recording"
                            }
                          >
                            {isRecording ? "Stop" : "Record"}
                          </button>
                        </div>
                        ) : null}
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
          </div>
        </Dialog>
      ) : null}
      {editing && (
        <ImageAnnotator
          imageUrl={editing.url}
          initialBoxes={(() => {
            const lot = lots[editing.lotIdx];
            const file = lot?.files?.[editing.imgIdx];
            if (!lot || !file) return [] as AnnBox[];
            const key = getMixedFileKey(file);
            return (lot.annotations?.[key] || []) as AnnBox[];
          })()}
          onSave={handleSaveAnnotations}
          onCancel={closeEditor}
        />
      )}
    </div>
  );
}
