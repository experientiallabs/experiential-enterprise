import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ModelIcon, ProviderLogo } from "@/components/models-catalog/model-icon";

// The maker key comes from families.ts (`modelIconKey`). Makers with a usable
// simple-icons mark render it monochrome; makers simple-icons drops/omits but
// that are primary providers — openai, xai, and (the product owner r2) zai/amazon/fireworks,
// plus microsoft (Phi / Azure) — render a local mark; the remaining no-mark
// makers (cohere, stability, FLUX, nous …) and null icons (custom models)
// render the neutral monogram tile drawn from the model/maker name. The UI must
// never crash or blank on any of these.

// Every maker key whose logo is a real brand mark (simple-icons or local path),
// spanning the 800+ row catalog. Each must paint an SVG path, never a monogram.
const MARKED_MAKERS = [
  "anthropic",
  "openai",
  "google",
  "qwen",
  "deepseek",
  "moonshot",
  "meta",
  "mistral",
  "zai",
  "xai",
  "amazon",
  "microsoft",
  "nvidia",
  "minimax",
  "baidu",
  "bytedance",
  "fireworks",
  "perplexity",
  "thinkingmachines"
];

describe("ModelIcon", () => {
  it.each(MARKED_MAKERS)("renders a real brand mark (not a monogram) for %s", (family) => {
    const { container } = render(<ModelIcon icon={family} name="A Model" />);
    expect(container.querySelector("svg path")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders a monochrome mark that inherits currentColor (no hardcoded fill)", () => {
    const { container } = render(<ModelIcon icon="anthropic" name="Claude Opus 5" />);
    expect(container.querySelector("svg")?.getAttribute("fill")).toBeNull();
  });

  it.each([
    ["stability", "Stable Image Ultra", "S"],
    ["cohere", "Command R+", "C"],
    ["blackforest", "Flux 1 Dev", "F"],
    ["voyage", "Voyage 4", "V"],
    ["ai21", "AI21 Jamba", "A"]
  ])("renders a monogram from the name for the unmarked maker %s", (family, name, letter) => {
    const { container } = render(<ModelIcon icon={family} name={name} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe(letter);
  });

  it("uses the display name's letter when icon is null (custom models)", () => {
    const { container } = render(<ModelIcon icon={null} name="my fine-tuned coder" />);
    expect(container.textContent).toBe("M");
  });

  it("draws the monogram from the name, never the internal key", () => {
    // A `name:*` fallback key must not leak into the tile; the letter is the
    // model's own initial.
    const { container } = render(<ModelIcon icon="name:zephyr" name="Zephyr 7b Beta" />);
    expect(container.textContent).toBe("Z");
  });
});

// Every serving provider the catalog surfaces paints its real brand logo; the
// customer's own-server lane (`local`) and any unknown provider paint a neutral
// server glyph rather than nothing.
describe("ProviderLogo", () => {
  it.each(["openai", "anthropic", "gemini", "azure_openai", "openrouter", "bedrock", "fireworks", "modal", "experiential_cloud"])(
    "renders a brand mark for the %s provider",
    (provider) => {
      const { container } = render(<ProviderLogo provider={provider} />);
      expect(container.querySelector("svg path")).not.toBeNull();
    }
  );

  it("renders a neutral server glyph for the local (own-server) provider", () => {
    const { container } = render(<ProviderLogo provider="local" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders a neutral server glyph for an unknown provider instead of blanking", () => {
    const { container } = render(<ProviderLogo provider="somefutureprovider" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
