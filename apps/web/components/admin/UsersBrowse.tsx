"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

import type { AdministeredUser } from "@/lib/admin/users-server";
import { formatDateWithYear } from "@/lib/format";
import { useDisplayTimeZone } from "@/components/ui/LocalDateTime";
import { Card } from "@/components/ui/Card";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { Dropdown } from "@/components/ui/Dropdown";
import { UserAccountActions } from "@/components/admin/UserAccountActions";
import { adminOrgPath } from "@/lib/routes";

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const USERS_PER_PAGE = 20;
const PILL_BUTTON =
  "cursor-pointer rounded-full border border-line bg-transparent px-3 py-1 text-[12px] text-foreground/60 hover:border-line-strong hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground/25 disabled:hover:border-line";

type SortKey = "created" | "email" | "last-sign-in";
type FilterKey = "all" | "banned" | "admins";

type UsersBrowseProps = {
  users: AdministeredUser[];
  /** The signed-in operator; their own row hides ban/delete and locks admin revoke. */
  currentUserId: string;
};

/**
 * The admin Users browse: every auth account (email, orgs, created, last
 * sign-in, ban and admin state) with the shared per-user account actions:
 * email edit, ban/unban, experiential-admin grant/revoke, account deletion.
 * The same actions appear on each organization's admin detail; org-scoped
 * management (roles, removal, invites) stays there, reachable through the
 * organization links on each row. Searchable by email or organization,
 * filterable to banned accounts or experiential admins. Platform-admin gated
 * by the admin layout above; customers never see it.
 */
