import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SuggestionsSection } from "@/components/telemetry-page/suggestions-panel";
import type { Suggestion } from "@/lib/types";

const REAL_SUGGESTION: Suggestion = {
  id: "cheaper_model:claude-fable-5",
  kind: "cheaper_model",
  title: "Try Claude Sonnet 5 for small claude-fable-5 requests",
  body: "Most of your claude-fable-5 traffic is small requests.",
  estimated_monthly_savings_usd: "12.40",
  evidence: [
    "You made 300 requests to claude-fable-5 in the last 7d.",
    "Over 30 days at this pace, that is roughly $12.40 — an estimate, not a quote."
  ]
};

const DOLLARLESS_SUGGESTION: Suggestion = {
  id: "errors:gpt-5.6-terra",
  kind: "quality",
  title: "High error rate on gpt-5.6-terra",
  body: "12% of your gpt-5.6-terra requests ended in an error.",
  estimated_monthly_savings_usd: null,
  evidence: ["24 of 200 requests to gpt-5.6-terra in the last 7d did not complete."]
};

describe("SuggestionsSection", () => {
  it("renders real suggestions with an estimate label and expandable evidence", () => {
    render(<SuggestionsSection suggestions={[REAL_SUGGESTION, DOLLARLESS_SUGGESTION]} />);
    expect(screen.getByRole("heading", { name: "Suggestions" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: REAL_SUGGESTION.title })
    ).toBeInTheDocument();
    // Savings are labeled estimates, never bare dollar figures.
    expect(screen.getByText("est. $12.40/mo")).toBeInTheDocument();
    expect(screen.getByText("estimate, not a quote")).toBeInTheDocument();
    // The dollar-less suggestion renders without any savings line.
    expect(screen.getByRole("heading", { name: DOLLARLESS_SUGGESTION.title })).toBeInTheDocument();
    expect(screen.queryAllByText(/est\. \$/)).toHaveLength(1);

    // Evidence lines are hidden until asked for, then render verbatim.
    expect(screen.queryByText(REAL_SUGGESTION.evidence[0])).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Why this suggestion" })[0]);
    expect(screen.getByText(REAL_SUGGESTION.evidence[0])).toBeInTheDocument();
    expect(screen.getByText(REAL_SUGGESTION.evidence[1])).toBeInTheDocument();

    // No "Example" chips when real suggestions exist.
    expect(screen.queryByText("Example")).not.toBeInTheDocument();
  });

  it("dismisses per suggestion, ending in the dismissed note", () => {
    render(<SuggestionsSection suggestions={[REAL_SUGGESTION, DOLLARLESS_SUGGESTION]} />);
    fireEvent.click(
      screen.getByRole("button", { name: `Dismiss suggestion: ${REAL_SUGGESTION.title}` })
    );
    expect(
      screen.queryByRole("heading", { name: REAL_SUGGESTION.title })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: DOLLARLESS_SUGGESTION.title })).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: `Dismiss suggestion: ${DOLLARLESS_SUGGESTION.title}` })
    );
    expect(screen.getByText(/Suggestions dismissed for this visit/)).toBeInTheDocument();
    // Dismissing everything must NOT surface the example cards — those mean
    // "nothing fired", not "you closed them".
    expect(screen.queryByText("Example")).not.toBeInTheDocument();
  });

  it("shows two clearly-labeled example suggestions when nothing fires", () => {
    render(<SuggestionsSection suggestions={[]} />);
    const chips = screen.getAllByText("Example");
    expect(chips).toHaveLength(2);
    expect(screen.getByText(/here is what suggestions look like/)).toBeInTheDocument();
    // Example cards are not dismissable; the panel is the launch messaging.
    expect(screen.queryByRole("button", { name: /Dismiss suggestion/ })).not.toBeInTheDocument();
  });
});
