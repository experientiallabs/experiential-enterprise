import Link from "next/link";

import {
  Callout,
  Code,
  DocsList,
  DocsSection,
  DocsSubheading,
  DocsTable,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";

export const metadata = { title: "Errors" };

// Every stable /v1 error code the gateway worker returns, with the recovery an
// agent should take. Sourced from the shipped mapping in the world-model-
// optimizer gateway (public_failure_error plus the protocol-boundary raises);
// the messages are written for machine self-correction, so the docs stay
// faithful to them.
const ERROR_COLUMNS = [
  { key: "code", header: "code", mono: true },
  { key: "http", header: "HTTP", mono: true },
  { key: "meaning", header: "Meaning" },
  { key: "recover", header: "How to recover" }
] as const;

const ERROR_ROWS = [
  {
    code: "invalid_json",
    http: "400",
    meaning: "The request body is not valid JSON.",
    recover: "Fix the request body."
  },
  {
    code: "invalid_request",
    http: "400",
    meaning: "The request is malformed.",
    recover: "Read the message, fix the request, and resend."
  },
  {
    code: "invalid_parameter",
    http: "400",
    meaning: "A field is invalid; param names it.",
    recover: "Correct that field and resend."
  },
  {
    code: "unsupported_capability",
    http: "400",
    meaning: "The model cannot do what you asked (a tool, a modality, reasoning).",
    recover: "Pick a capable model; check supported_params and modalities in /api/models."
  },
  {
    code: "continuation_unavailable",
    http: "400",
    meaning: "previous_response_id is unknown or expired on this worker.",
    recover: "Resend the full conversation instead of continuing."
  },
  {
    code: "invalid_key",
    http: "401",
    meaning: "The key is missing, malformed, expired, or revoked.",
    recover: "Fix the Authorization header."
  },
  {
    code: "model_not_granted",
    http: "403",
    meaning: "Your organization cannot call this slug.",
    recover: "Use a slug returned by GET /v1/models."
  },
  {
    code: "idempotency_conflict",
    http: "409",
    meaning: "The same Idempotency-Key was reused with a different body.",
    recover: "Use a fresh Idempotency-Key."
  },
  {
    code: "idempotency_replay_unavailable",
    http: "409 / 500",
    meaning: "The original keyed result is gone after a restart.",
    recover: "Resend with a new Idempotency-Key."
  },
  {
    code: "insufficient_quota",
    http: "429",
    meaning:
      "A spend limit or your credit balance is exhausted; the message says which (a daily org cap, a per-model cap, or credits).",
    recover: "Add credits or raise limits at /credits (platform-funded lane only)."
  },
  {
    code: "unavailable_route",
    http: "429 / 503",
    meaning: "Throttled, or no healthy route right now.",
    recover: "Retry with backoff."
  },
  {
    code: "gateway_overloaded",
    http: "429",
    meaning: "The bounded replay window is full.",
    recover: "Retry with backoff."
  },
  {
    code: "request_cancelled",
    http: "499",
    meaning: "The client disconnected before completion.",
    recover: "Reissue the request if you still want the result."
  },
  {
    code: "all_routes_failed",
    http: "502",
    meaning: "Every provider in the waterfall failed.",
    recover: "Retry; if you are on BYOK, check your provider key."
  },
  {
    code: "provider_output_too_large",
    http: "502",
    meaning: "Provider output exceeded the gateway response limit.",
    recover: "Lower max output tokens."
  },
  {
    code: "gateway_draining",
    http: "503",
    meaning: "This instance is draining and is not taking new requests.",
    recover: "Retry; the request lands on another instance."
  },
  {
    code: "deadline_exceeded",
    http: "504",
    meaning: "The request ran past the gateway deadline.",
    recover: "Shorten the work or retry."
  },
  {
    code: "internal_error",
    http: "500",
    meaning: "An unexpected failure.",
    recover: "Retry with backoff."
  }
];

export default function ErrorsDocsPage() {
  return (
    <>
      <DocsPageHeader
        eyebrow="Guides"
        title="Errors"
        lede="Every error the gateway returns is an OpenAI-compatible envelope with a stable code. The messages are written so an agent can self-correct from the code and message alone."
      />

      <DocsSection id="envelope" title="The error envelope">
        <Prose>
          Every failure on <Code>/v1/chat/completions</Code>,{" "}
          <Code>/v1/responses</Code>, and <Code>/v1/models</Code> returns the same
          shape, so existing OpenAI error handling keeps working:
        </Prose>
        <pre className="docs-code my-4 overflow-x-auto rounded-lg border border-line bg-surface p-4 font-mono text-[12.5px] leading-relaxed text-ink">
          {`{
  "error": {
    "message": "The requested model alias is not granted to this identity.",
    "type": "permission_error",
    "code": "model_not_granted",
    "param": null
  }
}`}
        </pre>
        <Prose>
          Branch on <Code>code</Code>, not the message text; the message is
          human-readable and may change, the code is stable.
        </Prose>
      </DocsSection>

      <DocsSection id="codes" title="Stable codes">
        <DocsTable columns={ERROR_COLUMNS} rows={ERROR_ROWS} />
        <Prose>
          Any unknown <Code>/v1</Code> path returns <Code>404</Code> with{" "}
          <Code>code=not_found</Code>. The gateway serves exactly{" "}
          <Code>/v1/models</Code>, <Code>/v1/chat/completions</Code>, and{" "}
          <Code>/v1/responses</Code>.
        </Prose>
      </DocsSection>

      <DocsSection id="retrying" title="What to retry">
        <DocsList>
          <li>
            Retry <Code>429</Code> (throttled or overloaded), <Code>502</Code>,{" "}
            <Code>503</Code>, and <Code>504</Code> with exponential backoff.
          </li>
          <li>
            Do not blindly retry <Code>400</Code>, <Code>401</Code>,{" "}
            <Code>403</Code>, or <Code>409</Code>. Fix the request first; the same
            call fails the same way.
          </li>
          <li>
            <Code>insufficient_quota</Code> is not transient: it clears when you
            add credits or raise a limit, not on retry.
          </li>
        </DocsList>
        <Callout tone="warning">
          Delivery is at-least-once: an ambiguous network failure that you retry
          can dispatch and bill the underlying provider twice. Pass an{" "}
          <Code>Idempotency-Key</Code> header so an exact retry replays the
          original result instead of running again.
        </Callout>
      </DocsSection>

      <DocsSection id="more" title="See also">
        <Prose>
          The{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/reference">
            API reference
          </Link>{" "}
          documents each endpoint, and{" "}
          <a className="text-ink underline underline-offset-2" href="/llms.txt">
            /llms.txt
          </a>{" "}
          carries this same error table for agents.
        </Prose>
      </DocsSection>
    </>
  );
}
