import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OnThisPage } from "@/components/docs/OnThisPage";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs" }));

// The rail reads the already-rendered article's headings from the DOM, so the
// tests stage a #docs-article next to it the way DocsShell lays them out.
function stageArticle(html: string) {
  const article = document.createElement("article");
  article.id = "docs-article";
  article.innerHTML = html;
  document.body.appendChild(article);
}

beforeEach(() => {
  document.getElementById("docs-article")?.remove();
});

describe("OnThisPage", () => {
  it("lists the article's identified h2/h3 headings as anchor links", () => {
    stageArticle(
      '<h2 id="first-call">Make a call</h2><h3 id="detail">Detail</h3><h2 id="whats-here">What&#39;s in these docs</h2>'
    );
    render(<OnThisPage />);
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Make a call" })).toHaveAttribute(
      "href",
      "#first-call"
    );
    expect(screen.getByRole("link", { name: "Detail" })).toHaveAttribute("href", "#detail");
  });

  it("renders nothing for pages with fewer than two headings", () => {
    stageArticle('<h2 id="only">Only heading</h2>');
    render(<OnThisPage />);
    expect(screen.queryByRole("navigation", { name: "On this page" })).not.toBeInTheDocument();
  });
});
