// Teams (enterprise E4): wire types for the backend's /api/orgs/{org}/teams
// surface, shared by the proxy routes and the settings panel. Attribution
// only in this wave — team budgets and usage rollups land after PR #563.

export type Team = {
  team_id: string;
  org_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  member_count: number;
  key_count: number;
  /** Active keys attributed to the team; always key_count entries. */
  assigned_key_ids: string[];
};

export type TeamList = {
  org_id: string;
  teams: Team[];
};

export type TeamMember = {
  team_id: string;
  user_id: string;
  added_by: string | null;
  created_at: string;
};

export type TeamMemberList = {
  members: TeamMember[];
};

export type TeamKeyAssignment = {
  api_key_id: string;
  team_id: string | null;
};

export type TeamDeletion = {
  team_id: string;
  deleted: boolean;
  unassigned_key_count: number;
};
