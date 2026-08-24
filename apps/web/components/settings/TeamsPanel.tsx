"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown } from "@/components/ui/Dropdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { Shimmer } from "@/components/ui/Shimmer";
import { readApiError } from "@/components/world-models/wm-client";
import type { Team, TeamList, TeamMember, TeamMemberList } from "@/lib/teams";

type TeamsPanelProps = {
  orgId: string;
  /** Admins manage; members read the same panel without the controls. */
  canManage: boolean;
};

// The org roster (GET /api/orgs/{orgId}/members) and key listing
// (GET /api/keys) shapes, narrowed to the fields this panel renders.
type RosterMember = { userId: string; email: string | null };
type OrgKey = { id: string; name: string; key_prefix: string; revoked_at: string | null };
type KeysPage = { keys: OrgKey[]; page: number; pageCount: number };

const INPUT_CLASS =
  "min-h-[34px] rounded-md border border-line-strong bg-surface px-3 text-[13px] text-ink outline-none focus:border-accent";

async function fetchAllActiveKeys(orgId: string): Promise<OrgKey[]> {
  const pageUrl = (page: number) =>
    `/api/keys?orgId=${encodeURIComponent(orgId)}&page=${page}`;
  const first = await fetch(pageUrl(1));
  if (!first.ok) {
    throw new Error(await readApiError(first, "Could not load the org's API keys."));
  }
  const firstPage = (await first.json()) as KeysPage;
  const rest = await Promise.all(
    Array.from({ length: Math.max(firstPage.pageCount - 1, 0) }, async (_, index) => {
      const response = await fetch(pageUrl(index + 2));
      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not load the org's API keys."));
      }
      return ((await response.json()) as KeysPage).keys;
    })
  );
  // GET /api/keys already omits revoked keys by default; the filter is a
  // guard against a future default change, not a second opinion.
  return [firstPage.keys, ...rest].flat().filter((key) => key.revoked_at === null);
}

