import { siYcombinator } from "simple-icons";

/**
 * The Y Combinator logo for the /signin YC-deal variant. Path and the brand
 * orange come from simple-icons — a partner's logo keeps its own brand color
 * and is deliberately outside the one-accent token rule.
 */
export function YCombinatorMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d={siYcombinator.path} fill={`#${siYcombinator.hex}`} />
    </svg>
  );
}
