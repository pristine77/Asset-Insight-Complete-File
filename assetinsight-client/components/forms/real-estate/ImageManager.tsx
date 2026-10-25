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
    <div className="space-y-4">
      {/* Main Images */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--app-text)]">
            Main Images ({mainImages.length})
          </h3>
          <div className="flex gap-2">
            {mainImages.length > 0 && (
              <button
                type="button"
                onClick={downloadAllMainImages}
                className="inline-flex items-center gap-1 rounded-lg bg-[var(--app-panel)] border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)]"
              >
                <Download className="h-3.5 w-3.5" />
                Download All
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--app-panel)] border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload
            </button>
            <button
              type="button"
              onClick={() => onOpenCamera("main")}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Camera className="h-3.5 w-3.5" />
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
                  className="absolute top-1 right-1 rounded-full bg-red-600 p-1.5 text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] p-8 text-center">
            <Camera className="mx-auto h-12 w-12 text-[var(--app-text-muted)]" />
            <p className="mt-2 text-sm text-[var(--app-text-muted)]">
              No main images yet. Add property images.
            </p>
          </div>
        )}
      </section>

      {/* Extra Images (Report Only) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--app-text)]">
            Extra Images - Report Only ({extraImages.length})
          </h3>
          <div className="flex gap-2">
            {extraImages.length > 0 && (
              <button
                type="button"
                onClick={downloadAllExtraImages}
                className="inline-flex items-center gap-1 rounded-lg bg-[var(--app-panel)] border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)]"
              >
                <Download className="h-3.5 w-3.5" />
                Download All
              </button>
            )}
            <button
              type="button"
              onClick={() => extraFileInputRef.current?.click()}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--app-panel)] border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload
            </button>
            <button
              type="button"
              onClick={() => onOpenCamera("extra")}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-lg bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Camera className="h-3.5 w-3.5" />
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
                  className="absolute top-1 right-1 rounded-full bg-red-600 p-1.5 text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] p-6 text-center">
            <Upload className="mx-auto h-10 w-10 text-[var(--app-text-muted)]" />
            <p className="mt-2 text-sm text-[var(--app-text-muted)]">
              No extra images yet. Add supplementary photos.
            </p>
          </div>
        )}
      </section>

      {/* Video */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--app-text)]">
            Video {videoFile ? "(1/1)" : "(0/1)"}
          </h3>
          {!videoFile && (
            <button
              type="button"
              onClick={() => videoUploadInputRef.current?.click()}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--app-panel)] border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload Video
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
          <div className="relative group rounded-lg border border-[var(--app-border)] bg-blue-50 p-4">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 rounded-full bg-blue-100 p-3">
                <Play className="h-6 w-6 text-blue-600" />
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
                className="flex-shrink-0 rounded-full bg-red-600 p-2 text-white hover:bg-red-700 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] p-6 text-center">
            <Play className="mx-auto h-10 w-10 text-[var(--app-text-muted)]" />
            <p className="mt-2 text-sm text-[var(--app-text-muted)]">No video yet.</p>
            <p className="text-xs text-[var(--app-text-muted)] mt-1">
              1 video allowed (captured via camera or uploaded)
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
