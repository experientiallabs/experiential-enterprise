import { PolicyPage } from "@/components/settings/PolicyPage";

export const metadata = { title: "Security & reliability" };

// Enterprise Trial build. The claims here are the ones the shipped code
// enforces. Availability and operations belong to whoever runs the deployment,
// so this page does not describe a fleet it does not have.
export default function SecurityPage() {
  return (
    <PolicyPage
      kicker="Experiential Labs"
      title="Security & reliability"
      updated="August 22, 2026"
    >
      <p>
        This deployment is the Experiential Labs Enterprise Trial: an OpenAI-compatible{" "}
        <code>/v1</code> gateway you run in your own infrastructure. This page describes the
        controls the shipped code enforces. Availability, patching, backups, and network
        exposure are yours, because you operate the machine.
      </p>

      <h2>Data isolation</h2>
      <p>
        Every organization&apos;s data is scoped to that organization and enforced at the
        database layer on every API request, not just in the UI. Access requires membership in
        the organization. Model access is deny-by-default: an API key can reach a model only
        through a grant you have explicitly created.
      </p>

      <h2>Credential handling</h2>
      <p>
        Provider keys you connect and telemetry-provider credentials are stored server-side
        behind privileged database routines and are never returned to a browser.
        Provider-internal identifiers (sandbox, deployment, and vendor handles) are treated as
        server-internal and excluded from public API responses.
      </p>

      <h2>Request-time controls</h2>
      <p>
        Authentication failures return a uniform 401 with no information about why a key was
        rejected. The gateway streams responses and does not retain prompt or response bodies
        to replay them. Admission runs through a single reservation checkpoint that fails
        closed: per-scope monthly and recurring budgets, tokens-per-minute limits, and a guard
        against dispatching a request whose price is unknown. Cross-tenant isolation, secret
        non-leakage, prompt non-retention, injection resistance, and behavior under load and
        provider faults are exercised by the test suite in this repository.
      </p>

      <h2>What this deployment sends us</h2>
      <p>
        Nothing. Product analytics ship disabled, the engine&apos;s telemetry is switched off,
        and there is no license check or usage report. Outbound traffic is image pulls, the
        certificate exchange, and the model provider calls you configure.
      </p>

      <h2>Availability is yours</h2>
      <p>
        The trial is a single-VM Compose deployment. It runs one instance of each service and
        one database. Replication, failover, backups, and monitoring are not part of it. Treat
        it as an evaluation environment, not a production topology.
      </p>

      <h2>Reporting a vulnerability</h2>
      <p>
        If you believe you have found a security issue in this software, contact{" "}
        <a href="mailto:founders@experientiallabs.ai">founders@experientiallabs.ai</a>. We welcome
        coordinated disclosure and will work with you on a fix and timeline.
      </p>
    </PolicyPage>
  );
}
