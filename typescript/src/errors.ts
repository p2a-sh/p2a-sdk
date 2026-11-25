const TOKEN = /ibi_[A-Za-z0-9]+/g;

export function redact(value: string): string {
  return value.replace(TOKEN, "ibi_[redacted]");
}

export interface ErrorOptions {
  retryAfter?: number;
  requestId?: string;
  message?: string;
  status?: number;
}

export class P2AError extends Error {
  readonly code: string;
  readonly retryAfter?: number;
  readonly requestId?: string;
  readonly status?: number;

  constructor(code: string, options: ErrorOptions = {}) {
    super(redact(options.message ?? code));
    this.name = new.target.name;
    this.code = code;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.requestId) this.requestId = options.requestId;
    if (options.status !== undefined) this.status = options.status;
  }

  override toString(): string {
    return redact(`${this.name}: ${this.message}`);
  }
}

export class AuthError extends P2AError {
  constructor(message = "unauthorized") {
    super("unauthorized", { message, status: 401 });
  }
}

export class RateLimited extends P2AError {
  constructor(retryAfter?: number, requestId?: string) {
    super("rate_limited", { retryAfter, requestId, message: "rate_limited" });
  }
}

export class ConfirmationRequired extends P2AError {
  readonly recipient?: string;

  constructor(recipient?: string, requestId?: string) {
    super("confirmation_required", { requestId, message: "confirmation_required" });
    if (recipient) this.recipient = recipient;
  }
}

export class ConnectionDeclined extends P2AError {
  constructor(retryAfter?: number, requestId?: string) {
    super("connection_declined", {
      retryAfter,
      requestId,
      message: "connection_declined",
    });
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof AuthError) return false;
  if (err instanceof ConfirmationRequired) return false;
  if (err instanceof ConnectionDeclined) return false;
  if (err instanceof RateLimited) return true;
  if (err instanceof P2AError) {
    if (err.code === "network") return true;
    if (err.status === 408 || err.status === 425 || err.status === 429) return true;
    if (err.status !== undefined && err.status >= 500) return true;
  }
  return false;
}
