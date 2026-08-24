# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# One-click Experiential Labs trial on a single Compute Engine VM: the default
# network, firewall rules for 80/443 (22 optional), Ubuntu 24.04 LTS from the
# ubuntu-2404-lts-amd64 image family, and the shared cloud-init template
# (user-data metadata) that installs docker, clones the tagged trial repo, and
# hands off to infra/trial/scripts/first_boot.sh.
#
# Evaluation-grade caveat: the terraform state and the instance metadata both
# carry the generated secrets below.

provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}

# --- Generated credentials -------------------------------------------------
# Five independent secrets with pairwise-distinct lengths, so the stack
# wrapper's distinctness checks hold by construction. All alphanumeric.

resource "random_password" "admin_password" {
  length  = 12
  special = false
}

resource "random_password" "postgres_password" {
  length  = 32
  special = false
}

resource "random_password" "api_key" {
  length  = 40
  special = false
}

resource "random_password" "gateway_worker_key" {
  length  = 44
  special = false
}

resource "random_password" "project_serving_key" {
  length  = 48
  special = false
}

# --- Image, address, firewall --------------------------------------------------

data "google_compute_image" "ubuntu_2404" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"
}

# Reserved before the instance so cloud-init can bake the public origin into
# the stack env.
resource "google_compute_address" "trial" {
  name = "explabs-trial"
}

resource "google_compute_firewall" "trial_web" {
  name    = "explabs-trial-web"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["explabs-trial"]
}

# No SSH rule at all unless a CIDR is given.
resource "google_compute_firewall" "trial_ssh" {
  count = var.allow_ssh_cidr == "" ? 0 : 1

  name    = "explabs-trial-ssh"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = [var.allow_ssh_cidr]
  target_tags   = ["explabs-trial"]
}

# --- Rendered boot configuration ---------------------------------------------

locals {
  # Always HTTPS. The domain, when set, decides the host the certificate is
  # issued FOR; tls_mode decides WHO issues it and always wins, so
  # domain + self-signed serves the domain from Caddy's internal CA rather
  # than attempting ACME (see infra/trial/proxy/Caddyfile.tftpl).
  public_origin = var.domain != "" ? "https://${var.domain}" : "https://${google_compute_address.trial.address}"

  api_image_ref = var.api_image == "" ? "" : "${var.api_image}:${var.image_tag}"
  web_image_ref = var.web_image == "" ? "" : "${var.web_image}:${var.image_tag}"

  # Consumed by infra/trial/scripts/first_boot.sh on the VM.
  trial_env = <<-EOT
    EXPLABS_TRIAL_PUBLIC_ORIGIN='${local.public_origin}'
    EXPLABS_TRIAL_TLS_MODE='${var.tls_mode}'
    EXPLABS_TRIAL_ADMIN_EMAIL='${var.admin_email}'
    EXPLABS_TRIAL_ADMIN_PASSWORD='${random_password.admin_password.result}'
    EXPLABS_TRIAL_POSTGRES_PASSWORD='${random_password.postgres_password.result}'
    EXPLABS_TRIAL_API_KEY='${random_password.api_key.result}'
    EXPLABS_TRIAL_GATEWAY_WORKER_KEY='${random_password.gateway_worker_key.result}'
    EXPLABS_TRIAL_PROJECT_SERVING_KEY='${random_password.project_serving_key.result}'
    EXPLABS_TRIAL_API_IMAGE='${local.api_image_ref}'
    EXPLABS_TRIAL_WEB_IMAGE='${local.web_image_ref}'
  EOT

  caddyfile = templatefile("${path.module}/../../proxy/Caddyfile.tftpl", {
    domain     = var.domain
    acme_email = var.admin_email
    tls_mode   = var.tls_mode
    # Used only in the no-domain branch: TLS site address and no-SNI fallback.
    public_ip = google_compute_address.trial.address
    # Container-internal service addresses from docker/compose.yml.
    api_upstream = "api:8080"
    web_upstream = "web:3000"
  })

  user_data = templatefile("${path.module}/../../cloud-init/trial.yaml.tftpl", {
    public_repo_url = var.public_repo_url
    trial_tag       = var.trial_tag
    trial_env_b64   = base64encode(local.trial_env)
    caddyfile_b64   = base64encode(local.caddyfile)
  })
}

# --- The VM -------------------------------------------------------------------

resource "google_compute_instance" "trial" {
  name         = "explabs-trial"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["explabs-trial"]

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu_2404.self_link
      size  = var.boot_disk_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = "default"

    access_config {
      nat_ip = google_compute_address.trial.address
    }
  }

  metadata = {
    user-data = local.user_data
  }
}

# --- Readiness gate ------------------------------------------------------------
# cloud-init starts the boot driver with --no-block, so every cloud resource is
# "created" long before the trial is usable. Without this gate a failed
# certificate issuance still produces a green apply and a dead URL. The poll
# runs on the OPERATOR'S machine, not the VM, so it needs no SSH port; port 22
# stays closed by default.
#
# A failed poll taints only this resource: re-running `terraform apply` repeats
# the wait and touches nothing else, which is the right move because the VM's
# own boot driver keeps retrying for about 90 minutes after the apply gives up.

resource "terraform_data" "ready" {
  count = var.wait_for_ready ? 1 : 0

  triggers_replace = google_compute_instance.trial.id

  # The static address is attached by the instance's access_config, and 80/443
  # only open once the web firewall rule exists; poll after both.
  depends_on = [
    google_compute_instance.trial,
    google_compute_firewall.trial_web,
  ]

  provisioner "local-exec" {
    interpreter = ["/bin/sh"]
    command     = abspath("${path.module}/../../scripts/wait_for_ready.sh")

    # Passed as environment, never interpolated into a command string: a host
    # name can then never be word-split or re-quoted by the operator's shell.
    environment = {
      EXPLABS_TRIAL_URL      = "${local.public_origin}/health"
      EXPLABS_TRIAL_BUDGET   = tostring(var.ready_timeout_minutes * 60)
      EXPLABS_TRIAL_INSECURE = var.tls_mode == "self-signed" ? "1" : ""
    }
  }
}
