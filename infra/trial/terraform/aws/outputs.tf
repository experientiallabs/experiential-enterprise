# Copyright (c) 2026 Experiential Labs. All rights reserved.

output "public_ip" {
  description = "Static public IP of the trial VM."
  value       = aws_eip.trial.public_ip
}

output "public_dns" {
  description = "AWS public DNS name of the trial VM."
  value       = aws_eip.trial.public_dns
}

output "dashboard_url" {
  description = "Where to open the trial dashboard."
  value       = local.public_origin
}

output "api_url" {
  description = "OpenAI-compatible serving base URL (append /chat/completions etc.)."
  value       = "${local.public_origin}/v1"
}

output "tls_note" {
  description = "How the trial front door terminates TLS."
  value = (var.tls_mode == "trusted"
    ? (var.domain != ""
      ? "Publicly trusted Let's Encrypt certificate for ${var.domain}. No browser warning."
    : "Publicly trusted Let's Encrypt certificate on the VM's IP (shortlived profile, auto-renewed). No browser warning.")
    : "Self-signed certificate from Caddy's internal CA for ${var.domain != "" ? var.domain : "the VM's IP"}; no ACME is attempted. Export /data/caddy/pki/authorities/local/root.crt from the caddy container and trust it on clients; do not skip verification."
  )
}

output "admin_email" {
  description = "Seeded dashboard admin login email."
  value       = var.admin_email
}

output "admin_password" {
  description = "Seeded dashboard admin login password."
  value       = random_password.admin_password.result
  sensitive   = true
}

output "signin_url" {
  description = "Direct link to the dashboard sign-in page."
  value       = "${local.public_origin}/signin"
}

output "trial_login" {
  description = "Everything needed to log in, on one line: sign-in URL, admin email, password."
  value       = "${local.public_origin}/signin — ${var.admin_email} / ${random_password.admin_password.result}"
  sensitive   = true
}