/** Team management: rosters and key attribution, per docs/enterprise.md E4. */
export function TeamsPanel({ orgId, canManage }: TeamsPanelProps) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  // Supporting reads for the management controls. Either failing degrades
  // just its own control (a note where the dropdown would be), never the
  // team list itself.
  const [roster, setRoster] = useState<RosterMember[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [orgKeys, setOrgKeys] = useState<OrgKey[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMember[]>>({});
  const [membersLoadingId, setMembersLoadingId] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createName, setCreateName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Team | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadTeams = useCallback(async (): Promise<Team[] | null> => {
    const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/teams`);
    if (!response.ok) {
      throw new Error(await readApiError(response, "Could not load teams."));
    }
    const payload = (await response.json()) as TeamList;
    setTeams(payload.teams);
    return payload.teams;
  }, [orgId]);

  const loadTeamMembers = useCallback(
    async (teamId: string): Promise<void> => {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members`
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not load the team's members."));
      }
      const payload = (await response.json()) as TeamMemberList;
      setTeamMembers((current) => ({ ...current, [teamId]: payload.members }));
    },
    [orgId]
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    (async () => {
      try {
        await loadTeams();
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Could not load teams.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    (async () => {
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`);
        if (!response.ok) {
          throw new Error(await readApiError(response, "Could not load the org roster."));
        }
        const payload = (await response.json()) as { members: RosterMember[] };
        if (!cancelled) {
          setRoster(payload.members);
        }
      } catch (error) {
        if (!cancelled) {
          setRosterError(
            error instanceof Error ? error.message : "Could not load the org roster."
          );
        }
      }
    })();
    (async () => {
      try {
        const keys = await fetchAllActiveKeys(orgId);
        if (!cancelled) {
          setOrgKeys(keys);
        }
      } catch (error) {
        if (!cancelled) {
          setKeysError(
            error instanceof Error ? error.message : "Could not load the org's API keys."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, retryToken, loadTeams]);

  async function toggleExpanded(teamId: string): Promise<void> {
    if (expandedId === teamId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(teamId);
    if (teamMembers[teamId] === undefined) {
      setMembersLoadingId(teamId);
      try {
        await loadTeamMembers(teamId);
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "Could not load the team's members."
        );
      } finally {
        setMembersLoadingId(null);
      }
    }
  }

  /** Run one mutation with the shared busy flag and inline error strip. */
  async function mutate(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The change did not apply.");
    } finally {
      setBusy(false);
    }
  }

  async function requestOk(input: string, init: RequestInit, fallback: string): Promise<void> {
    const response = await fetch(input, init);
    if (!response.ok) {
      throw new Error(await readApiError(response, fallback));
    }
  }

  const teamUrl = (teamId: string, suffix = "") =>
    `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}${suffix}`;

  async function createTeam(): Promise<void> {
    const name = createName.trim();
    if (name.length === 0) {
      return;
    }
    await mutate(async () => {
      await requestOk(
        `/api/orgs/${encodeURIComponent(orgId)}/teams`,
        {
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
          method: "POST"
        },
        "Could not create the team."
      );
      setCreateName("");
      await loadTeams();
    });
  }

  async function saveRename(teamId: string): Promise<void> {
    const name = renameValue.trim();
    if (name.length === 0) {
      return;
    }
    await mutate(async () => {
      await requestOk(
        teamUrl(teamId),
        {
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
          method: "PATCH"
        },
        "Could not rename the team."
      );
      setRenameId(null);
      await loadTeams();
    });
  }

  async function confirmDelete(): Promise<void> {
    if (deleteTarget === null) {
      return;
    }
    const team = deleteTarget;
    setBusy(true);
    setDeleteError(null);
    try {
      // Zero-key teams take the plain path so the backend's assigned-keys
      // refusal stays load-bearing; the dialog has already said that force
      // will detach the keys otherwise.
      const suffix = team.key_count > 0 ? "?force=true" : "";
      await requestOk(
        teamUrl(team.team_id, suffix),
        { method: "DELETE" },
        "Could not delete the team."
      );
      setDeleteTarget(null);
      if (expandedId === team.team_id) {
        setExpandedId(null);
      }
      await loadTeams();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete the team.");
    } finally {
      setBusy(false);
    }
  }

  async function addMember(teamId: string, userId: string): Promise<void> {
    await mutate(async () => {
      await requestOk(
        teamUrl(teamId, `/members/${encodeURIComponent(userId)}`),
        { method: "PUT" },
        "Could not add the member."
      );
      await Promise.all([loadTeams(), loadTeamMembers(teamId)]);
    });
  }

  async function removeMember(teamId: string, userId: string): Promise<void> {
    await mutate(async () => {
      await requestOk(
        teamUrl(teamId, `/members/${encodeURIComponent(userId)}`),
        { method: "DELETE" },
        "Could not remove the member."
      );
      await Promise.all([loadTeams(), loadTeamMembers(teamId)]);
    });
  }

  async function assignKey(teamId: string, keyId: string): Promise<void> {
    await mutate(async () => {
      await requestOk(
        teamUrl(teamId, `/keys/${encodeURIComponent(keyId)}`),
        { method: "PUT" },
        "Could not assign the key."
      );
      await loadTeams();
    });
  }

  async function unassignKey(teamId: string, keyId: string): Promise<void> {
    await mutate(async () => {
      await requestOk(
        teamUrl(teamId, `/keys/${encodeURIComponent(keyId)}`),
        { method: "DELETE" },
        "Could not unassign the key."
      );
      await loadTeams();
    });
  }

  const emailFor = (userId: string): string =>
    roster?.find((member) => member.userId === userId)?.email ?? userId;

  if (teams === null && loadError !== null && !isLoading) {
    return (
      <ErrorTile
        title="Couldn't load teams"
        message={loadError}
        onRetry={() => setRetryToken((token) => token + 1)}
      />
    );
  }

  if (isLoading && teams === null) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]">
        <Shimmer className="h-4 w-full" />
        <Shimmer className="h-4 w-full" />
        <Shimmer className="h-4 w-2/3" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {actionError !== null ? (
        <p className="m-0 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-danger text-[13px]">
          {actionError}
        </p>
      ) : null}

      {canManage ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createTeam();
          }}
        >
          <input
            aria-label="New team name"
            className={`${INPUT_CLASS} w-full max-w-[320px] flex-1`}
            maxLength={120}
            onChange={(event) => setCreateName(event.target.value)}
            placeholder="New team name"
            value={createName}
          />
          <Button disabled={busy || createName.trim().length === 0} size="sm" type="submit">
            Create team
          </Button>
        </form>
      ) : null}

      {teams === null || teams.length === 0 ? (
        <EmptyState
          title="No teams yet"
          body={
            canManage
              ? "Create a team to group members and attribute API keys to it."
              : "Organization admins can create teams to group members and attribute API keys."
          }
        />
      ) : (
        <section className="overflow-hidden rounded-lg border border-line bg-surface">
          {teams.map((team) => (
            <div className="border-b border-line/60 last:border-b-0" key={team.team_id}>
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <button
                  aria-expanded={expandedId === team.team_id}
                  aria-label={`Toggle ${team.name} details`}
                  className="inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left"
                  onClick={() => void toggleExpanded(team.team_id)}
                  type="button"
                >
                  {expandedId === team.team_id ? (
                    <ChevronDown aria-hidden className="size-4 text-muted-2" />
                  ) : (
                    <ChevronRight aria-hidden className="size-4 text-muted-2" />
                  )}
                  <span className="text-ink text-[13px] font-medium">{team.name}</span>
                </button>
                <span className="text-muted-2 text-[12px]">
                  {team.member_count} {team.member_count === 1 ? "member" : "members"} ·{" "}
                  {team.key_count} {team.key_count === 1 ? "key" : "keys"}
                </span>
                {canManage ? (
                  <span className="ml-auto flex items-center gap-2">
                    {renameId === team.team_id ? (
                      <>
                        <input
                          aria-label={`New name for ${team.name}`}
                          className={INPUT_CLASS}
                          maxLength={120}
                          onChange={(event) => setRenameValue(event.target.value)}
                          value={renameValue}
                        />
                        <Button
                          disabled={busy || renameValue.trim().length === 0}
                          onClick={() => void saveRename(team.team_id)}
                          size="sm"
                        >
                          Save
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => setRenameId(null)}
                          size="sm"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setRenameId(team.team_id);
                            setRenameValue(team.name);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          Rename
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(team);
                          }}
                          size="sm"
                          variant="destructive"
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </span>
                ) : null}
              </div>

              {expandedId === team.team_id ? (
                <TeamDetail
                  busy={busy}
                  canManage={canManage}
                  emailFor={emailFor}
                  keysError={keysError}
                  loading={membersLoadingId === team.team_id}
                  members={teamMembers[team.team_id] ?? null}
                  onAddMember={(userId) => void addMember(team.team_id, userId)}
                  onAssignKey={(keyId) => void assignKey(team.team_id, keyId)}
                  onRemoveMember={(userId) => void removeMember(team.team_id, userId)}
                  onUnassignKey={(keyId) => void unassignKey(team.team_id, keyId)}
                  orgKeys={orgKeys}
                  roster={roster}
                  rosterError={rosterError}
                  team={team}
                  teams={teams}
                />
              ) : null}
            </div>
          ))}
        </section>
      )}

      <ConfirmDialog
        body={
          deleteTarget !== null && deleteTarget.key_count > 0 ? (
            <>
              Deleting <strong>{deleteTarget.name}</strong> unassigns its{" "}
              {deleteTarget.key_count} active API{" "}
              {deleteTarget.key_count === 1 ? "key" : "keys"}. The keys keep working; they just
              lose their team attribution.
            </>
          ) : (
            <>
              Deleting <strong>{deleteTarget?.name}</strong> removes the team and its
              memberships. Members stay in the organization.
            </>
          )
        }
        busy={busy}
        busyLabel="Deleting…"
        confirmLabel="Delete team"
        confirmVariant="destructive"
        error={deleteError}
        onCancel={() => {
          if (!busy) {
            setDeleteTarget(null);
          }
        }}
        onConfirm={() => void confirmDelete()}
        open={deleteTarget !== null}
        title="Delete team"
        tone="danger"
      />
    </div>
  );
}

type TeamDetailProps = {
  team: Team;
  teams: Team[];
  members: TeamMember[] | null;
  loading: boolean;
  busy: boolean;
  canManage: boolean;
  roster: RosterMember[] | null;
  rosterError: string | null;
  orgKeys: OrgKey[] | null;
  keysError: string | null;
  emailFor: (userId: string) => string;
  onAddMember: (userId: string) => void;
  onRemoveMember: (userId: string) => void;
  onAssignKey: (keyId: string) => void;
  onUnassignKey: (keyId: string) => void;
};

function TeamDetail({
  team,
  teams,
  members,
  loading,
  busy,
  canManage,
  roster,
  rosterError,
  orgKeys,
  keysError,
  emailFor,
  onAddMember,
  onRemoveMember,
  onAssignKey,
  onUnassignKey
}: TeamDetailProps) {
  const [memberChoice, setMemberChoice] = useState("");
  const [keyChoice, setKeyChoice] = useState("");

  const memberIds = new Set((members ?? []).map((member) => member.user_id));
  const addable = (roster ?? []).filter((member) => !memberIds.has(member.userId));

  // Keys already attributed to any team stay out of the assign dropdown; a
  // reassignment reads as unassign + assign, which keeps the audit trail
  // explicit about both halves.
  const assignedAnywhere = new Set(teams.flatMap((entry) => entry.assigned_key_ids));
  const assignedHere = new Set(team.assigned_key_ids);
  const assignable = (orgKeys ?? []).filter((key) => !assignedAnywhere.has(key.id));
  const assignedKeys = (orgKeys ?? []).filter((key) => assignedHere.has(key.id));

  return (
    <div className="flex flex-col gap-4 border-t border-line/60 bg-surface-subtle/50 px-4 py-4 sm:pl-10">
      <div className="flex flex-col gap-2">
        <span className="mono-label">Members</span>
        {loading ? (
          <Shimmer className="h-4 w-1/2" />
        ) : members === null || members.length === 0 ? (
          <p className="m-0 text-muted text-[13px]">No members on this team yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {members.map((member) => (
              <li className="flex items-center gap-2 text-[13px]" key={member.user_id}>
                <span className="text-ink">{emailFor(member.user_id)}</span>
                {canManage ? (
                  <Button
                    disabled={busy}
                    onClick={() => onRemoveMember(member.user_id)}
                    size="sm"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          rosterError !== null ? (
            <p className="m-0 text-muted-2 text-[12px]">{rosterError}</p>
          ) : addable.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Dropdown
                aria-label={`Add a member to ${team.name}`}
                onChange={(event) => setMemberChoice(event.target.value)}
                value={memberChoice}
              >
                <option value="">Add a member…</option>
                {addable.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email ?? member.userId}
                  </option>
                ))}
              </Dropdown>
              <Button
                disabled={busy || memberChoice === ""}
                onClick={() => {
                  onAddMember(memberChoice);
                  setMemberChoice("");
                }}
                size="sm"
              >
                Add
              </Button>
            </div>
          ) : (
            <p className="m-0 text-muted-2 text-[12px]">
              Everyone in the organization is already on this team.
            </p>
          )
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className="mono-label">API keys</span>
        {keysError !== null ? (
          <p className="m-0 text-muted-2 text-[12px]">{keysError}</p>
        ) : (
          <>
            {assignedKeys.length === 0 ? (
              <p className="m-0 text-muted text-[13px]">No keys attributed to this team yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {assignedKeys.map((key) => (
                  <li className="flex items-center gap-2 text-[13px]" key={key.id}>
                    <span className="text-ink">{key.name}</span>
                    <span className="font-mono text-[11px] text-muted-2">{key.key_prefix}…</span>
                    {canManage ? (
                      <Button
                        disabled={busy}
                        onClick={() => onUnassignKey(key.id)}
                        size="sm"
                        variant="ghost"
                      >
                        Unassign
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              assignable.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Dropdown
                    aria-label={`Assign a key to ${team.name}`}
                    onChange={(event) => setKeyChoice(event.target.value)}
                    value={keyChoice}
                  >
                    <option value="">Assign a key…</option>
                    {assignable.map((key) => (
                      <option key={key.id} value={key.id}>
                        {key.name} ({key.key_prefix}…)
                      </option>
                    ))}
                  </Dropdown>
                  <Button
                    disabled={busy || keyChoice === ""}
                    onClick={() => {
                      onAssignKey(keyChoice);
                      setKeyChoice("");
                    }}
                    size="sm"
                  >
                    Assign
                  </Button>
                </div>
              ) : (
                <p className="m-0 text-muted-2 text-[12px]">
                  Every active key is already attributed to a team.
                </p>
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
