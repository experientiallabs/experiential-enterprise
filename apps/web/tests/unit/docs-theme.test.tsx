import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { DocsThemeToggle } from "@/components/docs/DocsThemeToggle";
import {
  DOCS_THEME_BOOT_SCRIPT,
  DOCS_THEME_ROOT_ID,
  DOCS_THEME_STORAGE_KEY
} from "@/components/docs/docs-theme";

function renderInDocsRoot() {
  return render(
    <div data-docs-theme="light" id={DOCS_THEME_ROOT_ID}>
      <DocsThemeToggle />
    </div>
  );
}

beforeEach(() => {
  localStorage.removeItem(DOCS_THEME_STORAGE_KEY);
});

describe("docs theme", () => {
  it("defaults light and toggles the scoped attribute plus localStorage", () => {
    const { container } = renderInDocsRoot();
    const root = container.querySelector(`#${DOCS_THEME_ROOT_ID}`);
    expect(root).toHaveAttribute("data-docs-theme", "light");

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(root).toHaveAttribute("data-docs-theme", "dark");
    expect(localStorage.getItem(DOCS_THEME_STORAGE_KEY)).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(root).toHaveAttribute("data-docs-theme", "light");
    expect(localStorage.getItem(DOCS_THEME_STORAGE_KEY)).toBe("light");
  });

  it("applies a stored dark preference on mount — client-side navigations never run the boot script", () => {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, "dark");
    const { container } = renderInDocsRoot();
    expect(container.querySelector(`#${DOCS_THEME_ROOT_ID}`)).toHaveAttribute(
      "data-docs-theme",
      "dark"
    );
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
  });

  it("boot script applies a stored dark preference before hydration", () => {
    document.body.innerHTML = `<div id="${DOCS_THEME_ROOT_ID}" data-docs-theme="light"></div>`;
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, "dark");
    // eslint-disable-next-line no-eval -- executing the exact inline script the layout ships
    eval(DOCS_THEME_BOOT_SCRIPT);
    expect(document.getElementById(DOCS_THEME_ROOT_ID)).toHaveAttribute(
      "data-docs-theme",
      "dark"
    );
  });

  it("boot script leaves the light default alone when nothing is stored", () => {
    document.body.innerHTML = `<div id="${DOCS_THEME_ROOT_ID}" data-docs-theme="light"></div>`;
    // eslint-disable-next-line no-eval -- executing the exact inline script the layout ships
    eval(DOCS_THEME_BOOT_SCRIPT);
    expect(document.getElementById(DOCS_THEME_ROOT_ID)).toHaveAttribute(
      "data-docs-theme",
      "light"
    );
  });
});
