import { backoffMs, systemClock, type Clock } from "./clock.js";
import {
  AuthError,
  P2AError,
} from "./errors.js";
import { Transport, type FeedEvent } from "./transport.js";

const LEASE_SECONDS = 300;
const CUSTOMER_TEXT = "A person from Acme will follow up here.";
const FAILED_TEXT = "Sorry, something went wrong.";
const REQUEST_NAMES = ["aweb.request.created"];
const SIDE_NAMES = [
  "aweb.reply.received",
  "aweb.connection.requested",
  "aweb.connection.updated",
];
const ALL_NAMES = [...REQUEST_NAMES, ...SIDE_NAMES];

const COMPLETE = Symbol("p2a.complete");

export interface Logger {
  info(line: string): void;
  warn?(line: string): void;
}

export interface P2ASender {
  did?: string;
  address?: string;
}

export interface P2ARequest {
  requestId: string;
  text: string;
  sender: P2ASender;
  sameOwner: boolean;
  contextId?: string;
  brief?: unknown;
  eventId?: string;
}

export interface P2AMessage {
  eventId?: string;
  requestId?: string;
  text?: string;
  sender?: string;
  sameOwner?: boolean;
}

export interface P2AOutcome {
  eventId?: string;
  requestId?: string;
  parentRequestId?: string;
  outcome?: unknown;
}

export interface P2AReply {
  eventId?: string;
  requestId?: string;
  text?: string;
  summary?: string;
}

export interface ConnectionRequest {
  linkId: string;
  from?: string;
  owner?: string;
  text?: string;
}

export interface SendOptions {
  idempotencyKey?: string;
  deadlineSeconds?: number;
  wait?: number;
}

export interface SendResult {
  status?: string;
  requestId?: string;
  replyText?: string;
  summary?: string;
}

export interface PlanBody {
  title: string;
  items: unknown[];
}

export interface P2ADirective {
  outcome: string;
  result: Record<string, unknown>;
}

interface Directive extends P2ADirective {
  [COMPLETE]: true;
}

export interface BriefOptions {
  scope?: string;
  scopeKind?: string;
  scopeId?: string;
}

export interface WaitOptions {
  timeout?: number;
}

export interface HandlerContext {
  readonly signal: AbortSignal;
  progress(note?: string): Promise<void>;
  brief(options?: BriefOptions): Promise<Record<string, unknown>>;
  sender(): Promise<Record<string, unknown>>;
  escalate(question: string, options?: { customerText?: string }): P2ADirective;
  askCustomer(text: string): P2ADirective;
  plan(plan: PlanBody): P2ADirective;
}

export type RequestHandler = (
  req: P2ARequest,
  ctx: HandlerContext,
) => Promise<string | P2ADirective | void> | string | P2ADirective | void;

export interface AgentOptions {
  token?: string;
  url?: string;
  logger?: Logger;
  maxConcurrent?: number;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

const silent: Logger = { info() {} };

export class P2AAgent {
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly maxConcurrent: number;
  private readonly clock: Clock;
  private onRequestHandler?: RequestHandler;
  private onMessageHandler?: (msg: P2AMessage) => Promise<void> | void;
  private onOutcomeHandler?: (evt: P2AOutcome) => Promise<void> | void;
  private onReplyHandler?: (reply: P2AReply) => Promise<void> | void;
  private onConnectionHandler?: (req: ConnectionRequest) => Promise<void> | void;
  private readonly seen = new Set<string>();

  constructor(options: AgentOptions = {}) {
    const token = options.token ?? process.env.P2A_TOKEN ?? "";
    const url = options.url ?? process.env.P2A_URL ?? "";
    if (!token || !url) {
      throw new P2AError("missing_config", { message: "Set P2A_TOKEN and P2A_URL" });
    }
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silent;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.transport = new Transport({
      token,
      url,
      fetchImpl: options.fetchImpl,
      clock: this.clock,
    });
  }

  onRequest(handler: RequestHandler): void {
    this.onRequestHandler = handler;
  }

