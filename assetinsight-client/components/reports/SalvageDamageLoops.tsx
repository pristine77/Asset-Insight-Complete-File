"use client";

import type { SalvageDamageMark } from "@/services/salvage";

/*
  Damage loops on a saved Salvage photo (owner, 2026-11-01: loops are drawn on
  the report photo and stay editable in the preview). The photo is stored
  clean; the loops are its points in fractions of the photo, drawn here over
  the photo exactly where they print in the report. Place this inside a
  relative box the size of the whole photo (not a cropped thumbnail).
*/
export const DAMAGE_COLOR = "#dc2626";

export function DamageLoopOverlay({ loops }: { loops: { points: [number, number][] }[] }) {
  if (!loops.length) return null;
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        {loops.map((loop, index) => (
          <polygon key={index} points={loop.points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none"
            stroke={DAMAGE_COLOR} strokeWidth={3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        ))}
      </svg>
      {loops.map((loop, index) => {
        const left = Math.min(...loop.points.map(([x]) => x));
        const top = Math.min(...loop.points.map(([, y]) => y));
        return (
          <span key={index} aria-hidden="true"
            className="pointer-events-none absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[11px] font-bold text-white shadow"
            style={{ left: `${left * 100}%`, top: `${top * 100}%`, background: DAMAGE_COLOR }}>
            {index + 1}
          </span>
        );
      })}
    </>
  );
}

/** The loops saved on one photo. */
export function photoLoops(marks: SalvageDamageMark[], photoIndex: number) {
  return marks.find((mark) => mark.photoIndex === photoIndex)?.loops || [];
}

/** The marks with one photo's loops replaced (none removes the photo's entry). */
export function marksWithLoops(marks: SalvageDamageMark[], photoIndex: number, loops: { points: [number, number][] }[]): SalvageDamageMark[] {
  const others = marks.filter((mark) => mark.photoIndex !== photoIndex);
  return (loops.length ? [...others, { photoIndex, loops }] : others).sort((a, b) => a.photoIndex - b.photoIndex);
}
