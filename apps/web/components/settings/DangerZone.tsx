"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { readApiError } from "@/components/world-models/wm-client";
import { signinPath } from "@/lib/routes";

const INPUT_CLASS =
  "min-h-[34px] w-full max-w-[360px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";

/**
 * Typed-confirmation destructive action: the button stays disabled until the
 * user retypes the expected phrase, so neither action is one accidental
 * click away.
 */
function ConfirmedAction({
  confirmValue,
  confirmLabel,
  buttonLabel,
  onConfirmed
}: {
  confirmValue: string;
  confirmLabel: string;
  buttonLabel: string;
  onConfirmed: () => Promise<string | null>;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act() {
    if (typed !== confirmValue || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const failure = await onConfirmed();
      if (failure !== null) {
        setError(failure);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] text-muted">{confirmLabel}</span>
        <input
          className={INPUT_CLASS}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={confirmValue}
          value={typed}
        />
      </label>
      <div>
        <Button
          disabled={typed !== confirmValue}
          loading={busy}
          onClick={() => void act()}
          type="button"
          variant="destructive"
        >
          {buttonLabel}
        </Button>
      </div>
      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * Organization danger zone: wipe every world model and telemetry row while
 * the org, its members, keys, limits, and spend history survive.
 */
export function DeleteOrgDataCard({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const router = useRouter();
  const [done, setDone] = useState<string | null>(null);

  return (
    <section className="border border-danger/25 rounded-lg bg-surface p-[18px]">
      <div className="grid gap-[18px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.45fr)]">
        <div>
          <p className="m-0 text-danger/70 text-[11px] font-medium tracking-[0.04em] uppercase">
            Danger zone
          </p>
          <h2 className="m-0 mt-2 text-[#171717] text-[15px] font-semibold tracking-tight">
            Delete all data
          </h2>
          <p className="m-0 mt-2 max-w-[360px] text-muted text-[13px] leading-relaxed">
            Permanently deletes every simulation with its traces, builds, sessions, rollouts,
            telemetry, and imported trace files. The organization itself survives: members, API
            keys, stored connections, the usage limit, and spend history stay. This cannot be
            undone.
          </p>
        </div>
        <div className="self-center">
          {done ? (
            <p className="m-0 text-[13px] text-muted">{done}</p>
          ) : (
            <ConfirmedAction
              buttonLabel="Delete all data"
              confirmLabel={`Type the organization slug (${orgSlug}) to confirm.`}
              confirmValue={orgSlug}
              onConfirmed={async () => {
                const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/data`, {
                  method: "DELETE"
                });
                if (!response.ok) {
                  return readApiError(response, "Unable to delete the organization's data.");
                }
                const body = (await response.json()) as { deleted_world_models: number };
                setDone(
                  `Deleted ${body.deleted_world_models} simulation${body.deleted_world_models === 1 ? "" : "s"} and all telemetry.`
                );
                router.refresh();
                return null;
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Account danger zone: delete the signed-in account. Organizations and their
 * data survive; "delete all data" is the separate, org-scoped action.
 */
export function DeleteAccountCard({ email }: { email: string }) {
  const router = useRouter();

  return (
    <section className="border border-danger/25 rounded-lg bg-surface p-[18px]">
      <div className="grid gap-[18px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.45fr)]">
        <div>
          <p className="m-0 text-danger/70 text-[11px] font-medium tracking-[0.04em] uppercase">
            Danger zone
          </p>
          <h2 className="m-0 mt-2 text-[#171717] text-[15px] font-semibold tracking-tight">
            Delete account
          </h2>
          <p className="m-0 mt-2 max-w-[360px] text-muted text-[13px] leading-relaxed">
            Permanently deletes your account and removes you from every organization.
            Organizations and their data survive; if you are the only admin of an organization
            with other members, hand off the admin role first. This cannot be undone.
          </p>
        </div>
        <div className="self-center">
          <ConfirmedAction
            buttonLabel="Delete account"
            confirmLabel={`Type your email (${email}) to confirm.`}
            confirmValue={email}
            onConfirmed={async () => {
              const response = await fetch("/api/account", { method: "DELETE" });
              if (!response.ok) {
                return readApiError(response, "Unable to delete the account.");
              }
              // The auth user is gone; drop the dead session cookie and land
              // on sign-in.
              await fetch("/auth/sign-out", { method: "POST" }).catch(() => {});
              router.push(signinPath());
              router.refresh();
              return null;
            }}
          />
        </div>
      </div>
    </section>
  );
}
