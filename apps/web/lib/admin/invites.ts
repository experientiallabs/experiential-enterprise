import { z } from "zod";

export const INVITE_ROLES = ["admin", "user"] as const;

export type OrgInvite = {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

export type InviteStatus = "pending" | "accepted" | "expired";

const invitePayloadSchema = z.object({
  email: z
    .string()
    .trim()
    .email("A valid email address is required.")
    .transform((value) => value.toLowerCase()),
  orgId: z.string().uuid("A target organization is required."),
  role: z.enum(INVITE_ROLES)
});

export type InvitePayload = z.infer<typeof invitePayloadSchema>;

export function parseInvitePayload(value: unknown): InvitePayload {
  const result = invitePayloadSchema.safeParse(value);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid invite request.");
  }
  return result.data;
}

// "accepted" means the invitee signed up and the provisioning trigger granted
// the membership; expiry only matters while pending.
export function inviteStatus(invite: Pick<OrgInvite, "acceptedAt" | "expiresAt">, now: Date): InviteStatus {
  if (invite.acceptedAt) {
    return "accepted";
  }
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) {
    return "expired";
  }
  return "pending";
}
