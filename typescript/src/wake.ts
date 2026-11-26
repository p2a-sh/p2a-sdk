import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_SECONDS = 300;

/** Versions a 0.2 receiver accepts. Pass this list as `wake_versions` at registration. */
export const WAKE_VERSIONS = ["0.2"] as const;

const ACCEPTED_WAKE_VERSION: (typeof WAKE_VERSIONS)[number] = "0.2";

export type PreviewDecision = "use" | "fetch" | "ignore";

export type IntegrityReason = "length" | "sha256" | "both" | "unavailable";

export type IntegrityResult = { ok: true } | { ok: false; reason: IntegrityReason };

export interface WakeEvent {
  wake_version?: string;
  type: string;
  event_id?: string;
  request_id?: string;
  binding_id?: string;
  notice_kind?: string;
  notice_id?: string;
  fetch?: string;
  fetch_with?: string;
  text?: string;
  text_complete?: boolean;
  text_bytes?: number;
  text_sha256?: string;
  challenge?: string;
  same_owner?: boolean;
  [key: string]: unknown;
}

export interface WakeStore {
  checkAndAdd(eventId: string): boolean | Promise<boolean>;
}

export class MemoryWakeStore implements WakeStore {
  private readonly seen = new Set<string>();

  checkAndAdd(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}

export interface WakeHandlerOptions {
  secret: string;
  previousSecret?: string;
  onWake: (event: WakeEvent) => void | Promise<void>;
  /** Notices are delivered here. When omitted, a notice is answered 2xx and dropped. */
  onNotice?: (event: WakeEvent) => void | Promise<void>;
  /** When set, a verification echo requires `binding_id` to equal this value. */
  bindingId?: string;
  /** `type: "test"` is delivered to `onWake` only when this is true. Default false. */
  deliverTests?: boolean;
  store?: WakeStore;
  now?: () => number;
}

interface WakeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  event: WakeEvent | null;
  deliver: "wake" | "notice" | null;
}

type HeaderMap = Record<string, string | string[] | undefined>;
type WakeRecord = Record<string, unknown>;

function headerValue(headers: HeaderMap, name: string): string {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0] ?? "";
  if (typeof direct === "string") return direct;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  if (!found) return "";
  const value = found[1];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function keyBytes(secret: string): Buffer | null {
  if (!secret.startsWith("whsec_")) return null;
  try {
    const raw = Buffer.from(secret.slice("whsec_".length), "base64");
    if (raw.length < 24 || raw.length > 64) return null;
    return raw;
  } catch {
    return null;
  }
}

function signatureOk(body: Buffer, id: string, timestamp: string, signatureHeader: string, secrets: string[]): boolean {
  const signed = Buffer.concat([
    Buffer.from(id, "utf8"),
    Buffer.from(".", "utf8"),
    Buffer.from(timestamp, "utf8"),
    Buffer.from(".", "utf8"),
    body,
  ]);
  const keys = secrets.map(keyBytes).filter((item): item is Buffer => item !== null);
  let ok = false;
  for (const part of signatureHeader.split(/\s+/)) {
    if (!part.startsWith("v1,")) continue;
    const given = Buffer.from(part.slice(3), "base64");
    for (const key of keys) {
      const expected = createHmac("sha256", key).update(signed).digest();
      if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
    }
  }
  return ok;
}

function schedule(onEvent: (event: WakeEvent) => void | Promise<void>, event: WakeEvent): void {
  const run = () => {
    try {
      const result = onEvent(event);
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // The event and the secret stay out of logs.
    }
  };
  if (typeof setImmediate === "function") setImmediate(run);
  else setTimeout(run, 0);
}

function asRecord(value: unknown): WakeRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as WakeRecord;
}

function validBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

function validChallenge(value: string): boolean {
  if (value.length < 16 || value.length > 128) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (!digit && !upper && !lower && value[i] !== "." && value[i] !== "_" && value[i] !== "-") return false;
  }
  return true;
}

