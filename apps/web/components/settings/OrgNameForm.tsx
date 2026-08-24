"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { readApiError } from "@/components/world-models/wm-client";

type OrgNameFormProps = {
  orgId: string;
  initialName: string;
};

/** Org-admin rename; the slug (URL identity) deliberately stays immutable. */
export function OrgNameForm({ orgId, initialName }: OrgNameFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const unchanged = name.trim() === initialName || name.trim().length === 0;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unchanged || isSaving) {
      return;
    }
    setError(null);
    setSaved(false);
    setIsSaving(true);
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}`, {
        body: JSON.stringify({ name: name.trim() }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to rename the organization."));
        return;
      }
      setSaved(true);
      router.refresh();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={save}>
      <div className="flex items-center gap-2">
        <input
          aria-label="Organization name"
          className="w-full max-w-[360px] min-h-[34px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink focus:outline-none focus:border-[#bdbdbd]"
          maxLength={80}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          required
          value={name}
        />
        <Button disabled={unchanged} loading={isSaving} type="submit" variant="primary">
          Rename
        </Button>
      </div>
      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
      {saved && <p className="m-0 text-[13px] text-muted">Saved.</p>}
    </form>
  );
}
