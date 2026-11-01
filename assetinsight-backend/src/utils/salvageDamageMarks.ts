/**
 * Damage the appraiser loops on Salvage photos (owner, 2026-11-01: "draw around
 * the damaged area so the software knows exactly where the damage is and
 * concentrates on the marked area"; Salvage only; freehand loop; the report
 * prints the photo with the loops on it; the loops stay editable in the
 * preview and are saved with "Save changes").
 *
 * The photo is stored clean. Each loop is kept as its points, as fractions of
 * the photo's width and height (0..1, top-left origin), per photo by its upload
 * position. From them:
 *  - the analysis sees the loops drawn on the photo, plus a full-detail
 *    close-up of each loop's area cut from the clean original;
 *  - the report's photos are printed with the loops drawn on;
 *  - the website draws them over the photo, and the preview can change them.
 * Each loop's box (`regions`) is derived here, never taken from the client.
 */
import sharp from "sharp";

export type SalvageDamagePoint = [number, number];
export type SalvageDamageLoop = { points: SalvageDamagePoint[] };
export type SalvageDamageRegion = { x: number; y: number; width: number; height: number };
export type SalvageDamageMark = { photoIndex: number; loops: SalvageDamageLoop[]; regions: SalvageDamageRegion[] };

/** Four loops per photo: forty close-ups at most beside a batch of ten photos. */
export const SALVAGE_MAX_DAMAGE_REGIONS_PER_PHOTO = 4;
/** Points kept per loop; the website thins longer strokes before sending. */
export const SALVAGE_MAX_LOOP_POINTS = 400;
/**
 * Two loops whose boxes overlap this much circle the same damage: the later one
 * is a redraw and replaces the earlier, so one damaged area is inspected once
 * however many times it was drawn (owner, 2026-11-01: "one edit per damage").
 */
export const SAME_DAMAGE_OVERLAP = 0.6;

/** Overlap of two boxes as intersection over union, 0..1. */
export function regionOverlap(a: SalvageDamageRegion, b: SalvageDamageRegion): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const shared = width * height;
  const union = a.width * a.height + b.width * b.height - shared;
  return union > 0 ? shared / union : 0;
}

/** A loop smaller than 1% of the photo on either side is a slip of the pen, not a marked area. */
const MIN_REGION_SIZE = 0.01;
export const SALVAGE_DAMAGE_COLOR = "#dc2626";

export class SalvageDamageMarkError extends Error {}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

function loopBox(points: SalvageDamagePoint[]): SalvageDamageRegion {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return { x: round4(minX), y: round4(minY), width: round4(maxX - minX), height: round4(maxY - minY) };
}

/**
 * The marks sent with a report or a preview save, checked and tidied: one
 * entry per marked photo, sorted by photo, points kept inside the photo, boxes
 * derived from the points. Absent, null or empty means no marks. Anything
 * malformed is refused rather than guessed at.
 */
export function normalizeSalvageDamageMarks(raw: unknown, photoCount: number): SalvageDamageMark[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SalvageDamageMarkError("Damage marks must be a list.");
  if (raw.length > photoCount) throw new SalvageDamageMarkError("There are more damage marks than photos.");
  const byPhoto = new Map<number, SalvageDamageMark>();
  const seen = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SalvageDamageMarkError("Each damage mark must name its photo and loops.");
    const photoIndex = (entry as any).photoIndex;
    if (!Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= photoCount) {
      throw new SalvageDamageMarkError("A damage mark refers to a photo that is not in the report.");
    }
    if (seen.has(photoIndex)) throw new SalvageDamageMarkError("A photo's damage marks were sent twice.");
    seen.add(photoIndex);
    const loops = (entry as any).loops;
    if (!Array.isArray(loops) || loops.length > SALVAGE_MAX_DAMAGE_REGIONS_PER_PHOTO) {
      throw new SalvageDamageMarkError(`Mark at most ${SALVAGE_MAX_DAMAGE_REGIONS_PER_PHOTO} damaged areas on one photo.`);
    }
    const kept: SalvageDamageLoop[] = [];
    for (const loop of loops) {
      const points = loop?.points;
      if (!Array.isArray(points) || points.length < 3 || points.length > SALVAGE_MAX_LOOP_POINTS) {
        throw new SalvageDamageMarkError(`A damage loop must have between 3 and ${SALVAGE_MAX_LOOP_POINTS} points.`);
      }
      const clean: SalvageDamagePoint[] = points.map((point: unknown) => {
        const [x, y] = Array.isArray(point) ? point : [];
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) ||
          x < -0.001 || y < -0.001 || x > 1.001 || y > 1.001) {
          throw new SalvageDamageMarkError("A damage loop lies outside its photo.");
        }
        return [round4(Math.min(1, Math.max(0, x))), round4(Math.min(1, Math.max(0, y)))];
      });
      const box = loopBox(clean);
      if (box.width < MIN_REGION_SIZE || box.height < MIN_REGION_SIZE) continue;
      // A redraw of an area already looped replaces that loop in its place.
      const same = kept.findIndex((existing) => regionOverlap(loopBox(existing.points), box) >= SAME_DAMAGE_OVERLAP);
      if (same >= 0) kept[same] = { points: clean };
      else kept.push({ points: clean });
    }
    if (kept.length) byPhoto.set(photoIndex, { photoIndex, loops: kept, regions: kept.map((loop) => loopBox(loop.points)) });
  }
  return [...byPhoto.values()].sort((a, b) => a.photoIndex - b.photoIndex);
}

