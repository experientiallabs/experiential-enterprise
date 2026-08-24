import { PolicyPage } from "@/components/settings/PolicyPage";

export const metadata = { title: "Terms of service" };

// Enterprise Trial build. The governing document is the LICENSE file at the
// root of this repository; this page points at it rather than restating the
// hosted service's commercial terms.
export default function TermsOfServicePage() {
  return (
    <PolicyPage kicker="Experiential Labs" title="Terms of service" updated="August 22, 2026">
      <h2>What governs this software</h2>
      <p>
        This deployment is the Experiential Labs Enterprise Trial. Your use of it is
        governed by the Enterprise Trial License in the <code>LICENSE</code> file at the
        root of the repository you deployed. That file is the agreement. Nothing on this
        page changes it.
      </p>
      <h2>What the trial is for</h2>
      <p>
        The trial is for evaluation. It runs in infrastructure you control and you operate
        it. You are responsible for the provider accounts you connect, the API keys you
        issue, and the workloads you send through the gateway.
      </p>
      <h2>Production and commercial use</h2>
      <p>
        The Trial License does not cover production use. Production terms, service
        commitments, and support come with a commercial agreement.
      </p>
      <h2>Contact</h2>
      <p>
        To purchase a commercial license, extend an evaluation, or ask a licensing
        question, contact{" "}
        <a href="mailto:founders@experientiallabs.ai">founders@experientiallabs.ai</a>.
      </p>
    </PolicyPage>
  );
}
