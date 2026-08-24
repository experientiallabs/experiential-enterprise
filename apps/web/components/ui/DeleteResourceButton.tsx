"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { readApiError } from "@/components/world-models/wm-client";

type DeleteResourceButtonProps = {
  deletePath: string;
  errorFallback: string;
  redirectPath: string;
  resourceLabel: string;
  resourceName: string;
  triggerAriaLabel?: string;
};

/** Destructive resource action guarded by an explicit warning dialog. */
export function DeleteResourceButton({
  deletePath,
  errorFallback,
  redirectPath,
  resourceLabel,
  resourceName,
  triggerAriaLabel
}: DeleteResourceButtonProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setIsOpen(false);
    setError(null);
  }

  async function confirmDelete() {
    setError(null);
    setIsDeleting(true);
    try {
      const response = await fetch(deletePath, { method: "DELETE" });
      if (!response.ok) {
        setError(await readApiError(response, errorFallback));
        return;
      }
      setIsOpen(false);
      router.replace(redirectPath);
      router.refresh();
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <Button
        aria-label={triggerAriaLabel}
        onClick={() => setIsOpen(true)}
        type="button"
      >
        <Trash2 aria-hidden size={14} strokeWidth={1.8} />
        Delete
      </Button>

      <ConfirmDialog
        body={
          <>
            This permanently deletes the {resourceLabel}{" "}
            <span className="font-mono text-ink">{resourceName}</span> and all related data. This
            action cannot be undone.
          </>
        }
        busy={isDeleting}
        busyLabel="Deleting…"
        confirmClassName="border-danger bg-danger text-white"
        confirmLabel={`Delete ${resourceLabel}`}
        error={error}
        onCancel={close}
        onConfirm={() => void confirmDelete()}
        open={isOpen}
        title="Are you sure you want to delete this?"
        tone="danger"
      />
    </>
  );
}
