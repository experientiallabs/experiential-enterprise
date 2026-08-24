import type { OrgRosterMember } from "@/lib/members/manage";

/**
 * The founding admin's email for an org roster: the EARLIEST-joined
 * role='admin' member — the same earliest-admin rule the spend-unlock path
 * keys on (unlock_founder_spend scopes to the earliest admin membership), so
 * the identity the admin surfaces show is the account the platform treats as
 * the founder. An email-less member cannot label a card, so the pick skips
 * them: the earliest admin WITH an email wins, then (rosters with no
 * emailed admin at all) the earliest member of any role with an email, else
 * null and the surface renders nothing extra.
 */
export function foundingMemberEmail(members: OrgRosterMember[]): string | null {
  const byJoin = [...members].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const foundingAdmin = byJoin.find(
    (member) => member.role === "admin" && member.email !== null
  );
  if (foundingAdmin !== undefined) {
    return foundingAdmin.email;
  }
  return byJoin.find((member) => member.email !== null)?.email ?? null;
}
