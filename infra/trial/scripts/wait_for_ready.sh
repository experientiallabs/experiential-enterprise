#!/bin/sh
# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# Operator-side readiness gate. Each terraform root runs this from a
# local-exec provisioner on YOUR machine (never on the VM, so no SSH port has
# to be open) and polls the public endpoint until it serves HTTPS. Exit 0 ends
# the apply successfully; exit 1 fails it, so `terraform apply` can no longer
# report success while the advertised URL is dead.
#
# Inputs arrive as environment variables, never interpolated into a command
# line, so a host name or budget can never be word-split or re-quoted:
#   EXPLABS_TRIAL_URL       full https:// URL to poll (the /health endpoint)
#   EXPLABS_TRIAL_BUDGET    seconds to keep trying before failing
#   EXPLABS_TRIAL_INSECURE  non-empty to skip verification (self-signed only)
#
# POSIX sh on purpose: this runs on whatever /bin/sh the operator has, macOS
# or Linux. No arrays, no [[, no local, and no unquoted option splatting.
set -eu

url="${EXPLABS_TRIAL_URL:?wait_for_ready: EXPLABS_TRIAL_URL is required}"
budget="${EXPLABS_TRIAL_BUDGET:?wait_for_ready: EXPLABS_TRIAL_BUDGET is required}"
insecure="${EXPLABS_TRIAL_INSECURE:-}"

interval=20
# Progress every sixth poll, so a 40-minute wait prints about 20 lines.
progress_every=6

# One probe. The two curl invocations are spelled out rather than assembled
# into a variable: an unquoted "$opts" splat is the classic sh quoting bug,
# and -k is a security-relevant flag that should be visible at its use site.
# Quiet per poll, because 120 identical "connection refused" lines are noise;
# the failure path below runs one last probe with curl's message visible, so
# the actual reason still reaches the operator.
probe() {
  if [ -n "${insecure}" ]; then
    curl -fsS -k --max-time 10 -o /dev/null "${url}" 2>/dev/null
  else
    curl -fsS --max-time 10 -o /dev/null "${url}" 2>/dev/null
  fi
}

if [ -n "${insecure}" ]; then
  verification="skipped (tls_mode = self-signed, Caddy's internal CA)"
else
  verification="enforced (tls_mode = trusted, publicly trusted chain)"
fi

echo "[wait_for_ready] waiting for ${url}"
echo "[wait_for_ready] certificate verification: ${verification}"
echo "[wait_for_ready] budget ${budget}s, polling every ${interval}s. First boot"
echo "[wait_for_ready] installs Docker, pulls or builds the images, seeds the"
echo "[wait_for_ready] database, and waits out the gateway worker's first"
echo "[wait_for_ready] catalog build, so this normally takes 10 to 20 minutes."
echo "[wait_for_ready] If it fails, the VM's own boot driver has the reason:"
echo "[wait_for_ready] run 'systemctl status explabs-trial' on the instance or"
echo "[wait_for_ready] read /var/log/explabs-trial-install.log."

started="$(date +%s)"
deadline=$(( started + budget ))
polls=0

while true; do
  if probe; then
    echo "[wait_for_ready] ${url} answered after $(( $(date +%s) - started ))s"
    exit 0
  fi
  now="$(date +%s)"
  if [ "${now}" -ge "${deadline}" ]; then
    break
  fi
  polls=$(( polls + 1 ))
  if [ $(( polls % progress_every )) -eq 0 ]; then
    echo "[wait_for_ready] still waiting, $(( now - started ))s elapsed of ${budget}s"
  fi
  sleep "${interval}"
done

echo "[wait_for_ready] FAILED: ${url} did not serve HTTPS within ${budget}s." >&2
echo "[wait_for_ready] Last attempt reported:" >&2
if [ -n "${insecure}" ]; then
  curl -fsS -k --max-time 10 -o /dev/null "${url}" || true
else
  curl -fsS --max-time 10 -o /dev/null "${url}" || true
fi
echo "[wait_for_ready] The VM keeps converging on its own: its boot driver" >&2
echo "[wait_for_ready] retries for about 90 minutes before giving up. Check" >&2
echo "[wait_for_ready] 'systemctl status explabs-trial' and" >&2
echo "[wait_for_ready] /var/log/explabs-trial-install.log on the instance, then" >&2
echo "[wait_for_ready] re-run 'terraform apply' to re-check. The re-run only" >&2
echo "[wait_for_ready] repeats this wait; it does not recreate the VM." >&2
echo "[wait_for_ready] Set -var wait_for_ready=false to stop gating the apply." >&2
exit 1
