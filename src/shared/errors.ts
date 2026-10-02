/**
 * Standard error classification for UltraRoute web providers.
 * Differentiates router-level handling: credential failure, invalid request,
 * rate limit / quota, drift, challenges, timeouts, and upstream failures.
 */

export type ProviderErrorCode =
  | "CREDENTIAL_FAILURE"
  | "INVALID_REQUEST"
  | "RATE_LIMIT_EXCEEDED"
  | "UPSTREAM_DRIFT"
  | "CHALLENGE_REQUIRED"
  | "TIMEOUT"
  | "GENERIC_UPSTREAM_FAILURE";

export class WebProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ProviderErrorCode,
    httpStatus = 500,
    retryable = false,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "WebProviderError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CredentialError extends WebProviderError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CREDENTIAL_FAILURE", 401, false, details);
    this.name = "CredentialError";
  }
}

export class InvalidRequestError extends WebProviderError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "INVALID_REQUEST", 400, false, details);
    this.name = "InvalidRequestError";
  }
}

export class RateLimitError extends WebProviderError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, true, details);
    this.name = "RateLimitError";
  }
}

export class UpstreamDriftError extends WebProviderError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "UPSTREAM_DRIFT", 502, false, details);
    this.name = "UpstreamDriftError";
  }
}

export class ChallengeRequiredError extends WebProviderError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CHALLENGE_REQUIRED", 403, false, details);
    this.name = "ChallengeRequiredError";
  }
}

export class ProviderTimeoutError extends WebProviderError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "TIMEOUT", 504, true, details);
    this.name = "ProviderTimeoutError";
  }
}

export class GenericUpstreamError extends WebProviderError {
  constructor(message: string, httpStatus = 502, retryable = true, details?: Record<string, unknown>) {
    super(message, "GENERIC_UPSTREAM_FAILURE", httpStatus, retryable, details);
    this.name = "GenericUpstreamError";
  }
}

export function classifyHttpError(
  status: number,
  bodyText: string,
  provider: string
): WebProviderError {
  const lower = bodyText.toLowerCase();

  if (status === 401 || status === 403) {
    if (
      lower.includes("challenge") ||
      lower.includes("turnstile") ||
      lower.includes("cf-mitigated") ||
      lower.includes("just a moment") ||
      lower.includes("bot detection")
    ) {
      return new ChallengeRequiredError(
        `${provider} returned a bot challenge / security verification. Operator browser resolution required.`
      );
    }
    if (
      lower.includes("unauthorized") ||
      lower.includes("session") ||
      lower.includes("login") ||
      lower.includes("token")
    ) {
      return new CredentialError(
        `${provider} session is invalid or expired.`
      );
    }
    return new ChallengeRequiredError(
      `${provider} forbidden (${status}): ${bodyText.slice(0, 150)}`
    );
  }

  if (
    status === 429 ||
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("too many requests") ||
    lower.includes("usage limit")
  ) {
    return new RateLimitError(
      `${provider} rate limit or quota reached.`
    );
  }

  if (status >= 400 && status < 500) {
    return new InvalidRequestError(
      `${provider} rejected request (${status}): ${bodyText.slice(0, 200)}`
    );
  }

  if (status === 504 || lower.includes("timeout") || lower.includes("timed out")) {
    return new ProviderTimeoutError(`${provider} request timed out.`);
  }

  return new GenericUpstreamError(
    `${provider} upstream error (${status}): ${bodyText.slice(0, 200)}`,
    status
  );
}
