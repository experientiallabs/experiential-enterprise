// Next.js client instrumentation hook: runs once in the browser before the app
// hydrates. PostHog init lives here so pageviews (including history-change
// navigations) are captured without threading a provider through the tree.
import { initTelemetry } from "@/lib/telemetry/client";

initTelemetry();