export function UsersBrowse({ users, currentUserId }: UsersBrowseProps) {
  const timeZone = useDisplayTimeZone();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("created");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [page, setPage] = useState(1);

  const visibleUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = users.filter((user) => {
      if (filter === "banned" && user.ban === null) {
        return false;
      }
      if (filter === "admins" && !user.isExperientialAdmin) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const haystack = `${user.email ?? ""} ${user.orgs.map((org) => org.name).join(" ")}`.toLowerCase();
      return haystack.includes(needle);
    });
    const sorted = [...matched];
    sorted.sort((a, b) => {
      switch (sort) {
        case "created":
          // Newest first.
          return b.createdAt.localeCompare(a.createdAt);
        case "email":
          return (a.email ?? "").localeCompare(b.email ?? "");
        case "last-sign-in":
          // Most recent first; accounts that never signed in sort last.
          return (b.lastSignInAt ?? "").localeCompare(a.lastSignInAt ?? "");
      }
    });
    return sorted;
  }, [users, query, sort, filter]);

  const pageCount = Math.max(1, Math.ceil(visibleUsers.length / USERS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const pagedUsers = visibleUsers.slice(
    (currentPage - 1) * USERS_PER_PAGE,
    currentPage * USERS_PER_PAGE
  );

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);

  const columns: Array<DataTableColumn<AdministeredUser>> = [
    {
      id: "account",
      header: "Account",
      cell: (user) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-ink">
            {labelOf(user)}
          </span>
          {user.id === currentUserId && (
            <span className="shrink-0 text-[11px] text-muted-2">you</span>
          )}
          {user.isExperientialAdmin && (
            <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
              experiential admin
            </span>
          )}
          {user.ban ? (
            <span className="shrink-0 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold uppercase text-danger">
              Banned
            </span>
          ) : null}
        </span>
      )
    },
    {
      id: "orgs",
      header: "Organizations",
      // Each membership links to that org's admin detail, where the
      // org-scoped actions (role, removal, invites) live.
      cell: (user) =>
        user.orgs.length === 0 ? (
          <span className="text-muted-2">none</span>
        ) : (
          <span className="text-muted">
            {user.orgs.map((org, index) => (
              <span key={org.id}>
                {index > 0 ? ", " : null}
                <Link className="hover:text-ink hover:underline" href={adminOrgPath(org.id)}>
                  {org.name}
                </Link>
              </span>
            ))}
          </span>
        ),
      className: "hidden md:table-cell"
    },
    {
      id: "created",
      header: "Created",
      cell: (user) => <span className="text-muted">{formatDateWithYear(user.createdAt, timeZone)}</span>
    },
    {
      id: "last-sign-in",
      header: "Last sign-in",
      cell: (user) => (
        <span className="text-muted">
          {user.lastSignInAt ? formatDateWithYear(user.lastSignInAt, timeZone) : "never"}
        </span>
      )
    },
    {
      id: "ban-details",
      header: "Ban",
      cell: (user) =>
        user.ban ? (
          <span className="block max-w-[320px] text-[12px] leading-snug text-muted">
            {user.ban.reason}
            <span className="block text-muted-2">
              by {user.ban.bannedByEmail ?? "unknown"} on {formatDateWithYear(user.ban.bannedAt, timeZone)}
            </span>
          </span>
        ) : (
          <span className="text-muted-2">none</span>
        ),
      className: "hidden lg:table-cell"
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (user) => (
        <UserAccountActions
          currentUserId={currentUserId}
          user={{
            id: user.id,
            email: user.email,
            banned: user.ban !== null,
            isExperientialAdmin: user.isExperientialAdmin
          }}
        />
      )
    }
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            aria-hidden
            size={14}
            strokeWidth={1.8}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
          />
          <input
            aria-label="Search users"
            className={`${INPUT_CLASS} pl-8`}
            type="search"
            placeholder="Search by email or organization"
            value={query}
            onChange={(event) => {
              setPage(1);
              setQuery(event.target.value);
            }}
          />
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Sort
          <Dropdown
            aria-label="Sort users"
            value={sort}
            onChange={(event) => {
              setPage(1);
              setSort(event.target.value as SortKey);
            }}
          >
            <option value="created">Newest</option>
            <option value="email">Email (A–Z)</option>
            <option value="last-sign-in">Last sign-in</option>
          </Dropdown>
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Filter
          <Dropdown
            aria-label="Filter users"
            value={filter}
            onChange={(event) => {
              setPage(1);
              setFilter(event.target.value as FilterKey);
            }}
          >
            <option value="all">All users</option>
            <option value="banned">Banned accounts</option>
            <option value="admins">Experiential admins</option>
          </Dropdown>
        </label>
      </div>

      {visibleUsers.length === 0 ? (
        <Card>
          <p className="m-0 text-[13px] text-muted">
            {users.length === 0 ? "No users yet." : "No users match your search."}
          </p>
        </Card>
      ) : (
        <>
          <DataTable
            aria-label="Users"
            columns={columns}
            rows={pagedUsers}
            rowKey={(user) => user.id}
          />
          {pageCount > 1 ? (
            <UsersPager
              currentPage={currentPage}
              pageCount={pageCount}
              total={visibleUsers.length}
              onPageChange={(nextPage) => setPage(nextPage)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** The row's human name: the email, or the raw id for a userless shell. */
function labelOf(user: AdministeredUser): string {
  return user.email ?? user.id;
}

type UsersPagerProps = {
  currentPage: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
};

function UsersPager({ currentPage, pageCount, total, onPageChange }: UsersPagerProps) {
  const firstItem = (currentPage - 1) * USERS_PER_PAGE + 1;
  const lastItem = Math.min(currentPage * USERS_PER_PAGE, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-[12px]">
      <span className="text-muted">
        Showing {firstItem}–{lastItem} of {total}
      </span>
      <div className="flex items-center gap-2">
        <span aria-live="polite" className="text-muted">
          Page {currentPage} of {pageCount}
        </span>
        <button
          className={PILL_BUTTON}
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
          type="button"
        >
          Previous
        </button>
        <button
          className={PILL_BUTTON}
          disabled={currentPage >= pageCount}
          onClick={() => onPageChange(currentPage + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}