/**
 * The pixel box to cut for one marked area: the loop's box plus a margin of 15%
 * of its size on every side (so the close-up shows what surrounds the damage),
 * kept inside the photo and at least 64 px on each side where the photo allows.
 */
export function salvageDamageCropBox(region: SalvageDamageRegion, imageWidth: number, imageHeight: number) {
  const marginX = region.width * 0.15, marginY = region.height * 0.15;
  let left = Math.floor((region.x - marginX) * imageWidth);
  let top = Math.floor((region.y - marginY) * imageHeight);
  let right = Math.ceil((region.x + region.width + marginX) * imageWidth);
  let bottom = Math.ceil((region.y + region.height + marginY) * imageHeight);
  const grow = (start: number, end: number, limit: number): [number, number] => {
    const missing = Math.max(0, Math.min(64, limit) - (end - start));
    return [start - Math.floor(missing / 2), end + Math.ceil(missing / 2)];
  };
  [left, right] = grow(left, right, imageWidth);
  [top, bottom] = grow(top, bottom, imageHeight);
  left = Math.max(0, left); top = Math.max(0, top);
  right = Math.min(imageWidth, right); bottom = Math.min(imageHeight, bottom);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** The marks for each photo in upload order, for the photo preparation step. */
export function damageMarksByPhoto(marks: SalvageDamageMark[] | undefined, photoCount: number): (SalvageDamageMark | undefined)[] {
  const out: (SalvageDamageMark | undefined)[] = Array.from({ length: photoCount }, () => undefined);
  for (const mark of marks || []) if (mark.photoIndex >= 0 && mark.photoIndex < photoCount) out[mark.photoIndex] = mark;
  return out;
}

/*
  Loop numbers are drawn as strokes, not text: the server may have no fonts,
  and a missing font would print an empty disc. Glyphs sit in a 10 x 14 box.
*/
const DIGIT_PATHS: Record<number, string> = {
  1: "M3 3.5 L5.5 1 L5.5 13 M3 13 L8 13",
  2: "M2 4 Q2 1 5 1 Q8 1 8 4 Q8 6.5 2 13 L8.5 13",
  3: "M2 2.5 Q4 1 6 1 Q8.5 1 8.5 3.8 Q8.5 6.5 5 6.8 Q8.8 7 8.8 10 Q8.8 13 5.5 13 Q3 13 1.8 11.5",
  4: "M7 13 L7 1 L1.5 9.2 L9 9.2",
};

/** The loops of one photo as an SVG the size of the photo, for compositing onto it. */
export function damageLoopsSvg(loops: SalvageDamageLoop[], width: number, height: number): Buffer {
  const lineWidth = Math.max(4, Math.round(Math.max(width, height) / 240));
  const radius = Math.max(12, lineWidth * 2.4);
  const parts = loops.map((loop, index) => {
    const points = loop.points.map(([x, y]) => `${(x * width).toFixed(1)},${(y * height).toFixed(1)}`).join(" ");
    const box = loopBox(loop.points);
    const cx = Math.min(Math.max(box.x * width, radius), width - radius);
    const cy = Math.min(Math.max(box.y * height, radius), height - radius);
    const scale = (radius * 1.25) / 14;
    const digit = DIGIT_PATHS[index + 1] || DIGIT_PATHS[4];
    return `<polygon points="${points}" fill="none" stroke="${SALVAGE_DAMAGE_COLOR}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="${SALVAGE_DAMAGE_COLOR}"/>` +
      `<path d="${digit}" transform="translate(${(cx - 5 * scale).toFixed(1)} ${(cy - 7 * scale).toFixed(1)}) scale(${scale.toFixed(3)})" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`);
}

/** A JPEG with the loops drawn on it, at the image's own size. */
export async function drawDamageLoops(jpeg: Buffer, width: number, height: number, loops: SalvageDamageLoop[]): Promise<Buffer> {
  if (!loops.length) return jpeg;
  return sharp(jpeg).composite([{ input: damageLoopsSvg(loops, width, height), top: 0, left: 0 }]).jpeg({ quality: 82 }).toBuffer();
}
