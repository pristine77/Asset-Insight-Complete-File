"use client";

import { useRef } from "react";
import { MapPin, Upload, X } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
import { useLocalImagePreview } from "./useLocalImagePreview";

interface MapUploadSectionProps {
  mapImage: File | null;
  onMapImageChange: (files: FileList | null) => void;
  onRemoveMapImage: () => void;
  /** The section's place in the form (6 with Farmland, 5 without). */
  step?: number;
}

/* An optional map or location image, printed in the report only (owner, 2026-11-01: "professional and easy usability"). */
export default function MapUploadSection({
  mapImage,
  onMapImageChange,
  onRemoveMapImage,
  step,
}: MapUploadSectionProps) {
  const mapInputRef = useRef<HTMLInputElement>(null);
  const previewUrl = useLocalImagePreview(mapImage, 224);

  return (
    <CollapsibleSection step={step} title="Map image" description="A map or aerial view of the location, shown in the report." icon={<MapPin />} optional>
      <input ref={mapInputRef} type="file" accept="image/*" onChange={(e) => onMapImageChange(e.target.files)} className="sr-only" aria-label="Choose a map image" />

      {mapImage ? (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] p-3">
          {previewUrl ? (
            <img src={previewUrl} alt="Map" className="size-14 rounded-md border border-[var(--app-border)] object-cover" />
          ) : (
            <div className="size-14 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)]" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--app-text)]">{mapImage.name}</p>
            <p className="text-xs text-[var(--app-text-muted)]">{(mapImage.size / 1024).toFixed(0)} KB</p>
          </div>
          <button type="button" onClick={() => mapInputRef.current?.click()} className="app-button app-button--secondary">Replace</button>
          <button type="button" onClick={onRemoveMapImage} aria-label="Remove map image" className="app-button app-button--icon text-[var(--app-danger)]">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-[var(--app-border-strong)] bg-[var(--app-panel-alt)] p-4">
          <MapPin className="size-6 shrink-0 text-[var(--app-text-muted)]" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-[var(--app-text-muted)]">No map image added.</p>
          <button type="button" onClick={() => mapInputRef.current?.click()} className="app-button app-button--secondary">
            <Upload className="size-4" aria-hidden="true" /> Choose image
          </button>
        </div>
      )}
    </CollapsibleSection>
  );
}
