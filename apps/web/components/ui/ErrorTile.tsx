"use client";

import { AlertTriangle } from "lucide-react";

import { Button } from "./Button";

type ErrorTileProps = {
  title: string;
  message?: string | null;
  detail?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
};

export function ErrorTile({
  title,
  message,
  detail,
  onRetry,
  retryLabel = "Try again"
}: ErrorTileProps) {
  return (
    <section className="flex flex-col gap-2.5 items-start border border-danger rounded-[var(--radius-lg)] bg-danger-soft p-[18px]" role="alert">
      <div className="flex items-center gap-2 text-danger">
        <AlertTriangle aria-hidden size={16} />
        <h2 className="m-0 text-[0.95rem] font-semibold">{title}</h2>
      </div>
      {message ? <p className="m-0 text-muted">{message}</p> : null}
      {detail ? <pre className="w-full m-0 px-3 py-2.5 rounded-[var(--radius-md)] bg-surface border border-line text-danger text-[0.8rem] whitespace-pre-wrap break-words overflow-x-auto">{detail}</pre> : null}
      {onRetry ? (
        <Button onClick={() => onRetry()}>
          {retryLabel}
        </Button>
      ) : null}
    </section>
  );
}
