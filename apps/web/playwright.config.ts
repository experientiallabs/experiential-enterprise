import { defineConfig, devices } from "@playwright/test";

const backendURL = process.env.EXPLABS_BACKEND_URL ?? "http://127.0.0.1:8030";
const apiKey = process.env.EXPLABS_API_KEY ?? "local-playwright-api-key";
const supabaseURL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54331";
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const supabaseDBURL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54332/postgres";
const shellApiKey = shellQuote(apiKey);
const shellSupabaseURL = shellQuote(supabaseURL);
const shellSupabaseAnonKey = shellQuote(supabaseAnonKey);
const shellSupabaseServiceRoleKey = shellQuote(supabaseServiceRoleKey);
const shellSupabaseDBURL = shellQuote(supabaseDBURL);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.EXPLABS_WEB_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: process.env.EXPLABS_WEB_URL
    ? undefined
    : [
        {
          command:
            `cd ../.. && EXPLABS_API_KEY=${shellApiKey} SUPABASE_URL=${shellSupabaseURL} ` +
            `SUPABASE_ANON_KEY=${shellSupabaseAnonKey} SUPABASE_SERVICE_ROLE_KEY=${shellSupabaseServiceRoleKey} ` +
            `SUPABASE_DB_URL=${shellSupabaseDBURL} UV_CACHE_DIR=/tmp/.uv-cache uv run explabs-api --host 127.0.0.1 --port 8030`,
          reuseExistingServer: true,
          timeout: 120_000,
          url: `${backendURL}/health`
        },
        {
          command:
            `EXPLABS_API_KEY=${shellApiKey} EXPLABS_BACKEND_URL=${backendURL} ` +
            `SUPABASE_URL=${shellSupabaseURL} SUPABASE_ANON_KEY=${shellSupabaseAnonKey} pnpm dev`,
          port: 3000,
          reuseExistingServer: true,
          timeout: 120_000
        }
      ]
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
