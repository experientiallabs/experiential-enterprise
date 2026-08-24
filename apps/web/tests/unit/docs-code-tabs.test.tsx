import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CodeTabs } from "@/components/docs/CodeTabs";
import { CodeLanguageProvider } from "@/components/docs/code-language";

const SNIPPETS_A = {
  curl: "curl https://example.test/a",
  python: "import a",
  javascript: "const a = 1;"
};
const SNIPPETS_B = {
  curl: "curl https://example.test/b",
  python: "import b",
  javascript: "const b = 2;"
};

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText }
  });
});

describe("CodeTabs", () => {
  it("shares one language across every block on the page", () => {
    const { container } = render(
      <CodeLanguageProvider>
        <CodeTabs snippets={SNIPPETS_A} />
        <CodeTabs snippets={SNIPPETS_B} />
      </CodeLanguageProvider>
    );
    // Prism splits lines into token spans, so assert on each pane's full text.
    const panes = () =>
      Array.from(container.querySelectorAll("pre")).map((pre) => pre.textContent ?? "");
    // Default language is curl in both blocks.
    expect(panes()).toEqual([
      expect.stringContaining("example.test/a"),
      expect.stringContaining("example.test/b")
    ]);
    // Picking Python in the FIRST block switches BOTH.
    fireEvent.click(screen.getAllByRole("button", { name: "Python" })[0]);
    expect(panes()).toEqual([
      expect.stringContaining("import a"),
      expect.stringContaining("import b")
    ]);
  });

  it("copies the active pane's code", async () => {
    render(
      <CodeLanguageProvider>
        <CodeTabs snippets={SNIPPETS_A} />
      </CodeLanguageProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "JavaScript" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    // The button acknowledges the copy.
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("marks the active tab for assistive tech", () => {
    render(
      <CodeLanguageProvider>
        <CodeTabs snippets={SNIPPETS_A} />
      </CodeLanguageProvider>
    );
    expect(screen.getByRole("button", { name: "curl" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Python" }));
    expect(screen.getByRole("button", { name: "Python" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "curl" })).toHaveAttribute("aria-pressed", "false");
  });
});
