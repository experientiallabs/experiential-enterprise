// The catalog's brand glyphs: this is the ONE place a provider or model family
// becomes a logo. A model's maker key comes from lib/models-catalog/families.ts
// (`modelIconKey`, e.g. anthropic, cohere, stability); a deployment's `provider`
// is the SERVING lane (OpenAI, Bedrock, Azure OpenAI, Fireworks …). Both draw
// from the same mark vocabulary so a Gemini model and the Gemini provider read
// with the same glyph. Marks render monochrome in ink, per the one-accent rule.
//
// simple-icons supplies most marks; it drops the trademarked
// openai/microsoft/amazon marks and has no thinkingmachines mark, so those (plus
// zai/GLM and fireworks) are carried as local path data below — the top makers
// the 800+ row catalog surfaces (the product owner) each paint their real logo. Makers with
// no simple-icons mark (cohere, stability, FLUX, voyage, nous, ai21, jais …) and unmapped/custom
// models fall back to the maker's monogram tile drawn from its name; the `local`
// provider (a customer's own OpenAI-compatible server, which has no brand) falls
// back to a generic server glyph. Brand marks are scoped to the catalog
// surfaces; UI icons everywhere else stay Lucide (docs/design-system.md).

import {
  siAnthropic,
  siBaidu,
  siBytedance,
  siDeepseek,
  siGoogle,
  siGooglegemini,
  siMeta,
  siMinimax,
  siMistralai,
  siModal,
  siMoonshotai,
  siNvidia,
  siOpenrouter,
  siPerplexity,
  siQwen,
  siX,
  type SimpleIcon
} from "simple-icons";
import { Server } from "lucide-react";
import { clsx } from "clsx";

import {
  BRAND_MARK_PATH,
  BRAND_MARK_TRANSFORM,
  BRAND_MARK_VIEWBOX
} from "@/components/brand/BrandMark";

const FAMILY_MARKS: Record<string, SimpleIcon> = {
  anthropic: siAnthropic,
  baidu: siBaidu, // ERNIE, PaddleOCR
  bytedance: siBytedance, // Seed
  deepseek: siDeepseek,
  google: siGoogle,
  meta: siMeta,
  minimax: siMinimax,
  mistral: siMistralai,
  moonshot: siMoonshotai,
  nvidia: siNvidia,
  openrouter: siOpenrouter,
  perplexity: siPerplexity,
  qwen: siQwen,
  // Grok's family: xAI ships under X Corp; the X mark is its real brand glyph.
  xai: siX
};

