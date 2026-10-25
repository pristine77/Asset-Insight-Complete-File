"use client";

import { useEffect, useState } from "react";

async function createThumbnailUrl(file: File, maxDimension: number) {
  if (
    !file.type.startsWith("image/") ||
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  ) {
    return URL.createObjectURL(file);
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const largestDimension = Math.max(bitmap.width, bitmap.height);
    if (largestDimension <= maxDimension) return URL.createObjectURL(file);

    const scale = maxDimension / largestDimension;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return URL.createObjectURL(file);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.78)
    );
    return URL.createObjectURL(thumbnail || file);
  } catch {
    return URL.createObjectURL(file);
  } finally {
    bitmap?.close();
  }
}

export function useLocalImagePreview(
  file: File | null | undefined,
  maxDimension = 512
) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setPreviewUrl(null);
    if (
      !file ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function"
    ) {
      return;
    }

    let disposed = false;
    let activeUrl: string | null = null;
    void createThumbnailUrl(file, maxDimension).then((url) => {
      if (disposed) {
        URL.revokeObjectURL(url);
        return;
      }
      activeUrl = url;
      setPreviewUrl(url);
    });

    return () => {
      disposed = true;
      if (activeUrl) URL.revokeObjectURL(activeUrl);
    };
  }, [file, maxDimension]);

  return previewUrl;
}
