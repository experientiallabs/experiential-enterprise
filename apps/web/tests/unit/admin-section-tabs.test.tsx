import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The admin panel is sections you click into, not one long scroll (the product owner,
// 2026-08-01). These tabs live in the admin layout, so the active section is
// derived from the pathname alone; an unknown admin path falls back to
// Organizations rather than rendering a strip with no active pill. The Runs
// tab retired with the admin runs surface.
let pathname = "/admin";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { AdminSectionTabs } from "@/components/admin/AdminSectionTabs";

afterEach(() => {
  cleanup();
});

function renderAt(path: string) {
  pathname = path;
  render(<AdminSectionTabs />);
  return screen.getByRole("navigation", { name: "Admin sections" });
}

describe("AdminSectionTabs", () => {
  it("marks Organizations active on the admin index", () => {
    renderAt("/admin");
    const organizations = screen.getByRole("link", { name: "Organizations" });
    expect(organizations.getAttribute("aria-current")).toBe("page");
    expect(organizations.getAttribute("href")).toBe("/admin");
    // The retired runs surface must not resurface as a dead tab.
    expect(screen.queryByRole("link", { name: "Runs" })).toBeNull();
  });

  it("marks Users active on the users section", () => {
    renderAt("/admin/users");
    const usersTab = screen.getByRole("link", { name: "Users" });
    expect(usersTab.getAttribute("aria-current")).toBe("page");
    expect(usersTab.getAttribute("href")).toBe("/admin/users");
    expect(
      screen.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("marks Telemetry active on the telemetry section", () => {
    renderAt("/admin/telemetry");
    const telemetry = screen.getByRole("link", { name: "Telemetry" });
    expect(telemetry.getAttribute("aria-current")).toBe("page");
    expect(telemetry.getAttribute("href")).toBe("/admin/telemetry");
    expect(
      screen.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("marks Access active on the superadmin-keys section", () => {
    renderAt("/admin/access");
    const access = screen.getByRole("link", { name: "Access" });
    expect(access.getAttribute("aria-current")).toBe("page");
    expect(access.getAttribute("href")).toBe("/admin/access");
    expect(
      screen.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("marks Platform active on the platform-settings section", () => {
    renderAt("/admin/platform");
    const platform = screen.getByRole("link", { name: "Platform" });
    expect(platform.getAttribute("aria-current")).toBe("page");
    expect(platform.getAttribute("href")).toBe("/admin/platform");
    expect(
      screen.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("falls back to Organizations on an unrecognized admin path", () => {
    renderAt("/admin/tenants");
    expect(
      screen.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")
    ).toBe("page");
  });
});