  onMessage(handler: (msg: P2AMessage) => Promise<void> | void): void {
    this.onMessageHandler = handler;
  }

  onOutcome(handler: (evt: P2AOutcome) => Promise<void> | void): void {
    this.onOutcomeHandler = handler;
  }

  onReply(handler: (reply: P2AReply) => Promise<void> | void): void {
    this.onReplyHandler = handler;
  }

  /** Default is to do nothing. The handler decides whether to accept. */
  onConnectionRequest(handler: (req: ConnectionRequest) => Promise<void> | void): void {
    this.onConnectionHandler = handler;
  }

  /**
   * Accept, decline, or block a connection request.
   * The call itself is the confirmation, so confirm is always true.
   * Accept works once the server allows it; the result is returned as-is.
   */
  async respondConnection(
    linkId: string,
    action: "accept" | "decline" | "block",
  ): Promise<Record<string, unknown>> {
    return this.transport.callTool(
      "p2a_respond_connection",
      { link_id: linkId, action, confirm: true },
      false,
    );
  }

  /**
   * Look up an agent by address, owner, or did.
   * This works outside a request. The target is sent unchanged.
   */
  async resolve(target: string): Promise<Record<string, unknown>> {
    return this.transport.callTool("p2a_resolve_agent", { target }, true);
  }

  async send(to: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    const payload = await this.transport.callTool(
      "p2a_send_message",
      {
        to,
        text,
        idempotency_key: options.idempotencyKey ?? crypto.randomUUID(),
        wait_seconds: options.wait ?? 0,
        ...(options.deadlineSeconds !== undefined
          ? { deadline_seconds: options.deadlineSeconds }
          : {}),
      },
      false,
    );
    return sendResult(payload);
  }

  async waitForReply(requestId: string, options: WaitOptions = {}): Promise<SendResult> {
    const payload = await this.transport.callTool(
      "p2a_wait_for_reply",
      {
        request_id: requestId,
        ...(options.timeout !== undefined ? { wait_seconds: options.timeout } : {}),
      },
      false,
    );
    return sendResult(payload);
  }

