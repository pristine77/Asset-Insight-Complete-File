import type { AnnBox } from "./ImageAnnotator";

export type MixedMode = "single_lot" | "per_item" | "per_photo";

export type CameraLens = {
  id: string;
  label: string;
  type: "ultrawide" | "main" | "telephoto";
  zoom: number;
};

export type MixedLot = {
  id: string;
  /** Opaque upstream identity used to preserve an integration lot mapping. */
  source?: {
    key: string;
    /**
     * The Schedule A line this lot was split out of.
     *
     * Set only on a lot the appraiser ADDED beneath an upstream lot. Auctioneer
     * listed one line; the appraiser sends several lots back for it, and
     * without this they arrive as extras that cannot be placed against anything
     * — the mismatch needs_reconciliation exists to catch. The lot keeps its own
     * unique `key` so nothing downstream collides; parentKey is the attribution.
     */
    parentKey?: string;
    lotId?: string;
    submissionId?: string;
    lotNumber?: string;
    label?: string;
    title?: string;
    description?: string;
    locked?: boolean;
    /**
     * The Schedule A line this lot belongs to is ticked "Several lots" in
     * Auctioneer 2.0, so lots may be split off it (owner 2026-10-28). Copied
     * onto every split, so a split of a split still carries the original
     * line's answer. Absent means the line comes back as exactly one lot.
     */
    severalLots?: boolean;
    /**
     * The lot captures one listed item of a Proposal (owner 2026-10-28):
     * `key` names the item, and one item is one lot, so the analysis mode is
     * fixed. Lots without it on such a form are items that were not listed.
     */
    listed?: boolean;
  };
  /** Main images sent through the analysis workflow. */
  files: File[];
  /** Report-only images that are not analyzed. */
  extraFiles: File[];
  /** Zero-based index within `files`. */
  coverIndex: number;
  mode?: MixedMode;
  /** Optional report-only videos. */
  videoFiles?: File[];
  /** Normalized focus boxes, keyed by the persisted file signature. */
  annotations?: Record<string, AnnBox[]>;
};

/**
 * Persistable identity for media and annotation records. This intentionally
 * does not rely on object identity so it survives draft serialization.
 */
export function getMixedFileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified || 0}`;
}
