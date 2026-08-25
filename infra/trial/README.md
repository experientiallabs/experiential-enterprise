<!-- Copyright (c) 2026 Experiential Labs. All rights reserved. -->

# One-click trial deploy

Run the full Experiential Labs trial stack on a single cloud VM. One `terraform apply` gives you the dashboard, the OpenAI-compatible `/v1` gateway, and a seeded admin login.

Terraform state and the instance user data contain the generated admin password and stack keys, so protect both; this is an evaluation-grade deployment, not a hardened production topology.

## What you get

- One VM running the Docker Compose stack from `docker/compose.yml`.
- Caddy as the only public entry, on ports 80 and 443, serving HTTPS by default.
- Fresh Supabase JWTs and stack keys minted per instance. The well-known local-dev values in `docker/.env.example` are never exposed.
- A seeded admin login and a seeded demo organization.
- Builds the stack from the cloned source on the VM by default, so nothing but this repository is required. Set `api_image` and `web_image` to published image repositories (for example `ghcr.io/experientiallabs/experiential-api` and `experiential-web`) for a faster prebuilt boot.

## Prerequisites

- Terraform 1.5 or newer, or OpenTofu.
- Cloud credentials for the target account.
- One required input: `trial_tag` (the published snapshot tag, `trial-YYYYMMDD`). The login email defaults to `admin@xplabs.ai`; set `admin_email` to change it (it doubles as the ACME contact).
- Apply returns when the endpoint serves verified HTTPS. Terraform polls `https://<host>/health` from your machine after the VM boots and fails the apply if it never answers, so expect `terraform apply` to sit for 20 to 35 minutes on the default from-source boot, bounded by `ready_timeout_minutes` (default 40). Prebuilt images finish in 10 to 20. Set `-var wait_for_ready=false` to return as soon as the cloud resources exist and let the VM converge unattended.

## AWS

```bash
cd infra/trial/terraform/aws
terraform init
terraform apply -var trial_tag=trial-20260822
terraform output trial_login
```

Open the URL from `trial_login`, choose **Sign in with password**, and paste
the password from the same line. The default emailed-code form is retained for
auth consistency, but trial VM mail stays inside the stack's mail catcher.

Uses the default VPC, a `t3.xlarge`, and an Elastic IP. Ubuntu 24.04 comes from the canonical SSM public parameter.

## Azure

```bash
cd infra/trial/terraform/azure
terraform init
terraform apply -var subscription_id=<sub-id> -var trial_tag=trial-20260822
terraform output trial_login
```

Creates a resource group with a minimal vnet, NSG, static public IP, and a `Standard_D4s_v5`. You can also set the subscription through `ARM_SUBSCRIPTION_ID` and drop the `-var`.

## GCP

```bash
cd infra/trial/terraform/gcp
terraform init
terraform apply -var project=<project-id> -var trial_tag=trial-20260822
terraform output trial_login
```

Uses the default network, a static address, and an `e2-standard-4`. Ubuntu 24.04 comes from the `ubuntu-2404-lts-amd64` image family.

## First boot

The VM installs Docker, clones the tagged repo to `/opt/explabs`, mints secrets, starts the stack with `scripts/integration_stack.sh up`, runs one smoke pass, then starts Caddy. The default from-source boot takes roughly 20 to 35 minutes; prebuilt images take 10 to 20. The gateway worker reports ready only after its first catalog build, so a `/v1` call right after boot can briefly return 503.

Progress is logged to `/var/log/explabs-trial-install.log` on the VM. The driver is the `explabs-trial` systemd unit and re-runs safely on every reboot.

The driver only reports success once it has fetched `https://` from the endpoint terraform advertises, so a certificate that never issued fails the install instead of hiding behind a green apply. It waits 15 minutes for that, then systemd retries the whole driver every 2 minutes for about 90 minutes, which is enough for a transient Let's Encrypt outage or a slow DNS record to clear on its own. If it still cannot serve HTTPS the unit stays `failed`: run `systemctl status explabs-trial` for the reason, or read `/var/log/explabs-trial-install.log`, both reachable from your cloud console's serial or run-command surface if no SSH port is open.

Terraform gates the apply on the same endpoint, from your machine, so a broken deploy fails the apply instead of printing a login for a dead URL. It verifies the certificate chain in `trusted` mode and skips verification in `self-signed` mode, matching what a real client would do. A failed wait does not roll anything back and does not stop the VM: its boot driver is still inside that 90-minute self-heal window, so give it a few minutes and re-run `terraform apply`. The re-run repeats only the wait. It does not recreate the VM, the address, or any secret.

`terraform output trial_login` prints the sign-in URL, the admin email, and the password on one line. `signin_url`, `admin_email`, and `admin_password` remain as separate outputs for scripting.

## Routing

Caddy routes `/v1*` and `/health*` to the api container and everything else to the web app. The dashboard's own `/api/*` routes therefore go to the web app; the FastAPI control surface on `/api` stays VM-internal because its paths collide with the dashboard routes and it is bearer-key internal anyway.

## HTTPS

The trial serves a publicly trusted certificate by default. Caddy obtains it from Let's Encrypt for the VM's bare IP under the ACME shortlived profile and renews it automatically about every four days. There is nothing to configure and no browser warning. Issuance needs ports 80 and 443 reachable from the internet; the deployed firewall rules already open them. Port 80 only redirects to HTTPS. A VM that stays offline for more than about two days can serve an expired certificate until it boots and renews.

Set `domain` to serve on your own host name instead:

1. Apply once without `domain` to learn the public IP.
2. Point an A record for your domain at `public_ip`.
3. Apply again with `-var domain=trial.example.com`.

Caddy then provisions a Let's Encrypt certificate for the domain and keeps retrying until the DNS record resolves.

Set `-var tls_mode=self-signed` when Let's Encrypt cannot reach the VM. Caddy then signs the certificate with its own internal CA and attempts no ACME at all. Traffic stays encrypted, but the chain is not publicly trusted. Trust Caddy's root certificate on your clients instead of turning off verification: export it with `sudo docker cp explabs-trial-caddy-1:/data/caddy/pki/authorities/local/root.crt .` on the VM, then import it into your OS or browser trust store, or pass it with `curl --cacert root.crt`.

The two inputs are independent and `tls_mode` always wins. `domain` picks the host the certificate covers, your host name or the bare public IP. `tls_mode` picks the issuer, Let's Encrypt or Caddy's internal CA. So `domain` with `tls_mode=self-signed` serves your host name from the internal CA, which is the right combination for a private network that has DNS but no inbound path from Let's Encrypt. The `tls_note` output states which of the four you got.

## SSH

No SSH port is open by default. Set `-var allow_ssh_cidr=<your-ip>/32` to open port 22. On AWS also attach access your own way (EC2 Instance Connect or SSM). On Azure log in as `explabs` with the `vm_admin_password` output. On GCP use `gcloud compute ssh`.

## Operating the VM

- `systemctl status explabs-trial` shows the boot driver. `active (exited)` means the HTTPS endpoint was verified; `failed` means it was not, and the reason is in the last log lines it prints.
- `systemctl restart explabs-trial` reconverges the stack and the proxy.
- `cd /opt/explabs && ./scripts/integration_stack.sh status` shows the services.
- Never run `./scripts/integration_stack.sh reset` on a trial you care about. It destroys the database and storage volumes.

## Teardown

```bash
terraform destroy
```