// Local mark data for brands simple-icons does not carry. OpenAI is the
// canonical blossom (dropped for trademark); zai (Zhipu/GLM), amazon (AWS —
// Nova + the Bedrock lane), fireworks, and microsoft (Phi's maker and the
// Azure OpenAI serving lane) are all primary providers, so each gets a real
// mark instead of a letter tile. Marks are normalized to a 24 viewBox; evenodd
// where the source uses it.
type LocalMark = {
  path: string;
  viewBox?: string;
  fillRule?: "evenodd";
  /** Source-space transform (the XP brand mark's drawing keeps its own axes). */
  transform?: string;
};
const LOCAL_MARKS: Record<string, LocalMark> = {
  openai: { path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7473-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" },
  fireworks: { path: "M14.8 5l-2.801 6.795L9.195 5H7.397l3.072 7.428a1.64 1.64 0 003.038.002L16.598 5H14.8zm1.196 10.352l5.124-5.244-.699-1.669-5.596 5.739a1.664 1.664 0 00-.343 1.807 1.642 1.642 0 001.516 1.012L16 17l8-.02-.699-1.669-7.303.041h-.002zM2.88 10.104l.699-1.669 5.596 5.739c.468.479.603 1.189.343 1.807a1.643 1.643 0 01-1.516 1.012l-8-.018-.002.002.699-1.669 7.303.042-5.122-5.246z", fillRule: "evenodd" },
  zai: { path: "M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z", fillRule: "evenodd" },
  amazon: { path: "M6.763 11.212c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 01-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 01-.287-.375 6.18 6.18 0 01-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.39-.384-.59-.894-.59-1.533 0-.678.24-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272-.09.04-.184.075-.28.104a.488.488 0 01-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 01.224-.167 4.577 4.577 0 011.005-.36 4.84 4.84 0 011.246-.151c.95 0 1.644.216 2.091.647.44.43.662 1.085.662 1.963v2.586h.016zm-3.24 1.214c.263 0 .534-.048.822-.144a1.78 1.78 0 00.758-.51 1.27 1.27 0 00.272-.512c.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 00-.735-.136 6.02 6.02 0 00-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 6.726a1.398 1.398 0 01-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 01.32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 01.311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 01-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 01-.303.08h-.687c-.15 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32L12.32 7.747l-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08l-.686.001zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 01-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.32.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 00.415-.758.777.777 0 00-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 01-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .36.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 01.24.2.43.43 0 01.071.263v.375c0 .168-.064.256-.184.256a.83.83 0 01-.303-.096 3.652 3.652 0 00-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.16.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926a2.157 2.157 0 01-.583.703c-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z M.378 15.475c3.384 1.963 7.56 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.44-.2.814.287.383.607-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351zm23.531-.2c.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151l.175-.439c.343-.88.802-2.198.52-2.555-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399z", fillRule: "evenodd" },
  // Microsoft's four-square mark: the maker of the Phi family and, as Azure,
  // the Azure OpenAI serving lane. Simple axis-aligned squares on a 24 grid.
  microsoft: { path: "M1 1h10v10H1zM13 1h10v10H13zM1 13h10v10H1zM13 13h10v10H13z" },
  // Thinking Machines Lab (Mira Murati) — maker of Inkling. simple-icons carries
  // no mark; their brand is a single rounded square (their favicon/app icon), so
  // it is authored here as one rounded-square path on the 24 grid.
  thinkingmachines: { path: "M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" }
};

// Serving-provider (a deployment's `provider` enum) → brand mark. The provider
// is the lane that serves a route, distinct from the model family above. `local`
// is a customer's own OpenAI-compatible server and has no brand, so it (and any
// unknown provider) falls through to the generic server glyph.
const PROVIDER_MARKS: Record<string, SimpleIcon | LocalMark> = {
  openai: LOCAL_MARKS.openai,
  anthropic: siAnthropic,
  gemini: siGooglegemini,
  azure_openai: LOCAL_MARKS.microsoft,
  openrouter: siOpenrouter,
  bedrock: LOCAL_MARKS.amazon,
  fireworks: LOCAL_MARKS.fireworks,
  modal: siModal,
  // The platform-operated lane wears the platform's own XP brand mark (the
  // same one the site header paints via components/brand/BrandMark.tsx).
  experiential_cloud: {
    path: BRAND_MARK_PATH,
    viewBox: BRAND_MARK_VIEWBOX,
    transform: BRAND_MARK_TRANSFORM
  }
};

type Mark = { path: string; viewBox: string; fillRule?: "evenodd"; transform?: string };

/** Normalize a simple-icons icon or a local mark to one render shape. */
function toMark(source: SimpleIcon | LocalMark): Mark {
  return "hex" in source
    ? { path: source.path, viewBox: "0 0 24 24" }
    : {
        path: source.path,
        viewBox: source.viewBox ?? "0 0 24 24",
        fillRule: source.fillRule,
        transform: source.transform
      };
}

/** One monochrome brand glyph; color comes from the caller via currentColor. */
function MarkSvg({ mark, size, className }: { mark: Mark; size: number; className?: string }) {
  return (
    <svg
      aria-hidden
      className={clsx("shrink-0 fill-current", className)}
      height={size}
      role="img"
      viewBox={mark.viewBox}
      width={size}
    >
      <path d={mark.path} fillRule={mark.fillRule} transform={mark.transform} />
    </svg>
  );
}

type ModelIconProps = {
  /**
   * The maker/family key (lib/models-catalog/families.ts `modelIconKey`); a key
   * with a mark paints it, any other key (a `name:*` fallback for a maker with
   * no mark, or null for a custom model) renders the monogram tile.
   */
  icon: string | null;
  /** Monogram source — the model or maker name — when no mark exists. */
  name: string;
  size?: number;
};

export function ModelIcon({ icon, name, size = 16 }: ModelIconProps) {
  const source = icon === null ? null : (FAMILY_MARKS[icon] ?? LOCAL_MARKS[icon] ?? null);
  if (source !== null) {
    return <MarkSvg className="text-ink-soft" mark={toMark(source)} size={size} />;
  }
  // The monogram reads from the human-readable name, never the internal key, so
  // an unmarked maker shows its brand initial (FLUX → F), not the key's letter.
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-sm border border-line-strong bg-surface-subtle font-mono font-semibold text-ink-soft"
      )}
      style={{ fontSize: Math.round(size * 0.62), height: size, width: size }}
    >
      {letter}
    </span>
  );
}

/**
 * The serving-provider logo for a deployment's `provider`, colored by the badge
 * it sits in (currentColor). A branded provider paints its mark; `local` and any
 * unknown provider paint a neutral server glyph rather than a raw letter.
 */
export function ProviderLogo({ provider, size = 12 }: { provider: string; size?: number }) {
  const source = PROVIDER_MARKS[provider] ?? null;
  if (source !== null) {
    return <MarkSvg mark={toMark(source)} size={size} />;
  }
  return <Server aria-hidden className="shrink-0" size={size} strokeWidth={1.8} />;
}
