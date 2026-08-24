import { PolicyPage } from "@/components/settings/PolicyPage";

export const metadata = { title: "Privacy policy" };

// Enterprise Trial build. This deployment sends nothing to Experiential Labs,
// so the page states that instead of describing a hosted service's processing.
export default function PrivacyPolicyPage() {
  return (
    <PolicyPage kicker="Experiential Labs" title="Privacy policy" updated="August 22, 2026">
      <h2>Where your data lives</h2>
      <p>
        This trial runs entirely in your own infrastructure. Accounts, API keys, provider
        credentials, requests, and usage records stay in the database and object storage you
        deployed.
      </p>
      <h2>What we receive</h2>
      <p>
        Experiential Labs receives no data from this deployment. The only outbound traffic is
        container image pulls at provision time, the pinned engine fetch when you build from
        source, the Let&apos;s Encrypt exchange that issues your certificate, and the model
        provider calls you configure. There is no product analytics, no usage reporting, and
        no license check.
      </p>
      <h2>Who else sees your data</h2>
      <p>
        Only the services you connect. Requests you route to a model provider go to that
        provider under its own terms, using credentials you supply. The same applies to any
        mail or payment service you enable.
      </p>
      <h2>Isolation inside the deployment</h2>
      <p>
        Identifiable data is scoped to an organization. Access requires membership in that
        organization, enforced at the database layer on every API request. Provider
        credentials are stored server-side and are never returned to a browser.
      </p>
      <h2>Retention and deletion</h2>
      <p>
        Organization admins can delete all of an organization&apos;s product data at any time
        from Settings, and any user can delete their account. Both actions are immediate. You
        own the backups, so you control what survives them.
      </p>
      <h2>The hosted service</h2>
      <p>
        The Experiential Labs hosted service is a separate product with its own privacy
        policy. This page covers only the software running in this deployment.
      </p>
      <h2>Contact</h2>
      <p>
        Questions about this policy:{" "}
        <a href="mailto:founders@experientiallabs.ai">founders@experientiallabs.ai</a>.
      </p>
    </PolicyPage>
  );
}
