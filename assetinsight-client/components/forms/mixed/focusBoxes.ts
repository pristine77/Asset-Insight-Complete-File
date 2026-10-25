import type { MixedLot } from "./types";
import { getMixedFileKey } from "./types";

export type MixedFocusBoxPayload = {
  imageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * The upload contract flattens every lot as main files followed by extras.
 * Focus boxes are supported only for main files, but their indices must still
 * account for extras in every preceding lot.
 */
export function buildMixedFocusBoxes(
  lots: MixedLot[]
): MixedFocusBoxPayload[] {
  const focusBoxes: MixedFocusBoxPayload[] = [];
  let globalImageIndex = 0;

  for (const lot of lots) {
    for (const file of lot.files) {
      const boxes = lot.annotations?.[getMixedFileKey(file)] || [];
      for (const box of boxes) {
        if (
          Number.isFinite(box.x) &&
          Number.isFinite(box.y) &&
          Number.isFinite(box.w) &&
          Number.isFinite(box.h)
        ) {
          focusBoxes.push({
            imageIndex: globalImageIndex,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
          });
        }
      }
      globalImageIndex += 1;
    }
    globalImageIndex += lot.extraFiles.length;
  }

  return focusBoxes;
}
