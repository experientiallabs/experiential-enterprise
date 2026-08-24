// The model detail's benchmarks card: scores render with per-unit formatting
// and their provenance linked to the citation; the card disappears entirely
// when the model has neither scores nor an external link; the link prefers
// the Hugging Face repo over the release page.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BenchmarksCard } from "@/components/models-catalog/detail/benchmarks-card";
import {
  benchmarkSourceLabel,
  bestBenchmarkSlugs,
  formatBenchmarkScore,
  formatRetrievedAt,
  mergeBenchmarkRows
} from "@/lib/models-catalog/benchmarks";
import { makeBenchmark } from "./models-catalog-fixtures";

describe("BenchmarksCard", () => {
  it("renders nothing without scores or a link", () => {
    const { container } = render(
      <BenchmarksCard benchmarks={[]} huggingfaceUrl={null} releaseUrl={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders each score with unit formatting and linked provenance", () => {
    render(
      <BenchmarksCard
        benchmarks={[
          makeBenchmark(),
          makeBenchmark({
            benchmark: "lmarena-elo",
            display_name: "LMArena Elo",
            unit: "elo",
            score: 1421.5,
            source: "lmarena",
            source_url: "https://example.com/leaderboard"
          }),
          makeBenchmark({
            benchmark: "terminal-bench",
            display_name: "Terminal-Bench",
            unit: "points",
            score: 52.25,
            source: "leaderboard",
            source_url: null
          })
        ]}
        huggingfaceUrl={null}
        releaseUrl={null}
      />
    );
    const rows = screen.getAllByTestId("benchmark-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("MMLU-Pro");
    expect(rows[0]).toHaveTextContent("81.3%");
    expect(rows[1]).toHaveTextContent("1422");
    expect(rows[2]).toHaveTextContent("52.3");
    // Provenance: source label + retrieved month, linked to the citation.
    const provenance = screen.getByRole("link", { name: /vendor reported/ });
    expect(provenance).toHaveAttribute("href", "https://example.com/model-card");
    expect(provenance).toHaveTextContent("Aug 2026");
    // A missing citation renders the provenance as plain text, not a dead link.
    expect(screen.queryByRole("link", { name: /public leaderboard/ })).toBeNull();
    expect(rows[2]).toHaveTextContent("public leaderboard");
  });

  it("prefers the Hugging Face link and labels the release fallback", () => {
    const { rerender } = render(
      <BenchmarksCard
        benchmarks={[]}
        huggingfaceUrl="https://huggingface.co/org/model"
        releaseUrl="https://vendor.example.com/release"
      />
    );
    const hf = screen.getByTestId("model-external-link");
    expect(hf).toHaveAttribute("href", "https://huggingface.co/org/model");
    expect(hf).toHaveTextContent("Hugging Face");
    rerender(
      <BenchmarksCard
        benchmarks={[]}
        huggingfaceUrl={null}
        releaseUrl="https://vendor.example.com/release"
      />
    );
    const release = screen.getByTestId("model-external-link");
    expect(release).toHaveAttribute("href", "https://vendor.example.com/release");
    expect(release).toHaveTextContent("Release notes");
  });
});

describe("benchmark formatting", () => {
  it("formats per unit: percent one decimal, elo integer, points one decimal", () => {
    expect(formatBenchmarkScore(makeBenchmark({ unit: "percent", score: 90 }))).toBe("90.0%");
    expect(formatBenchmarkScore(makeBenchmark({ unit: "elo", score: 1421.5 }))).toBe("1422");
    expect(formatBenchmarkScore(makeBenchmark({ unit: "points", score: 52 }))).toBe("52.0");
  });

  it("labels every source vocabulary value and passes unknowns through", () => {
    expect(benchmarkSourceLabel("vendor")).toBe("vendor reported");
    expect(benchmarkSourceLabel("huggingface")).toBe("Hugging Face");
    expect(benchmarkSourceLabel("lmarena")).toBe("LMArena");
    expect(benchmarkSourceLabel("leaderboard")).toBe("public leaderboard");
    expect(benchmarkSourceLabel("paper")).toBe("paper");
    expect(benchmarkSourceLabel("somewhere-new")).toBe("somewhere-new");
  });

  it("renders the retrieved date as month + year, tolerating junk", () => {
    expect(formatRetrievedAt("2026-08-20T00:00:00Z")).toBe("Aug 2026");
    expect(formatRetrievedAt("not-a-date")).toBe("not-a-date");
  });
});

describe("compare benchmark merging", () => {
  const shared = (score: number) => makeBenchmark({ score });
  const arena = (score: number) =>
    makeBenchmark({ benchmark: "lmarena-elo", display_name: "LMArena Elo", unit: "elo", score });

  it("unions rows in first-appearance order and keys scores by slug", () => {
    const rows = mergeBenchmarkRows(["a", "b", "c"], {
      a: { benchmarks: [shared(90), arena(1400)], huggingface_url: null, release_url: null },
      b: { benchmarks: [shared(80)], huggingface_url: null, release_url: null }
      // c has no extras at all (still loading, or the fetch failed).
    });
    expect(rows.map((row) => row.benchmark)).toEqual(["mmlu-pro", "lmarena-elo"]);
    expect(rows[0].scoreBySlug.a?.score).toBe(90);
    expect(rows[0].scoreBySlug.b?.score).toBe(80);
    expect(rows[0].scoreBySlug.c).toBeUndefined();
    expect(rows[1].scoreBySlug.b).toBeUndefined();
  });

  it("returns no rows when no selected model has scores", () => {
    expect(mergeBenchmarkRows(["a"], {})).toEqual([]);
  });

  it("picks the best per direction and abstains below two known scores", () => {
    const [row] = mergeBenchmarkRows(["a", "b"], {
      a: { benchmarks: [shared(90)], huggingface_url: null, release_url: null },
      b: { benchmarks: [shared(80)], huggingface_url: null, release_url: null }
    });
    expect(bestBenchmarkSlugs(row, ["a", "b"])).toEqual(new Set(["a"]));
    const [lower] = mergeBenchmarkRows(["a", "b"], {
      a: {
        benchmarks: [makeBenchmark({ higher_is_better: false, score: 5 })],
        huggingface_url: null,
        release_url: null
      },
      b: {
        benchmarks: [makeBenchmark({ higher_is_better: false, score: 3 })],
        huggingface_url: null,
        release_url: null
      }
    });
    expect(bestBenchmarkSlugs(lower, ["a", "b"])).toEqual(new Set(["b"]));
    const [solo] = mergeBenchmarkRows(["a", "b"], {
      a: { benchmarks: [shared(90)], huggingface_url: null, release_url: null }
    });
    expect(bestBenchmarkSlugs(solo, ["a", "b"])).toEqual(new Set());
  });
});
