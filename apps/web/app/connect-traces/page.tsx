import { CopyPromptButton } from "@/components/onboarding/CopyPromptButton";
import { BrandMark } from "@/components/brand/BrandMark";
import { ContributionGrid } from "@/components/onboarding/ContributionGrid";
import { buildTraceTelemetryPrompt } from "@/components/trace-onboarding/setup-prompt";
import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";

export const metadata = { title: "Upload your traces as telemetry with your coding agent" };

export const dynamic = "force-dynamic";

// The paste-and-go surface for the trace-telemetry onboarding: a founder copies
// this into their CLI coding agent, which creates the account, interviews them
// about their observability provider, and pulls/uploads their LLM traces as
// telemetry (never a Project or router). Base URLs flow through the same
// deployment-aware resolvers the /llms.txt reference and the other onboarding
// pages use.
export default function ConnectTracesPage() {
  const apiBaseUrl = publicServingBaseUrl();
  const webBaseUrl = process.env.EXPLABS_WEBAPP_URL ?? PLATFORM_WEB_URL;
  const prompt = buildTraceTelemetryPrompt(webBaseUrl, apiBaseUrl);
  return (
    <div className="relative min-h-screen bg-onboard-bg flex items-center justify-center overflow-hidden py-16">
      <ContributionGrid className="absolute inset-0 w-full h-full opacity-40" />

      <div className="relative z-10 w-full max-w-[720px] px-6">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-6">
            <div className="w-11 h-11 bg-onboard-text rounded-xl flex items-center justify-center">
              <BrandMark className="w-7 h-7 text-onboard-bg" />
            </div>
            <span className="text-[15px] font-semibold text-onboard-muted tracking-[0.18em] uppercase font-mono">
              Experiential
            </span>
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-onboard-text mb-2">
            Upload your traces as telemetry
          </h1>
          <p className="text-sm text-onboard-muted">
            Paste this into your coding agent. It creates your account, asks which observability
            provider you use, and brings your existing LLM traces onto the platform as telemetry —
            no router, no Project.
          </p>
        </div>

        <div className="flex justify-center mb-6">
          <CopyPromptButton text={prompt} />
        </div>

        <pre
          className="w-full overflow-x-auto rounded-2xl border border-white/15 bg-white/[0.04] p-5 text-[12.5px] leading-relaxed text-onboard-text whitespace-pre-wrap font-mono"
          data-testid="trace-telemetry-prompt"
        >
          {prompt}
        </pre>
      </div>
    </div>
  );
}
