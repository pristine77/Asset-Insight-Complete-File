"use client";

import type { CSSProperties } from "react";

export type LottiePlayerProps = {
  /** Retained for backward compatibility while legacy animation call sites migrate. */
  src?: unknown;
  /** Retained for backward compatibility while legacy animation call sites migrate. */
  animationData?: unknown;
  loop?: boolean;
  autoplay?: boolean;
  className?: string;
  style?: CSSProperties;
  width?: number;
  height?: number;
};

/**
 * Lightweight compatibility shell for former Lottie placements.
 *
 * ClearValue no longer downloads or runs animation JSON. The element preserves an
 * explicitly requested layout box so older call sites do not shift while remaining
 * inert and invisible to assistive technology.
 */
export default function LottiePlayer({
  className,
  style,
  width,
  height,
}: LottiePlayerProps) {
  return (
    <span
      className={className}
      style={{
        display: "block",
        width: width ?? style?.width,
        height: height ?? style?.height,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}
