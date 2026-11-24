import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_SECONDS = 300;

export interface WakeEvent {
  wake_version?: string;
  type: string;
  event_id?: string;
  challenge?: string;
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
  store?: WakeStore;
  now?: () => number;
}

interface WakeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  event: WakeEvent | null;
}

type HeaderMap = Record<string, string | string[] | undefined>;

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

function schedule(onWake: WakeHandlerOptions["onWake"], event: WakeEvent): void {
  const run = () => {
    try {
      const result = onWake(event);
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

async function decide(body: Buffer, headers: HeaderMap, options: WakeHandlerOptions, store: WakeStore): Promise<WakeResult> {
  const id = headerValue(headers, "webhook-id");
  const timestamp = headerValue(headers, "webhook-timestamp");
  const signature = headerValue(headers, "webhook-signature");
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  const stamp = Number(timestamp);
  const fresh = timestamp !== "" && Number.isInteger(stamp) && Math.abs(now - stamp) <= WINDOW_SECONDS;
  const secrets = [options.secret, options.previousSecret].filter((item): item is string => Boolean(item));
  if (!id || !fresh || !signatureOk(body, id, timestamp, signature, secrets)) {
    return { status: 401, headers: {}, body: "", event: null };
  }
  let parsed: WakeEvent;
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: 400, headers: {}, body: "", event: null };
    }
    parsed = value as WakeEvent;
  } catch {
    return { status: 400, headers: {}, body: "", event: null };
  }
  if (parsed.type === "verification") {
    const challenge = typeof parsed.challenge === "string" ? parsed.challenge : "";
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
      event: null,
    };
  }
  if (parsed.wake_version !== undefined && parsed.wake_version !== "0.1") {
    return { status: 204, headers: {}, body: "", event: null };
  }
  const eventId = typeof parsed.event_id === "string" && parsed.event_id ? parsed.event_id : id;
  const isNew = await store.checkAndAdd(eventId);
  const deliver = isNew && (parsed.type === "request" || parsed.type === "reply" || parsed.type === "outcome");
  return { status: 204, headers: {}, body: "", event: deliver ? { ...parsed, event_id: eventId } : null };
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
    if (result.event) schedule(options.onWake, result.event);
    return result;
  }

  return async function wakeHandler(req: unknown, res?: unknown): Promise<Response | void> {
    if (res !== undefined && isNodeResponse(res)) {
      const nodeReq = req as { headers?: HeaderMap; rawBody?: unknown; body?: unknown };
      const body = await readNodeBody(nodeReq);
      const result = body
        ? await finish(body, nodeReq.headers ?? {})
        : { status: 401, headers: {}, body: "", event: null };
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

export const wake = { handler };