  async listen(options: { mode?: "stream" | "poll"; signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal ?? new AbortController().signal;
    // Handshake only. The server marks the runtime connected on the first
    // tools/call or events feed read, not on initialize.
    await this.transport.initialize();
    if (signal.aborted) return;
    await this.drainInbox();
    if (signal.aborted) return;
    if ((options.mode ?? "stream") === "poll") {
      await this.pollLoop(ALL_NAMES, signal);
      return;
    }
    const outcome = await this.streamWithSidePoll(signal);
    if (outcome === "fallback" && !signal.aborted) await this.pollLoop(ALL_NAMES, signal);
  }

  private async drainInbox(): Promise<void> {
    const inbox = await this.transport.callTool("p2a_check_new", {}, true);
    const pending = Array.isArray(inbox.pending_requests) ? inbox.pending_requests : [];
    const replies = Array.isArray(inbox.unread_replies) ? inbox.unread_replies : [];
    const connections = Array.isArray(inbox.connection_requests) ? inbox.connection_requests : [];
    await this.each(
      pending.map((item) => {
        const record = asRecord(item);
        if (record.kind === "outcome") {
          return {
            name: "aweb.request.created",
            data: {
              request_id: record.request_id,
              kind: "outcome",
              parent_request_id: record.parent_request_id,
            },
          };
        }
        return {
          name: "aweb.request.created",
          data: {
            request_id: record.request_id,
            sender: record.from,
            same_owner: record.same_owner,
            kind: record.kind,
          },
        };
      }),
    );
    for (const item of replies) {
      const record = asRecord(item);
      await this.dispatchReply({
        requestId: typeof record.request_id === "string" ? record.request_id : undefined,
        summary: typeof record.summary === "string" ? record.summary : undefined,
      });
    }
    for (const item of connections) {
      await this.dispatchConnection(asRecord(item));
    }
  }

  private async pollLoop(names: string[], signal: AbortSignal): Promise<void> {
    const cursors = new Map<string, string>();
    let failures = 0;
    while (!signal.aborted) {
      let wait = 25_000;
      let more = false;
      try {
        for (const name of names) {
          if (signal.aborted) return;
          const page = await this.transport.poll(name, cursors.get(name));
          if (page.cursor) cursors.set(name, page.cursor);
          if (page.nextPollMs !== undefined) wait = Math.min(wait, page.nextPollMs);
          if (page.hasMore) more = true;
          await this.each(page.events ?? []);
        }
      } catch (err) {
        if (signal.aborted || isAbort(err)) return;
        if (!isTransientPollError(err)) throw err;
        failures += 1;
        this.notePollRetry(err);
        await this.clock.sleep(backoffMs(failures, this.clock.random()), signal);
        continue;
      }
      failures = 0;
      if (signal.aborted) return;
      if (!more) await this.clock.sleep(wait, signal);
    }
  }

  private async streamWithSidePoll(signal: AbortSignal): Promise<"fallback" | "stopped"> {
    const side = new AbortController();
    const stopSide = () => side.abort();
    signal.addEventListener("abort", stopSide);
    const polling = this.pollLoop(SIDE_NAMES, side.signal);
    try {
      return await this.streamLoop(signal);
    } finally {
      side.abort();
      signal.removeEventListener("abort", stopSide);
      await polling.catch((err) => {
        if (isAbort(err)) return;
        throw err;
      });
    }
  }

  private async streamLoop(signal: AbortSignal): Promise<"fallback" | "stopped"> {
    let failures = 0;
    let cursor: string | undefined;
    while (!signal.aborted) {
      try {
        for await (const note of this.transport.stream("aweb.request.created", cursor, signal)) {
          if (signal.aborted) return "stopped";
          failures = 0;
          if (note.cursor) cursor = note.cursor;
          if (note.event) await this.accept(note.event);
        }
        if (signal.aborted) return "stopped";
        failures += 1;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (signal.aborted || isAbort(err)) return "stopped";
        failures += 1;
      }
      if (failures >= 3) return "fallback";
      await this.clock.sleep(backoffMs(failures, this.clock.random()), signal);
    }
    return "stopped";
  }

  private async each(events: FeedEvent[]): Promise<void> {
    const queue = [...events];
    const workers = Array.from({ length: Math.min(this.maxConcurrent, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await this.accept(next);
      }
    });
    await Promise.all(workers);
  }

  private async accept(event: FeedEvent): Promise<void> {
    const name = event.name ?? "";
    const data = event.data ?? {};
    if (name === "aweb.reply.received") {
      await this.dispatchReply({
        eventId: event.eventId,
        requestId: stringField(data, "request_id"),
        text: stringField(data, "text") ?? stringField(data, "reply_text"),
        summary: stringField(data, "summary"),
      });
      return;
    }
    if (name === "aweb.connection.requested") {
      await this.dispatchConnection(data, event.eventId);
      return;
    }
    if (name !== "aweb.request.created") {
      this.log({ eventId: event.eventId });
      return;
    }
    const kind = stringField(data, "kind");
    if (kind === "message") {
      if (this.onMessageHandler) {
        await this.onMessageHandler({
          eventId: event.eventId,
          requestId: stringField(data, "request_id"),
          text: stringField(data, "text"),
          sender: stringField(data, "sender"),
          sameOwner: data.same_owner === true,
        });
      } else this.log({ eventId: event.eventId });
      return;
    }
    if (kind === "outcome") {
      if (this.onOutcomeHandler) {
        await this.onOutcomeHandler({
          eventId: event.eventId,
          requestId: stringField(data, "request_id"),
          parentRequestId: stringField(data, "parent_request_id"),
          outcome: data.outcome,
        });
      } else this.log({ eventId: event.eventId });
      return;
    }
    if (kind && kind !== "request") {
      this.log({ eventId: event.eventId });
      return;
    }
    await this.claimAndRun(data, event.eventId);
  }

  private async dispatchReply(reply: P2AReply): Promise<void> {
    if (this.onReplyHandler) await this.onReplyHandler(reply);
    else this.log({ eventId: reply.eventId, requestId: reply.requestId });
  }

  private async dispatchConnection(data: Record<string, unknown>, eventId?: string): Promise<void> {
    const linkId = stringField(data, "link_id");
    if (!linkId) {
      this.log({ eventId });
      return;
    }
    if (!this.onConnectionHandler) {
      this.log({ eventId });
      return;
    }
    await this.onConnectionHandler({
      linkId,
      from: stringField(data, "from"),
      owner: stringField(data, "owner"),
      text: stringField(data, "text"),
    });
  }

  private async claimAndRun(data: Record<string, unknown>, eventId?: string): Promise<void> {
    const requestId = stringField(data, "request_id");
    if (!requestId || this.seen.has(requestId)) return;
    this.seen.add(requestId);
    const attemptId = crypto.randomUUID();
    const started = this.clock.now();
    let claim: Record<string, unknown>;
    try {
      claim = await this.transport.callTool(
        "claim_request",
        { request_id: requestId, attempt_id: attemptId, lease_seconds: LEASE_SECONDS },
        true,
      );
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof P2AError && skipClaim(err.code)) {
        this.log({ requestId, eventId, outcome: err.code });
        return;
      }
      this.log({ requestId, eventId });
      return;
    }
    const handlerStop = new AbortController();
    const keeperStop = new AbortController();
    const keeper = this.keepLease(requestId, attemptId, keeperStop.signal);
    let directive: Directive;
    try {
      directive = await this.runHandler(claim, data, eventId, handlerStop.signal, attemptId);
    } finally {
      keeperStop.abort();
      handlerStop.abort();
      await keeper.catch(() => undefined);
    }
    await this.finish(requestId, attemptId, directive, eventId, started);
  }

