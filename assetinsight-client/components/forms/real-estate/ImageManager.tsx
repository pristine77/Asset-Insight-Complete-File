"use client";

import { useEffect, useRef } from "react";
import { Camera, Trash2, Upload, Play, Download } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useLocalImagePreview } from "./useLocalImagePreview";

type Props = {
  mainImages: File[];
  extraImages: File[];
  videoFile?: File;
  maxImages?: number;
  onAddMainImages: (files: File[]) => void;
  onAddExtraImages: (files: File[]) => void;
  onAddVideo: (file: File) => void;
  onRemoveMainImage: (index: number) => void;
  onRemoveExtraImage: (index: number) => void;
  onRemoveVideo: () => void;
  onOpenCamera: (mode: "main" | "extra") => void;
  disabled?: boolean;
};

function ManagedImagePreview({
  file,
  alt,
}: {
  file: File;
  alt: string;
}) {
  const previewUrl = useLocalImagePreview(file);

  if (!previewUrl) {
    return (
      <div
        className="h-32 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)]"
        aria-label={`${alt} preview loading`}
      />
    );
  }

  return (

    <img
      src={previewUrl}
      alt={alt}
      className="h-32 w-full rounded-lg border border-[var(--app-border)] object-cover"
    />
  );
}

export default function ImageManager({
  mainImages,
  extraImages,
  videoFile,
  maxImages = 50,
  onAddMainImages,
  onAddExtraImages,
  onAddVideo,
  onRemoveMainImage,
  onRemoveExtraImage,
  onRemoveVideo,
  onOpenCamera,
  disabled = false,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extraFileInputRef = useRef<HTMLInputElement>(null);
  const videoUploadInputRef = useRef<HTMLInputElement>(null);
  const transientDownloadUrlsRef = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const url of transientDownloadUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      transientDownloadUrlsRef.current.clear();
    },
    []
  );

  function handleManualUpload(files: FileList | null) {
    if (!files || disabled) return;
    const incoming = Array.from(files);
    onAddMainImages(incoming);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleManualUploadExtra(files: FileList | null) {
    if (!files || disabled) return;
    const incoming = Array.from(files);
    onAddExtraImages(incoming);
    if (extraFileInputRef.current) extraFileInputRef.current.value = "";
  }

  function handleManualUploadVideo(files: FileList | null) {
    if (!files || files.length === 0 || disabled) return;
    onAddVideo(files[0]);
    if (videoUploadInputRef.current) videoUploadInputRef.current.value = "";
  }

  async function downloadAllMainImages() {
    try {
      if (mainImages.length === 0) return;
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const f of mainImages) zip.file(f.name, f);
      const blob = await zip.generateAsync({ type: "blob" });
      const zipName = `real-estate-main-images-${Date.now()}.zip`;
      const url = URL.createObjectURL(blob);
      transientDownloadUrlsRef.current.add(url);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        if (transientDownloadUrlsRef.current.delete(url)) {
          URL.revokeObjectURL(url);
        }
      }, 2000);
      toast.success("Main images downloaded!");
    } catch {
      toast.error("Failed to download images");
    }
  }

  async function downloadAllExtraImages() {
    try {
      if (extraImages.length === 0) return;
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const f of extraImages) zip.file(f.name, f);
      const blob = await zip.generateAsync({ type: "blob" });
      const zipName = `real-estate-extra-images-${Date.now()}.zip`;
      const url = URL.createObjectURL(blob);
      transientDownloadUrlsRef.current.add(url);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        if (transientDownloadUrlsRef.current.delete(url)) {
          URL.revokeObjectURL(url);
        }
      }, 2000);
      toast.success("Extra images downloaded!");
    } catch {
      toast.error("Failed to download images");
    }
  }

  return (
    <div className="grid gap-5">
      {/* Main Images */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h4 className="text-[13px] font-semibold text-[var(--app-text)]">
              Main photos <span className="font-normal text-[var(--app-text-muted)]">({mainImages.length})</span>
              <span aria-hidden="true" className="ml-0.5 text-[var(--app-danger)]">*</span>
            </h4>
            <p className="text-xs text-[var(--app-text-muted)]">Used for the valuation. Add at least one.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {mainImages.length > 0 && (
              <button
                type="button"
                onClick={downloadAllMainImages}
                className="app-button app-button--secondary"
              >
                <Download className="size-4" aria-hidden="true" />
                Download all
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="app-button app-button--secondary"
            >
              <Upload className="size-4" aria-hidden="true" />
              Upload
            </button>
            <button
              type="button"
              onClick={() => onOpenCamera("main")}
              disabled={disabled}
              className="app-button app-button--primary"
            >
              <Camera className="size-4" aria-hidden="true" />
              Camera
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => handleManualUpload(e.target.files)}
          className="sr-only"
        />

        {mainImages.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {mainImages.map((file, idx) => (
              <div
                key={`${file.name}-${file.size}-${file.lastModified}-${idx}`}
                className="relative group"
              >
                <ManagedImagePreview file={file} alt={`Main ${idx + 1}`} />
                <div className="absolute inset-x-0 bottom-0 rounded-b-lg bg-black/65 p-2">
                  <p className="text-xs text-white font-medium truncate">
                    {file.name}
                  </p>
                  <p className="text-xs text-white/80">
                    {(file.size / 1024).toFixed(0)} KB
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveMainImage(idx)}
                  aria-label={`Remove ${file.name}`}
                  className="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-1.5 text-white shadow-sm transition-colors hover:bg-[var(--app-danger)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--app-border-strong)] bg-[var(--app-panel-alt)] p-4">
            <Camera className="size-6 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
            <p className="text-sm text-[var(--app-text-muted)]">No main photos yet. Upload them or use the camera.</p>
          </div>
        )}
      </section>

      {/* Extra Images (Report Only) */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h4 className="text-[13px] font-semibold text-[var(--app-text)]">
              Extra photos <span className="font-normal text-[var(--app-text-muted)]">({extraImages.length})</span>
            </h4>
            <p className="text-xs text-[var(--app-text-muted)]">Shown in the report only.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {extraImages.length > 0 && (
              <button
                type="button"
                onClick={downloadAllExtraImages}
                className="app-button app-button--secondary"
              >
                <Download className="size-4" aria-hidden="true" />
                Download all
              </button>
            )}
            <button
              type="button"
              onClick={() => extraFileInputRef.current?.click()}
              disabled={disabled}
              className="app-button app-button--secondary"
            >
              <Upload className="size-4" aria-hidden="true" />
              Upload
            </button>
            <button
              type="button"
              onClick={() => onOpenCamera("extra")}
              disabled={disabled}
              className="app-button app-button--secondary"
            >
              <Camera className="size-4" aria-hidden="true" />
              Camera
            </button>
          </div>
        </div>

        <input
          ref={extraFileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => handleManualUploadExtra(e.target.files)}
          className="sr-only"
        />

        {extraImages.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {extraImages.map((file, idx) => (
              <div
                key={`${file.name}-${file.size}-${file.lastModified}-${idx}`}
                className="relative group"
              >
                <ManagedImagePreview file={file} alt={`Extra ${idx + 1}`} />
                <div className="absolute inset-x-0 bottom-0 rounded-b-lg bg-black/65 p-2">
                  <p className="text-xs text-white font-medium truncate">
                    {file.name}
                  </p>
                  <p className="text-xs text-white/80">
                    {(file.size / 1024).toFixed(0)} KB
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveExtraImage(idx)}
                  aria-label={`Remove ${file.name}`}
                  className="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-1.5 text-white shadow-sm transition-colors hover:bg-[var(--app-danger)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] px-4 py-3">
            <Upload className="size-5 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
            <p className="text-sm text-[var(--app-text-muted)]">No extra photos.</p>
          </div>
        )}
      </section>

      {/* Video */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h4 className="text-[13px] font-semibold text-[var(--app-text)]">Video</h4>
            <p className="text-xs text-[var(--app-text-muted)]">One video, from the camera or uploaded.</p>
          </div>
          {!videoFile && (
            <button
              type="button"
              onClick={() => videoUploadInputRef.current?.click()}
              disabled={disabled}
              className="app-button app-button--secondary"
            >
              <Upload className="size-4" aria-hidden="true" />
              Upload video
            </button>
          )}
        </div>

        <input
          ref={videoUploadInputRef}
          type="file"
          accept="video/*"
          onChange={(e) => handleManualUploadVideo(e.target.files)}
          className="sr-only"
        />

        {videoFile ? (
          <div className="relative group rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] p-3">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 rounded-full bg-[var(--app-accent-soft)] p-3">
                <Play className="h-6 w-6 text-[var(--app-accent)]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--app-text)] truncate">
                  {videoFile.name}
                </p>
                <p className="text-xs text-[var(--app-text-muted)]">
                  {(videoFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <button
                type="button"
                onClick={onRemoveVideo}
                aria-label={`Remove ${videoFile.name}`}
                className="app-button app-button--icon flex-shrink-0 text-[var(--app-danger)]"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] px-4 py-3">
            <Play className="size-5 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
            <p className="text-sm text-[var(--app-text-muted)]">No video.</p>
          </div>
        )}
      </section>
    </div>
  );
}
