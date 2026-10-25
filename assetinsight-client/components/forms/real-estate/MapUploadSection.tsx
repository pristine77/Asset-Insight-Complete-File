"use client";

import { useRef } from "react";
import { MapPin, Upload, X } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
import { useLocalImagePreview } from "./useLocalImagePreview";

interface MapUploadSectionProps {
  mapImage: File | null;
  onMapImageChange: (files: FileList | null) => void;
  onRemoveMapImage: () => void;
}

export default function MapUploadSection({
  mapImage,
  onMapImageChange,
  onRemoveMapImage,
}: MapUploadSectionProps) {
  const mapInputRef = useRef<HTMLInputElement>(null);
  const previewUrl = useLocalImagePreview(mapImage, 224);

  return (
    <CollapsibleSection title="Map Image" icon={<MapPin className="text-blue-600" />} filledCount={mapImage ? 1 : 0} totalCount={1}>
      <input ref={mapInputRef} type="file" accept="image/*" onChange={(e) => onMapImageChange(e.target.files)} className="sr-only" />

      {mapImage ? (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
          {previewUrl ? (

            <img src={previewUrl} alt="Map" className="h-14 w-14 rounded-lg border border-[var(--app-border)] object-cover" />
          ) : (
            <div className="h-14 w-14 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)]" aria-hidden="true" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-[var(--app-text)] truncate">{mapImage.name}</p>
            <p className="text-[10px] text-[var(--app-text-muted)]">{(mapImage.size / 1024).toFixed(0)} KB</p>
          </div>
          <button type="button" onClick={onRemoveMapImage} aria-label="Remove map image" className="cursor-pointer rounded-md border border-red-200 bg-red-50 p-2 text-red-600 transition-colors hover:bg-red-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel-alt)] p-5 text-center">
          <MapPin className="mx-auto h-7 w-7 text-[var(--app-text-muted)]" />
          <p className="text-[11px] text-[var(--app-text-muted)] mt-1.5 font-medium">Optional location image</p>
          <button type="button" onClick={() => mapInputRef.current?.click()} className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800">
            <Upload className="h-3.5 w-3.5" /> Select
          </button>
        </div>
      )}
    </CollapsibleSection>
  );
}