function integrityPair(wake: WakeRecord): { bytes: number; sha256: string } | null {
  if (!validBytes(wake.text_bytes) || !validSha256(wake.text_sha256)) return null;
  return { bytes: wake.text_bytes, sha256: wake.text_sha256 };
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function bodyBytes(body: string | Uint8Array): Buffer | null {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

function previewFieldPresent(wake: WakeRecord): boolean {
  return ["text", "text_complete", "text_bytes", "text_sha256"].some((key) => wake[key] !== undefined);
}

/**
 * Decide what a receiver may do with preview and integrity fields.
 *
 * "use" means `text` is the full body: `text_complete` is true and both integrity fields match those bytes.
 * "fetch" means the body has to be fetched. A valid `text_bytes` + `text_sha256` pair, including a pair
 * sent without `text`, can be checked with `verifyBody` afterwards.
 * "ignore" means the preview fields that are present are not a usable pair. Fetch before using a body,
 * and do not treat those fields as integrity.
 */
export function checkPreview(wake: unknown): PreviewDecision {
  const record = asRecord(wake);
  if (!record) return "ignore";
  const pair = integrityPair(record);
  if (typeof record.text === "string") {
    if (!pair) return "ignore";
    const preview = Buffer.from(record.text, "utf8");
    if (record.text_complete === true && preview.length === pair.bytes && sha256Hex(preview) === pair.sha256) {
      return "use";
    }
    return "fetch";
  }
  if (pair) return "fetch";
  if (previewFieldPresent(record)) return "ignore";
  return "fetch";
}

/** Compare `body` to `text_bytes` and `text_sha256` when both are valid. A mismatch is a result, not an exception. */
export function verifyBody(wake: unknown, body: string | Uint8Array): IntegrityResult {
  const record = asRecord(wake);
  const pair = record ? integrityPair(record) : null;
  const raw = bodyBytes(body);
  if (!pair || !raw) return { ok: false, reason: "unavailable" };
  const lengthOk = raw.length === pair.bytes;
  const digestOk = sha256Hex(raw) === pair.sha256;
  if (lengthOk && digestOk) return { ok: true };
  if (!lengthOk && !digestOk) return { ok: false, reason: "both" };
  if (!lengthOk) return { ok: false, reason: "length" };
  return { ok: false, reason: "sha256" };
}

function hostnameOf(value: string): string | null {
  try {
    const withScheme = value.includes("://") ? value : `https://${value}`;
    let host = new URL(withScheme).hostname.toLowerCase();
    while (host.endsWith(".")) host = host.slice(0, -1);
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Host check for a wake `fetch` URL. An absent `fetch` is allowed: the runtime uses the authenticated
 * channel it already has. A present URL must be HTTPS on port 443 and its host must be `platformHost`.
 * This does not check the path.
 */
export function fetchUrlAllowed(wake: unknown, platformHost: string): boolean {
  const record = asRecord(wake);
  if (!record) return false;
  if (record.fetch === undefined) return true;
  if (typeof platformHost !== "string" || platformHost === "") return false;
  if (typeof record.fetch !== "string" || record.fetch === "") return false;
  let url: URL;
  try {
    url = new URL(record.fetch);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  const expected = hostnameOf(platformHost);
  const actual = hostnameOf(url.origin);
  if (!expected || !actual) return false;
  return actual === expected;
}

function echoChallenge(parsed: WakeEvent, bindingId: string | undefined): string | null {
  const challenge = parsed.challenge;
  if (typeof challenge !== "string" || !validChallenge(challenge)) return null;
  if (typeof bindingId === "string" && bindingId !== "" && parsed.binding_id !== bindingId) return null;
  return challenge;
}

function deliveryFor(parsed: WakeEvent, options: WakeHandlerOptions): "wake" | "notice" | null {
  if (parsed.type === "notice") return options.onNotice ? "notice" : null;
  if (parsed.type === "test") return options.deliverTests ? "wake" : null;
  if (parsed.type === "request" || parsed.type === "reply" || parsed.type === "outcome") return "wake";
  return null;
}

async function decide(body: Buffer, headers: HeaderMap, options: WakeHandlerOptions, store: WakeStore): Promise<WakeResult> {
  const id = headerValue(headers, "webhook-id");
  const timestamp = headerValue(headers, "webhook-timestamp");
  const signature = headerValue(headers, "webhook-signature");
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  const stamp = Number(timestamp);
  const fresh = timestamp !== "" && Number.isInteger(stamp) && Math.abs(now - stamp) <= WINDOW_SECONDS;
  const secrets = [options.secret, options.previousSecret].filter((item): item is string => Boolean(item));
  if (!id || !fresh || !signatureOk(body, id, timestamp, signature, secrets)) {
    return { status: 401, headers: {}, body: "", event: null, deliver: null };
  }
  let parsed: WakeEvent;
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: 400, headers: {}, body: "", event: null, deliver: null };
    }
    parsed = value as WakeEvent;
  } catch {
    return { status: 400, headers: {}, body: "", event: null, deliver: null };
  }
  // 0.2 only. Missing, "0.1", and every other version are 2xx and are not delivered.
  // That includes a verification body that omits wake_version.
  if (parsed.wake_version !== ACCEPTED_WAKE_VERSION) {
    return { status: 204, headers: {}, body: "", event: null, deliver: null };
  }
  if (parsed.type === "verification") {
    const challenge = echoChallenge(parsed, options.bindingId);
    if (!challenge) return { status: 204, headers: {}, body: "", event: null, deliver: null };
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
      event: null,
      deliver: null,
    };
  }
  const eventId = typeof parsed.event_id === "string" && parsed.event_id ? parsed.event_id : id;
  const isNew = await store.checkAndAdd(eventId);
  if (!isNew) return { status: 204, headers: {}, body: "", event: null, deliver: null };
  const deliver = deliveryFor(parsed, options);
  if (!deliver) return { status: 204, headers: {}, body: "", event: null, deliver: null };
  return { status: 204, headers: {}, body: "", event: { ...parsed, event_id: eventId }, deliver };
}

function isFetchRequest(value: unknown): value is Request {
  return typeof Request !== "undefined" && value instanceof Request;
}

function isNodeResponse(value: unknown): value is { writeHead: (status: number, headers: Record<string, string>) => void; end: (body?: string) => void } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { writeHead?: unknown; end?: unknown };
  return typeof candidate.writeHead === "function" && typeof candidate.end === "function";
}