  private async runHandler(
    claim: Record<string, unknown>,
    data: Record<string, unknown>,
    eventId: string | undefined,
    signal: AbortSignal,
    attemptId: string,
  ): Promise<Directive> {
    const requestId = stringField(claim, "request_id") ?? stringField(data, "request_id") ?? "";
    const input = asRecord(claim.untrusted_input);
    const req: P2ARequest = {
      requestId,
      text: stringField(input, "text") ?? stringField(data, "text") ?? "",
      sender: {
        did: stringField(claim, "sender_did"),
        address: stringField(data, "sender") ?? stringField(input, "sender"),
      },
      sameOwner: claim.same_owner === true,
      contextId: stringField(claim, "conversation_id"),
      brief: claim.brief,
      eventId,
    };
    let senderCard: Promise<Record<string, unknown>> | undefined;
    const ctx: HandlerContext = {
      signal,
      progress: async (note?: string) => {
        await this.transport.callTool(
          "p2a_progress",
          {
            request_id: requestId,
            attempt_id: attemptId,
            state: "working",
            ...(note ? { note } : {}),
          },
          true,
        );
      },
      brief: (options) =>
        this.transport.callTool(
          "p2a_brief_get",
          {
            scope: options?.scope ?? "",
            scope_kind: options?.scopeKind ?? "",
            scope_id: options?.scopeId ?? "",
          },
          true,
        ),
      sender: () => {
        if (!senderCard) {
          senderCard = (async () => {
            if (!req.sender.did) return {};
            try {
              return await this.resolve(req.sender.did);
            } catch (err) {
              senderCard = undefined;
              throw err;
            }
          })();
        }
        return senderCard;
      },
      escalate: (question, options) =>
        directive("needs_approval", {
          text: question,
          customer_text: options?.customerText ?? CUSTOMER_TEXT,
        }),
      askCustomer: (text) => directive("input_required", { text }),
      plan: (plan) => directive("completed", { kind: "plan", title: plan.title, items: plan.items }),
    };
    if (!this.onRequestHandler) return directive("completed", { text: "" });
    try {
      const returned = await this.onRequestHandler(req, ctx);
      if (isDirective(returned)) return returned;
      return directive("completed", { text: typeof returned === "string" ? returned : "" });
    } catch {
      return directive("failed", { text: FAILED_TEXT });
    }
  }

