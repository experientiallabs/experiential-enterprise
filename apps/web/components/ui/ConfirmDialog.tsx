"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useId, type ReactNode } from "react";

import { Button } from "./Button";

/**
 * Which kind of consequence is being confirmed. Danger is for the irreversible
 * (deleting a resource); warning is for the disruptive but recoverable (asking
 * an emitter to stop a run); neutral drops the alert badge for non-destructive
 * form dialogs (the admin Add-organization flow).
 */
type ConfirmTone = "danger" | "warning" | "neutral";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Label while the action is in flight; the dialog stays open behind it. */
  busyLabel: string;
  busy: boolean;
  tone?: ConfirmTone;
  /** Extra form content between the body and the footer — the admin ban
   * dialog's required reason field. The caller owns its state and validates
   * it in onConfirm (surface failures through `error`). */
  children?: ReactNode;
  /** Failure text from the action, rendered inside the dialog. */
  error?: string | null;
  /** The dismiss button's label; "Done" where dismissal is the happy path. */
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmVariant?: "primary" | "destructive";
  /** Overrides the confirm button's styling where a variant is not enough. */
  confirmClassName?: string;
};

const TONE_BADGE: Record<Exclude<ConfirmTone, "neutral">, string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning"
};

/**
 * The modal shell behind every confirm-then-act button: the overlay, the escape
 * and click-away handling, the aria wiring, and the cancel/confirm footer.
 *
 * It owns none of the action. Callers keep their own trigger, their own request,
 * and their own idea of what "busy" means, and pass the result in - which is why
 * this is a dialog rather than a button: the two callers' triggers and outcomes
 * (a redirect, a queued control request) have nothing in common, only the shell
 * does. Closing is refused while busy, so a request in flight cannot be
 * abandoned halfway by an escape key.
 */
export function ConfirmDialog({
  body,
  busy,
  busyLabel,
  cancelLabel = "Cancel",
  children,
  confirmClassName,
  confirmLabel,
  confirmVariant = "primary",
  error,
  onCancel,
  onConfirm,
  open,
  title,
  tone = "warning"
}: ConfirmDialogProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        onCancel();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onCancel, open]);

  if (!open) {
    return null;
  }

  const close = () => {
    if (!busy) {
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-6" onClick={close}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-[460px] rounded-[var(--radius-lg)] border border-line bg-surface p-[18px] shadow-[0_18px_50px_rgba(20,20,18,0.14)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start gap-3">
          {tone !== "neutral" ? (
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${TONE_BADGE[tone]}`}
            >
              <AlertTriangle aria-hidden size={18} strokeWidth={1.8} />
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 className="m-0 text-[15px] font-semibold text-ink" id={titleId}>
              {title}
            </h2>
            <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-muted">{body}</p>
          </div>
        </div>

        {children}

        {error ? (
          <p className="m-0 mt-4 rounded-[var(--radius-md)] border border-danger bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2.5">
          <Button autoFocus disabled={busy} onClick={close} type="button">
            {cancelLabel}
          </Button>
          <Button
            className={confirmClassName}
            disabled={busy}
            onClick={onConfirm}
            type="button"
            variant={confirmVariant}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
