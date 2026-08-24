import { getAuthenticatedUser, requireAuthenticatedUser } from "./auth/server";
import { BackendDataSource } from "./backend-source";


/**
 * The one data source the web app talks to. A single implementation exists
 * on purpose: the seam is the class itself, injectable in tests by module
 * mock, not a parallel interface that drifts from it.
 */
export type PlatformDataSource = BackendDataSource;

export function getDataSource(): PlatformDataSource {
  return new BackendDataSource(
    requiredBackendUrl(),
    requiredBackendApiKey(),
    currentActorId,
    servingBackendUrl()
  );
}

/**
 * The same data source for the backend's PUBLIC catalog reads (models and
 * their deployments): a signed-in visitor is asserted as usual so their org's
 * own rows appear, a signed-out one carries no actor and sees the public
 * catalog instead of being bounced to sign-in.
 */
export function getCatalogDataSource(): PlatformDataSource {
  return new BackendDataSource(
    requiredBackendUrl(),
    requiredBackendApiKey(),
    optionalActorId,
    servingBackendUrl()
  );
}



/**
 * The data source for internal MACHINE routes (pg_cron ticks). It carries the
 * deployment bearer and no actor: a cron POST has no session, so the tenant
 * `getDataSource()` would throw asserting one. The backend authenticates these
 * calls by the internal bearer and fans out across orgs itself.
 */
export function getInternalDataSource(): PlatformDataSource {
  return new BackendDataSource(
    requiredBackendUrl(),
    requiredBackendApiKey(),
    machineActorId,
    servingBackendUrl()
  );
}

// A machine caller (pg_cron) never acts as a user; the backend derives scope
// from the internal bearer, so no actor header is attached.
async function machineActorId(): Promise<string | null> {
  return null;
}

// The backend enforces tenancy per acting user, so every backend request
// asserts the verified session's subject. Resolved lazily per request; the
// underlying verification is request-cached.
async function currentActorId(): Promise<string> {
  const user = await requireAuthenticatedUser();
  return user.id;
}

async function optionalActorId(): Promise<string | null> {
  const user = await getAuthenticatedUser();
  return user?.id ?? null;
}

function requiredBackendUrl(): string {
  const url = process.env.EXPLABS_BACKEND_URL;
  if (!url) {
    throw new Error("EXPLABS_BACKEND_URL must be set for the Experiential web app.");
  }
  return url;
}

// Set by the hosting platform render exactly when a dedicated serving app exists;
// undefined means /v1 rides the control-plane backend (previews, local).
function servingBackendUrl(): string | undefined {
  return process.env.EXPLABS_SERVING_BACKEND_URL || undefined;
}

function requiredBackendApiKey(): string {
  const apiKey = process.env.EXPLABS_API_KEY;
  if (!apiKey) {
    throw new Error("EXPLABS_API_KEY must be set for the Experiential web app.");
  }
  return apiKey;
}
