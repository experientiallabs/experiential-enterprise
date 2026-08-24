// The recommended (preferred_rank) marker. the product owner, r2: the faint-green row tint
// alone was "not obvious enough" — a filled gold star is the primary, scannable
// signal that a model is recommended, shown wherever a model row appears
// (catalog table, detail header, picker). Gold is the one decorative accent
// allowed outside the status palette (--accent-amber), same token as the
// GitHub-star fill; it never encodes a status.

import { Star } from "lucide-react";
import { clsx } from "clsx";

/** Filled gold star shown next to a recommended (preferred_rank) model. */
export function RecommendedStar({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <Star
      aria-label="Recommended"
      className={clsx("shrink-0 fill-accent-amber text-accent-amber", className)}
      height={size}
      role="img"
      width={size}
    />
  );
}
