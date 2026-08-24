import type { ButtonHTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";

type ButtonVariant =
  | "default"
  | "primary"
  | "accent"
  | "ghost"
  | "destructive"
  | "inverse"
  | "inverse-outline";
type ButtonSize = "md" | "sm";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner ahead of the content and disables the button. */
  loading?: boolean;
};

// default and primary render byte-for-byte as before this module existed; the
// new variants carry their own hover feedback.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "border border-line-strong bg-surface text-ink",
  primary: "border border-ink bg-ink text-white",
  // A page's one unmissable call to action (the model page's "Open in
  // Playground"): brand green so it cannot be read as another table control.
  accent: "border border-accent bg-accent text-white transition-opacity hover:opacity-90",
  ghost: "border border-transparent bg-transparent text-muted transition-colors hover:bg-surface-subtle hover:text-foreground",
  destructive: "border border-red-200 bg-surface text-red-600 transition-colors hover:border-red-300 hover:bg-red-50",
  // The onboard-* surfaces are dark; these two carry the primary/secondary
  // pair there (onboarding kickoff and its trace-source step).
  inverse:
    "border border-onboard-text bg-onboard-text text-onboard-bg transition-colors hover:border-white hover:bg-white",
  "inverse-outline":
    "border border-onboard-border bg-transparent text-onboard-text transition-colors hover:border-white/30 hover:bg-white/[0.04]"
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: "min-h-[38px] px-4 text-sm",
  sm: "min-h-[30px] px-3 text-[13px]"
};

// Shared with the rare link-that-looks-like-a-button (e.g. the connector
// Connect anchor, a top-level navigation), so the style has one home.
export function buttonClassName(
  variant: ButtonVariant = "default",
  className?: string,
  size: ButtonSize = "md"
): string {
  return clsx(
    "inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-semibold cursor-pointer disabled:cursor-not-allowed disabled:opacity-55",
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    className
  );
}

export function Button({
  children,
  className,
  disabled,
  loading = false,
  size = "md",
  variant = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      className={buttonClassName(variant, className, size)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          data-testid="button-spinner"
        />
      ) : null}
      {children}
    </button>
  );
}
