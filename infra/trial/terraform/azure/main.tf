# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# One-click Experiential Labs trial on a single Azure VM: minimal
# vnet/subnet/NSG/public-ip/nic, Ubuntu 24.04 LTS, and the shared cloud-init
# template (custom_data) that installs docker, clones the tagged trial repo,
# and hands off to infra/trial/scripts/first_boot.sh.
#
# Evaluation-grade caveat: the terraform state and the instance custom data
# both carry the generated secrets below.

provider "azurerm" {
  features {}

  # null lets ARM_SUBSCRIPTION_ID supply the subscription instead.
  subscription_id = var.subscription_id == "" ? null : var.subscription_id
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

# OS-level login for the VM itself (password auth; the NSG opens 22 only when
# allow_ssh_cidr is set). Three character classes satisfy Azure's complexity
# rule without special characters.
resource "random_password" "vm_admin_password" {
  length      = 24
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

# Globally unique DNS label for the public IP.
resource "random_string" "dns_label" {
  length  = 8
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# --- Network -----------------------------------------------------------------

resource "azurerm_resource_group" "trial" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_virtual_network" "trial" {
  name                = "explabs-trial-vnet"
  location            = azurerm_resource_group.trial.location
  resource_group_name = azurerm_resource_group.trial.name
  address_space       = ["10.20.0.0/16"]
}

resource "azurerm_subnet" "trial" {
  name                 = "explabs-trial-subnet"
  resource_group_name  = azurerm_resource_group.trial.name
  virtual_network_name = azurerm_virtual_network.trial.name
  address_prefixes     = ["10.20.1.0/24"]
}

# Static so cloud-init can bake the public origin into the stack env.
resource "azurerm_public_ip" "trial" {
  name                = "explabs-trial-ip"
  location            = azurerm_resource_group.trial.location
  resource_group_name = azurerm_resource_group.trial.name
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = "explabs-trial-${random_string.dns_label.result}"
}

resource "azurerm_network_security_group" "trial" {
  name                = "explabs-trial-nsg"
  location            = azurerm_resource_group.trial.location
  resource_group_name = azurerm_resource_group.trial.name

  security_rule {
    name                       = "allow-http"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "allow-https"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # No SSH rule at all unless a CIDR is given.
  dynamic "security_rule" {
    for_each = var.allow_ssh_cidr == "" ? [] : [var.allow_ssh_cidr]
    content {
      name                       = "allow-ssh"
      priority                   = 120
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "22"
      source_address_prefix      = security_rule.value
      destination_address_prefix = "*"
    }
  }
}

resource "azurerm_network_interface" "trial" {
  name                = "explabs-trial-nic"
  location            = azurerm_resource_group.trial.location
  resource_group_name = azurerm_resource_group.trial.name

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.trial.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.trial.id
  }
}

resource "azurerm_network_interface_security_group_association" "trial" {
  network_interface_id      = azurerm_network_interface.trial.id
  network_security_group_id = azurerm_network_security_group.trial.id
}

# --- Rendered boot configuration ---------------------------------------------

locals {
  # Always HTTPS. The domain, when set, decides the host the certificate is
  # issued FOR; tls_mode decides WHO issues it and always wins, so
  # domain + self-signed serves the domain from Caddy's internal CA rather
  # than attempting ACME (see infra/trial/proxy/Caddyfile.tftpl).
  public_origin = var.domain != "" ? "https://${var.domain}" : "https://${azurerm_public_ip.trial.ip_address}"

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
    public_ip = azurerm_public_ip.trial.ip_address
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

resource "azurerm_linux_virtual_machine" "trial" {
  name                = "explabs-trial"
  location            = azurerm_resource_group.trial.location
  resource_group_name = azurerm_resource_group.trial.name
  size                = var.vm_size

  network_interface_ids = [azurerm_network_interface.trial.id]

  admin_username                  = "explabs"
  admin_password                  = random_password.vm_admin_password.result
  disable_password_authentication = false

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.os_disk_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(local.user_data)
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

  triggers_replace = azurerm_linux_virtual_machine.trial.id

  # The public IP reaches the VM through the NIC, and 80/443 only open once
  # the NSG association is applied; poll after both.
  depends_on = [
    azurerm_linux_virtual_machine.trial,
    azurerm_network_interface_security_group_association.trial,
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
