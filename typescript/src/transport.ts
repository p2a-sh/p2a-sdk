import { backoffMs, type Clock, systemClock } from "./clock.js";
import {
  AuthError,
  ConfirmationRequired,
  ConnectionDeclined,
  P2AError,
  RateLimited,
  isRetryable,
} from "./errors.js";
import { SseParser } from "./sse.js";

const TRIES = 3;

export interface RpcResult {
  events?: FeedEvent[];
  cursor?: string;
  nextPollMs?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface FeedEvent {
  eventId?: string;
  name?: string;
  data?: Record<string, unknown>;
  cursor?: string;
}

export interface StreamNote {
  method: string;
  cursor?: string;
  event?: FeedEvent;
}

export interface TransportOptions {
  token: string;
  url: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

export class Transport {
  readonly token: string;
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private nextId = 1;
  private initialized = false;

  constructor(options: TransportOptions) {
    this.token = options.token;
    this.url = options.url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? systemClock;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.attempt(true, () =>
      this.rpcOnce("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "p2a-sdk", version: "0.2.1" },
      }),
    );
    this.initialized = true;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    retry: boolean,
  ): Promise<Record<string, unknown>> {
    return this.attempt(retry, async () => {
      const result = await this.rpcOnce("tools/call", { name, arguments: args });
      const payload = unwrapTool(result);
      classify(payload);
      return payload;
    });
  }

  async poll(name: string, cursor?: string): Promise<RpcResult> {
    const params: Record<string, unknown> = { name };
    if (cursor) params.cursor = cursor;
    const result = await this.attempt(true, () => this.rpcOnce("events/poll", params));
    return {
      events: Array.isArray(result.events) ? (result.events as FeedEvent[]) : [],
      cursor: typeof result.cursor === "string" ? result.cursor : cursor,
      nextPollMs: typeof result.nextPollMs === "number" ? result.nextPollMs : 25_000,
      hasMore: result.hasMore === true,
    };
  }

  async *stream(name: string, cursor: string | undefined, signal: AbortSignal): AsyncGenerator<StreamNote> {
    const params: Record<string, unknown> = { name };
    if (cursor) params.cursor = cursor;
    const response = await this.post("events/stream", params, signal);
    if (!response.body) throw new P2AError("stream_failed", { message: "stream_failed" });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      while (!signal.aborted) {
        const read = await reader.read();
        if (read.done) break;
        const chunk = decoder.decode(read.value, { stream: true });
        for (const message of parser.push(chunk)) {
          const note = parseNote(message.data);
          if (note) yield note;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async attempt<T>(retry: boolean, run: () => Promise<T>): Promise<T> {
    let last: unknown;
    const tries = retry ? TRIES : 1;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        return await run();
      } catch (err) {
        last = err;
        if (!retry || attempt === tries || !isRetryable(err)) throw err;
        const wait =
          err instanceof RateLimited && err.retryAfter !== undefined
            ? Math.max(0, err.retryAfter) * 1000
            : backoffMs(attempt, this.clock.random());
        await this.clock.sleep(wait);
      }
    }
    throw last instanceof Error ? last : new P2AError("network", { message: "network" });
  }

  private async rpcOnce(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.post(method, params);
    return readRpc(response);
  }

  private async post(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const id = this.nextId;
    this.nextId += 1;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
        signal,
      });
    } catch (err) {
      if (err instanceof P2AError) throw err;
      if (signal?.aborted) throw err;
      throw new P2AError("network", { message: "network" });
    }
    if (response.status === 401) throw new AuthError();
    if (response.status === 429) {
      throw new RateLimited(retryAfterHeader(response));
    }
    if (!response.ok && method !== "events/stream") {
      throw new P2AError(`http_${response.status}`, {
        message: `http_${response.status}`,
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new P2AError(`http_${response.status}`, {
        message: `http_${response.status}`,
        status: response.status,
      });
    }
    return response;
  }
}

function retryAfterHeader(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

async function readRpc(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new P2AError("invalid_response", { message: "invalid_response" });
  }
  if (!body || typeof body !== "object") {
    throw new P2AError("invalid_response", { message: "invalid_response" });
  }
  const record = body as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    const message = typeof error.message === "string" ? error.message : "rpc_error";
    throw new P2AError(message, { message });
  }
  const result = record.result;
  if (!result || typeof result !== "object") return {};
  return result as Record<string, unknown>;
}

function unwrapTool(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
  if (!text) return result;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    return { text };
  }
  return { text };
}

function classify(payload: Record<string, unknown>): void {
  const code = typeof payload.error === "string" ? payload.error : undefined;
  const status = typeof payload.status === "string" ? payload.status : undefined;
  const retryAfter = typeof payload.retry_after === "number" ? payload.retry_after : undefined;
  const requestId = typeof payload.request_id === "string" ? payload.request_id : undefined;
  const recipient =
    (typeof payload.to === "string" && payload.to) ||
    (typeof payload.recipient === "string" && payload.recipient) ||
    undefined;
  if (code === "rate_limited" || status === "rate_limited") {
    throw new RateLimited(retryAfter, requestId);
  }
  if (code === "confirmation_required" || status === "confirmation_required") {
    throw new ConfirmationRequired(recipient, requestId);
  }
  if (code === "connection_declined" || status === "connection_declined") {
    throw new ConnectionDeclined(retryAfter, requestId);
  }
  if (code) throw new P2AError(code, { retryAfter, requestId, message: code });
}

function parseNote(data: string): StreamNote | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : "";
  const params =
    record.params && typeof record.params === "object"
      ? (record.params as Record<string, unknown>)
      : {};
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  if (method !== "notifications/events/event") return { method, cursor };
  const event: FeedEvent = {
    eventId: typeof params.eventId === "string" ? params.eventId : undefined,
    name: typeof params.name === "string" ? params.name : undefined,
    data:
      params.data && typeof params.data === "object"
        ? (params.data as Record<string, unknown>)
        : {},
    cursor,
  };
  return { method, cursor, event };
}
