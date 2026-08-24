import type { CSSProperties } from "react";

type ShimmerProps = {
  className?: string;
  style?: CSSProperties;
};

/**
 * Shimmering placeholder block shared by loading skeletons. The
 * `animate-skeleton` utility is disabled under prefers-reduced-motion, so callers
 * get accessible loading affordances for free. Size/spacing via `className`.
 */
export function Shimmer({ className = "", style }: ShimmerProps) {
  return (
    <span
      aria-hidden
      className={`block rounded-lg bg-gradient-to-r from-surface-subtle via-foreground/[0.06] to-surface-subtle bg-[length:400%_100%] animate-skeleton ${className}`}
      style={style}
    />
  );
}
