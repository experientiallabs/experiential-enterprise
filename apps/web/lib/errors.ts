export class DataSourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataSourceNotFoundError";
  }
}

/**
 * Non-404 backend failure with the upstream HTTP status preserved, so proxy
 * routes can forward meaningful statuses (409 already-building / not-ready /
 * session-expired, 422 foreign trace, 502 provider error) to the browser.
 */
export class DataSourceRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly action: string | null;

  constructor(
    message: string,
    status: number,
    metadata: { code?: string | null; action?: string | null } = {}
  ) {
    super(message);
    this.name = "DataSourceRequestError";
    this.status = status;
    this.code = metadata.code ?? null;
    this.action = metadata.action ?? null;
  }
}
