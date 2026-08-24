# Copyright (c) 2026 Experiential Labs. All rights reserved.

variable "subscription_id" {
  description = "Azure subscription id. Empty falls back to the ARM_SUBSCRIPTION_ID environment variable."
  type        = string
  default     = ""
}

variable "location" {
  description = "Azure region for the trial VM."
  type        = string
  default     = "eastus"
}

variable "resource_group_name" {
  description = "Name of the resource group created for the trial."
  type        = string
  default     = "explabs-trial"
}

variable "public_repo_url" {
  description = "Git URL of the public trial repository cloned onto the VM."
  type        = string
  default     = "https://github.com/experientiallabs/experiential-enterprise"
}

variable "trial_tag" {
  description = "Published snapshot tag to deploy (trial-YYYYMMDD)."
  type        = string
}

variable "api_image" {
  description = "Public api/gateway-worker image repository. Empty string builds from source on the VM."
  type        = string
  default     = ""
}

variable "web_image" {
  description = "Public web image repository. Empty string builds from source on the VM."
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Tag for api_image and web_image (trial-YYYYMMDD-<pubsha7> or latest)."
  type        = string
  default     = "latest"
}

variable "domain" {
  description = "Optional DNS name pointed at the VM. It chooses the host the certificate is issued FOR: set, the front door serves your host name; empty, it serves the bare public IP. It does NOT choose the issuer, so it never overrides tls_mode."
  type        = string
  default     = ""
}

variable "wait_for_ready" {
  description = "Gate the apply on the endpoint actually working. When true (the default) terraform polls https://<host>/health from YOUR machine after the VM boots and FAILS the apply if it never answers, so a green apply always means a usable trial. Set false to return as soon as the cloud resources exist and let the VM converge on its own."
  type        = bool
  default     = true
}

variable "ready_timeout_minutes" {
  description = "How long the wait_for_ready gate polls before failing the apply. The default covers the from-source first boot that empty api_image/web_image (the default) produce; prebuilt images finish well inside it."
  type        = number
  default     = 40

  validation {
    condition     = var.ready_timeout_minutes > 0
    error_message = "ready_timeout_minutes must be positive."
  }
}

variable "tls_mode" {
  description = "Who issues the certificate, whether or not a domain is set; this always wins. \"trusted\" provisions a publicly trusted Let's Encrypt certificate (for the domain, or for the bare IP under the shortlived profile, auto-renewed); it needs ports 80/443 reachable from the internet, which this root's firewall rules already open. \"self-signed\" uses Caddy's internal CA and attempts no ACME at all, for networks Let's Encrypt cannot reach."
  type        = string
  default     = "trusted"

  validation {
    condition     = contains(["trusted", "self-signed"], var.tls_mode)
    error_message = "tls_mode must be \"trusted\" or \"self-signed\"."
  }
}

variable "admin_email" {
  description = "Email address for the seeded dashboard admin login (it doubles as the ACME account contact). Override for a real mailbox; the default exists so a plain apply needs no inputs."
  type        = string
  default     = "admin@xplabs.ai"
}

variable "vm_size" {
  description = "Azure VM size."
  type        = string
  default     = "Standard_D4s_v5"
}

variable "os_disk_gb" {
  description = "OS disk size in GB (images, builds, and the database volume all live here)."
  type        = number
  default     = 120
}

variable "allow_ssh_cidr" {
  description = "CIDR allowed to reach port 22. Empty (the default) opens no SSH rule at all."
  type        = string
  default     = ""
}