  private async finish(
    requestId: string,
    attemptId: string,
    body: Directive,
    eventId: string | undefined,
    started: number,
  ): Promise<void> {
    const args = {
      request_id: requestId,
      attempt_id: attemptId,
      outcome: body.outcome,
      result: body.result,
    };
    try {
      await this.transport.callTool("complete_request", args, true);
      this.log({
        requestId,
        eventId,
        outcome: body.outcome,
        durationMs: this.clock.now() - started,
      });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      const outcome = err instanceof P2AError ? err.code : "complete_failed";
      this.log({ requestId, eventId, outcome });
    }
  }

  private async keepLease(requestId: string, attemptId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.clock.sleep((LEASE_SECONDS / 3) * 1000, signal);
      if (signal.aborted) return;
      try {
        await this.transport.callTool(
          "p2a_progress",
          { request_id: requestId, attempt_id: attemptId, state: "working" },
          true,
        );
      } catch (err) {
        if (err instanceof AuthError) throw err;
        return;
      }
    }
  }

  private notePollRetry(err: unknown): void {
    const line = `poll_retry ${pollRetryReason(err)}`;
    if (this.logger.warn) {
      this.logger.warn(line);
      return;
    }
    if (this.logger !== silent) {
      this.logger.info(line);
      return;
    }
    process.stderr.write(`${line}\n`);
  }

  private log(fields: {
    requestId?: string;
    eventId?: string;
    outcome?: string;
    durationMs?: number;
  }): void {
    const parts: string[] = [];
    if (fields.requestId) parts.push(`request_id=${fields.requestId}`);
    if (fields.eventId) parts.push(`event_id=${fields.eventId}`);
    if (fields.outcome) parts.push(`outcome=${fields.outcome}`);
    if (fields.durationMs !== undefined) parts.push(`duration_ms=${fields.durationMs}`);
    if (parts.length) this.logger.info(parts.join(" "));
  }
}

function sendResult(payload: Record<string, unknown>): SendResult {
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    requestId: typeof payload.request_id === "string" ? payload.request_id : undefined,
    replyText: typeof payload.reply_text === "string" ? payload.reply_text : undefined,
    summary: typeof payload.summary === "string" ? payload.summary : undefined,
  };
}

function directive(outcome: string, result: Record<string, unknown>): Directive {
  return { [COMPLETE]: true, outcome, result };
}

function isDirective(value: unknown): value is Directive {
  return Boolean(value && typeof value === "object" && COMPLETE in value);
}

function skipClaim(code: string): boolean {
  return code === "request_already_claimed" || code.startsWith("request_not_claimable");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

const TRANSIENT_HTTP = new Set([408, 502, 503, 504]);
const CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT",
]);

function isTransientPollError(err: unknown): boolean {
  if (err instanceof AuthError || isAbort(err)) return false;
  if (err instanceof P2AError) {
    if (err.status === 401 || err.status === 403) return false;
    if (err.status === 429 || err.code === "rate_limited") return true;
    if (err.status !== undefined && TRANSIENT_HTTP.has(err.status)) return true;
    if (err.code === "network") return true;
    return false;
  }
  return isNamedTimeout(err) || isConnectionFailure(err);
}

function pollRetryReason(err: unknown): string {
  if (err instanceof P2AError) {
    if (err.status === 429 || err.code === "rate_limited") return "rate_limited";
    if (err.status !== undefined && TRANSIENT_HTTP.has(err.status)) return `http_${err.status}`;
    if (err.code === "network") return "network";
  }
  if (isNamedTimeout(err)) return "timeout";
  if (isConnectionFailure(err)) return "connection";
  return "connection";
}

function isNamedTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "ConnectTimeoutError" || err.name === "HeadersTimeoutError")
  );
}

function isConnectionFailure(err: unknown): boolean {
  return CONNECTION_CODES.has(causeCode(err)) || CONNECTION_CODES.has(causeCode(nestedCause(err)));
}

function causeCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function nestedCause(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as { cause?: unknown }).cause;
}
