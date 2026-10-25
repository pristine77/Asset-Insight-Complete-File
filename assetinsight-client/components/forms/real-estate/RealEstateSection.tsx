"use client";

import React, { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import PropertyTypeSelector, {
  type PropertyType,
} from "./PropertyTypeSelector";
import ImageManager from "./ImageManager";
import RealEstateCameraUI from "./RealEstateCameraUI";

export type RealEstateProperty = {
  id: string;
  propertyType?: PropertyType;
  mainImages: File[];
  extraImages: File[];
  videoFile?: File;
};

type Props = {
  value: RealEstateProperty | null;
  onChange: (property: RealEstateProperty | null) => void;
  maxImages?: number;
  downloadPrefix?: string;
};

export default function RealEstateSection({
  value,
  onChange,
  maxImages = 50,
  downloadPrefix,
}: Props) {
  const [property, setProperty] = useState<RealEstateProperty | null>(
    value || null
  );
  const [cameraOpen, setCameraOpen] = useState(false);

  useEffect(() => {
    setProperty(value || null);
  }, [value]);

  useEffect(() => {
    onChange(property);
  }, [property]);

  function handlePropertyTypeChange(type: PropertyType) {
    if (!property) {
      const id = `property-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      setProperty({
        id,
        propertyType: type,
        mainImages: [],
        extraImages: [],
      });
    } else {
      setProperty({ ...property, propertyType: type });
    }
  }

  function handleAddMainImages(incoming: File[]) {
    if (!property) {
      toast.warn("Select a property type first.");
      return;
    }
    if (!property.propertyType) {
      toast.warn("Select a property type first.");
      return;
    }

    setProperty({
      ...property,
      mainImages: [...property.mainImages, ...incoming],
    });
  }

  function handleAddExtraImages(incoming: File[]) {
    if (!property) {
      toast.warn("Select a property type first.");
      return;
    }

    setProperty({
      ...property,
      extraImages: [...property.extraImages, ...incoming],
    });
  }

  function handleAddVideo(file: File) {
    if (!property) {
      toast.warn("Select a property type first.");
      return;
    }

    if (property.videoFile) {
      toast.warn("Only 1 video allowed. Replacing existing video.");
    }

    setProperty({
      ...property,
      videoFile: file,
    });
  }

  function handleRemoveMainImage(index: number) {
    if (!property) return;
    setProperty({
      ...property,
      mainImages: property.mainImages.filter((_, i) => i !== index),
    });
  }

  function handleRemoveExtraImage(index: number) {
    if (!property) return;
    setProperty({
      ...property,
      extraImages: property.extraImages.filter((_, i) => i !== index),
    });
  }

  function handleRemoveVideo() {
    if (!property) return;
    setProperty({
      ...property,
      videoFile: undefined,
    });
  }

  function handleOpenCamera(mode: "main" | "extra") {
    if (!property || !property.propertyType) {
      toast.warn("Select a property type first.");
      return;
    }
    setCameraOpen(true);
  }

  function handleCloseCamera() {
    setCameraOpen(false);
  }

  return (
    <div className="space-y-6">
      {/* Property Type Selection */}
      <PropertyTypeSelector
        value={property?.propertyType}
        onChange={handlePropertyTypeChange}
      />

      {/* Image and Video Management */}
      {property?.propertyType && (
        <ImageManager
          mainImages={property.mainImages}
          extraImages={property.extraImages}
          videoFile={property.videoFile}
          maxImages={maxImages}
          onAddMainImages={handleAddMainImages}
          onAddExtraImages={handleAddExtraImages}
          onAddVideo={handleAddVideo}
          onRemoveMainImage={handleRemoveMainImage}
          onRemoveExtraImage={handleRemoveExtraImage}
          onRemoveVideo={handleRemoveVideo}
          onOpenCamera={handleOpenCamera}
          disabled={false}
        />
      )}

      {/* Camera UI Overlay */}
      <RealEstateCameraUI
        open={cameraOpen}
        onClose={handleCloseCamera}
        onAddMainImages={handleAddMainImages}
        onAddExtraImages={handleAddExtraImages}
        onAddVideo={handleAddVideo}
        downloadPrefix={downloadPrefix}
        hasVideo={!!property?.videoFile}
        mainImageCount={property?.mainImages.length || 0}
        extraImageCount={property?.extraImages.length || 0}
      />
    </div>
  );
}
