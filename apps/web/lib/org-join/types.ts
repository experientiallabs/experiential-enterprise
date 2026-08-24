// Wire shapes for domain-based organization join requests. These mirror the
// FastAPI views in explabs/api/routes/org_join_requests.py 1:1.

/** The domain-match offer shown to a signed-in user, or null when none. */
export type JoinOffer = {
  org_id: string;
  org_name: string;
  org_slug: string;
  email_verified: boolean;
  already_member: boolean;
  request_status: "pending" | "approved" | "denied" | null;
};

/** A requester's view of the request they just opened. */
export type JoinRequestCreated = {
  id: string;
  org_id: string;
  org_name: string;
  status: string;
  created_at: string;
};

/** One pending request in the org-admin roster. */
export type PendingJoinRequest = {
  id: string;
  user_id: string;
  email: string;
  created_at: string;
};

/** The outcome of an approve/deny decision. */
export type JoinDecision = {
  id: string;
  status: string;
  decided_at: string | null;
};
