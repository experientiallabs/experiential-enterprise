# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# One-click Experiential Labs trial on a single EC2 VM: default VPC, one
# security group (80/443 public, 22 optional), Ubuntu 24.04 from the canonical
# SSM public parameter, and the shared cloud-init template that installs
# docker, clones the tagged trial repo, and hands off to
# infra/trial/scripts/first_boot.sh.
#
# Evaluation-grade caveat: the terraform state and the instance user data both
# carry the generated secrets below.

provider "aws" {
  region = var.region
}

# --- Generated credentials -------------------------------------------------
# Five independent secrets with pairwise-distinct lengths, so the stack
# wrapper's distinctness checks (EXPLABS_API_KEY vs gateway-worker drain key vs
# Project-serving key) hold by construction. All alphanumeric: the postgres
# password is embedded in DSNs and every value crosses env files unquoted.

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

# --- Image and network lookups ----------------------------------------------

# Canonical's maintained Ubuntu 24.04 LTS AMI id, resolved per region.
data "aws_ssm_parameter" "ubuntu_2404" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_vpc" "default" {
  default = true
}

# Allocated before the instance so cloud-init can bake the public origin into
# the stack env (the instance's user data references this address).
resource "aws_eip" "trial" {
  domain = "vpc"

  tags = {
    Name = "explabs-trial"
  }
}

resource "aws_security_group" "trial" {
  name_prefix = "explabs-trial-"
  description = "Experiential Labs trial VM: Caddy on 80/443, optional SSH."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # No SSH rule at all unless a CIDR is given.
  dynamic "ingress" {
    for_each = var.allow_ssh_cidr == "" ? [] : [var.allow_ssh_cidr]
    content {
      description = "SSH (operator-provided CIDR)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "explabs-trial"
  }
}

# --- Rendered boot configuration ---------------------------------------------

locals {
  # Always HTTPS. The domain, when set, decides the host the certificate is
  # issued FOR; tls_mode decides WHO issues it and always wins, so
  # domain + self-signed serves the domain from Caddy's internal CA rather
  # than attempting ACME (see infra/trial/proxy/Caddyfile.tftpl).
  public_origin = var.domain != "" ? "https://${var.domain}" : "https://${aws_eip.trial.public_ip}"

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
    public_ip = aws_eip.trial.public_ip
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

resource "aws_instance" "trial" {
  ami                    = data.aws_ssm_parameter.ubuntu_2404.value
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.trial.id]

  user_data                   = local.user_data
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
  }

  tags = {
    Name = "explabs-trial"
  }
}

resource "aws_eip_association" "trial" {
  instance_id   = aws_instance.trial.id
  allocation_id = aws_eip.trial.id
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

  # Re-wait whenever the VM is replaced (user_data_replace_on_change makes a
  # config edit a replacement, and the new instance has to prove itself too).
  triggers_replace = aws_instance.trial.id

  # The Elastic IP is what public_origin points at in the no-domain case, so
  # nothing can answer until the association exists. It depends on the
  # instance, which orders this after both.
  depends_on = [aws_eip_association.trial]

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