async function readNodeBody(req: { rawBody?: unknown; body?: unknown }): Promise<Buffer | null> {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  if (req.body && typeof req.body === "object") return null;
  const stream = req as AsyncIterable<Buffer | string>;
  if (typeof stream[Symbol.asyncIterator] !== "function") return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function handler(options: WakeHandlerOptions) {
  const store = options.store ?? new MemoryWakeStore();

  async function finish(body: Buffer, headers: HeaderMap): Promise<WakeResult> {
    const result = await decide(body, headers, options, store);
    if (result.event && result.deliver === "notice" && options.onNotice) schedule(options.onNotice, result.event);
    if (result.event && result.deliver === "wake") schedule(options.onWake, result.event);
    return result;
  }

  return async function wakeHandler(req: unknown, res?: unknown): Promise<Response | void> {
    if (res !== undefined && isNodeResponse(res)) {
      const nodeReq = req as { headers?: HeaderMap; rawBody?: unknown; body?: unknown };
      const body = await readNodeBody(nodeReq);
      const result = body
        ? await finish(body, nodeReq.headers ?? {})
        : { status: 401, headers: {}, body: "", event: null, deliver: null };
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    if (!isFetchRequest(req)) {
      throw new TypeError("wake handler expects a Request or (req, res)");
    }
    const headers: HeaderMap = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const result = await finish(Buffer.from(await req.arrayBuffer()), headers);
    return new Response(result.body || null, { status: result.status, headers: result.headers });
  };
}

export const wake = { handler, WAKE_VERSIONS, checkPreview, verifyBody, fetchUrlAllowed };
