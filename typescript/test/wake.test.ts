import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  WAKE_VERSIONS,
  checkPreview,
  fetchUrlAllowed,
  verifyBody,
  wake,
  type WakeEvent,
} from "../src/index.ts";

const NOW = 1_700_000_000;
const SECRET = "whsec_" + Buffer.from("k".repeat(32)).toString("base64");
const PREVIOUS = "whsec_" + Buffer.from("p".repeat(32)).toString("base64");
const CHALLENGE = "challenge_example_0001";
const HASH_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const HASH_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sign(body: string, id: string, timestamp: string, secret = SECRET): string {
  const raw = Buffer.from(secret.slice("whsec_".length), "base64");
  const mac = createHmac("sha256", raw).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

function requestFor(body: string, id: string, timestamp = String(NOW), secret = SECRET): Request {
  return new Request("https://your-host.example/p2a-wake", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(body, id, timestamp, secret),
    },
  });
}

function wakeBody(fields: Record<string, unknown>): string {
  return JSON.stringify({ wake_version: "0.2", ...fields });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("wake.handler", () => {
  it("exports the 0.2 version list", () => {
    expect(WAKE_VERSIONS).toEqual(["0.2"]);
    expect(wake.WAKE_VERSIONS).toEqual(["0.2"]);
  });

  it("accepts the current key and the previous key", async () => {
    const seen: WakeEvent[] = [];
    const handle = wake.handler({ secret: SECRET, previousSecret: PREVIOUS, onWake: (event) => seen.push(event), now: () => NOW });
    const body = wakeBody({ type: "request", event_id: "evt_current" });
    const current = await handle(requestFor(body, "evt_current"));
    expect(current?.status).toBe(204);
    const previousBody = wakeBody({ type: "request", event_id: "evt_previous" });
    const previous = await handle(requestFor(previousBody, "evt_previous", String(NOW), PREVIOUS));
    expect(previous?.status).toBe(204);
    await settle();
    expect(seen.map((event) => event.event_id)).toEqual(["evt_current", "evt_previous"]);
  });

  it("rejects a bad signature and a stale timestamp", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: () => seen.push("called"), now: () => NOW });
    const body = wakeBody({ type: "request", event_id: "evt_bad" });
    const request = requestFor(body, "evt_bad");
    request.headers.set("webhook-signature", "v1,aaaa");
    expect((await handle(request))?.status).toBe(401);
    const stale = requestFor(body, "evt_stale", String(NOW - 301));
    expect((await handle(stale))?.status).toBe(401);
    await settle();
    expect(seen).toEqual([]);
  });

  it("echoes a 0.2 verification challenge and does not call onWake or onNotice", async () => {
    const seen: string[] = [];
    const handle = wake.handler({
      secret: SECRET,
      onWake: () => seen.push("wake"),
      onNotice: () => seen.push("notice"),
      now: () => NOW,
    });
    const body = wakeBody({ type: "verification", event_id: "evt_verify", binding_id: "bind_1", challenge: CHALLENGE });
    const first = await handle(requestFor(body, "evt_verify"));
    const second = await handle(requestFor(body, "evt_verify"));
    expect(first?.status).toBe(200);
    expect(await first?.json()).toEqual({ challenge: CHALLENGE });
    expect(second?.status).toBe(200);
    expect(await second?.json()).toEqual({ challenge: CHALLENGE });
    expect(seen).toEqual([]);
  });

  it("echoes when the configured binding matches and withholds the echo otherwise", async () => {
    const matched = wake.handler({ secret: SECRET, bindingId: "bind_1", onWake: () => undefined, now: () => NOW });
    const body = wakeBody({ type: "verification", event_id: "evt_bind", binding_id: "bind_1", challenge: CHALLENGE });
    expect(await (await matched(requestFor(body, "evt_bind")))?.json()).toEqual({ challenge: CHALLENGE });

    const wrong = wake.handler({ secret: SECRET, bindingId: "bind_other", onWake: () => undefined, now: () => NOW });
    const refused = await wrong(requestFor(body, "evt_wrong"));
    expect(refused?.status).toBe(204);
    expect(await refused?.text()).toBe("");

    const missing = wakeBody({ type: "verification", event_id: "evt_missing_binding", challenge: CHALLENGE });
    const noBinding = await wrong(requestFor(missing, "evt_missing_binding"));
    expect(noBinding?.status).toBe(204);
    expect(await noBinding?.text()).toBe("");
  });

  it("drops a verification that is not wake_version 0.2 or whose challenge is outside the grammar", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: () => seen.push("called"), now: () => NOW });
    const legacy = JSON.stringify({ type: "verification", challenge: "chal_1" });
    const legacyResponse = await handle(requestFor(legacy, "verify_legacy"));
    expect(legacyResponse?.status).toBe(204);
    expect(await legacyResponse?.text()).toBe("");
    const versioned = JSON.stringify({
      wake_version: "0.1",
      type: "verification",
      event_id: "evt_old_verify",
      binding_id: "bind_1",
      challenge: CHALLENGE,
    });
    expect((await handle(requestFor(versioned, "evt_old_verify")))?.status).toBe(204);
    const short = wakeBody({ type: "verification", event_id: "evt_short", challenge: "chal_1" });
    const shortResponse = await handle(requestFor(short, "evt_short"));
    expect(shortResponse?.status).toBe(204);
    expect(await shortResponse?.text()).toBe("");
    expect(seen).toEqual([]);
  });

  it("does not dedupe a verification against another type with the same event_id", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: (event) => seen.push(event.type), now: () => NOW });
    const verification = wakeBody({ type: "verification", event_id: "evt_shared", binding_id: "bind_1", challenge: CHALLENGE });
    expect((await handle(requestFor(verification, "evt_shared")))?.status).toBe(200);
    const request = wakeBody({ type: "request", event_id: "evt_shared", request_id: "req_shared" });
    expect((await handle(requestFor(request, "evt_shared")))?.status).toBe(204);
    await settle();
    expect(seen).toEqual(["request"]);
  });

  it("routes notices to onNotice and drops them when that callback is omitted", async () => {
    const seen: string[] = [];
    const notices: WakeEvent[] = [];
    const handle = wake.handler({
      secret: SECRET,
      onWake: (event) => seen.push(event.type),
      onNotice: (event) => notices.push(event),
      now: () => NOW,
    });
    const notice = wakeBody({
      type: "notice",
      event_id: "evt_notice",
      binding_id: "bind_1",
      notice_kind: "connection",
      notice_id: "notice_1",
      fetch_with: "p2a_check_new",
    });
    expect((await handle(requestFor(notice, "evt_notice")))?.status).toBe(204);
    const repeat = wakeBody({
      type: "notice",
      event_id: "evt_notice",
      binding_id: "bind_1",
      notice_kind: "connection",
      notice_id: "notice_1",
    });
    expect((await handle(requestFor(repeat, "evt_notice")))?.status).toBe(204);
    const again = wakeBody({
      type: "notice",
      event_id: "evt_notice_2",
      binding_id: "bind_1",
      notice_kind: "something_else",
      notice_id: "notice_1",
    });
    expect((await handle(requestFor(again, "evt_notice_2")))?.status).toBe(204);
    await settle();
    expect(seen).toEqual([]);
    expect(notices.map((event) => event.event_id)).toEqual(["evt_notice", "evt_notice_2"]);
    expect(notices[0]?.notice_kind).toBe("connection");
    expect(notices[1]?.notice_kind).toBe("something_else");

    const dropped: string[] = [];
    const silent = wake.handler({ secret: SECRET, onWake: () => dropped.push("wake"), now: () => NOW });
    const only = wakeBody({ type: "notice", event_id: "evt_drop", binding_id: "bind_1", notice_kind: "connection" });
    expect((await silent(requestFor(only, "evt_drop")))?.status).toBe(204);
    await settle();
    expect(dropped).toEqual([]);
  });

  it("dedupes a notice and a request that share event_id", async () => {
    const seen: string[] = [];
    const handle = wake.handler({
      secret: SECRET,
      onWake: (event) => seen.push(event.type),
      onNotice: (event) => seen.push(event.type),
      now: () => NOW,
    });
    const request = wakeBody({ type: "request", event_id: "evt_once_kind", request_id: "req_1" });
    expect((await handle(requestFor(request, "evt_once_kind")))?.status).toBe(204);
    const notice = wakeBody({ type: "notice", event_id: "evt_once_kind", binding_id: "bind_1", notice_kind: "connection" });
    expect((await handle(requestFor(notice, "evt_once_kind")))?.status).toBe(204);
    await settle();
    expect(seen).toEqual(["request"]);
  });

  it("delivers a test only when deliverTests is set", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: (event) => seen.push(event.type), now: () => NOW });
    const test = wakeBody({ type: "test", event_id: "evt_test" });
    expect((await handle(requestFor(test, "evt_test")))?.status).toBe(204);
    const blocked = wakeBody({ type: "request", event_id: "evt_test", request_id: "req_test" });
    expect((await handle(requestFor(blocked, "evt_test")))?.status).toBe(204);
    await settle();
    expect(seen).toEqual([]);

    const delivered: string[] = [];
    const opted = wake.handler({
      secret: SECRET,
      deliverTests: true,
      onWake: (event) => delivered.push(event.type),
      now: () => NOW,
    });
    expect((await opted(requestFor(wakeBody({ type: "test", event_id: "evt_opt" }), "evt_opt")))?.status).toBe(204);
    await settle();
    expect(delivered).toEqual(["test"]);
  });

  it("dedupes event_id and returns before onWake finishes", async () => {
    let finished = false;
    let calls = 0;
    const handle = wake.handler({
      secret: SECRET,
      now: () => NOW,
      onWake: () =>
        new Promise<void>((resolve) => {
          calls += 1;
          setTimeout(() => {
            finished = true;
            resolve();
          }, 30);
        }),
    });
    const body = wakeBody({ type: "request", event_id: "evt_once" });
    const response = await handle(requestFor(body, "evt_once"));
    expect(response?.status).toBe(204);
    expect(finished).toBe(false);
    expect((await handle(requestFor(body, "evt_once")))?.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    expect(finished).toBe(true);
  });

  it("drops a missing version, 0.1, and any other version", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: (event) => seen.push(event.type), now: () => NOW });
    const missing = JSON.stringify({ type: "request", event_id: "evt_missing" });
    expect((await handle(requestFor(missing, "evt_missing")))?.status).toBe(204);
    const old = JSON.stringify({ wake_version: "0.1", type: "request", event_id: "evt_old" });
    expect((await handle(requestFor(old, "evt_old")))?.status).toBe(204);
    const unknown = JSON.stringify({ wake_version: "9", type: "request", event_id: "evt_unknown" });
    expect((await handle(requestFor(unknown, "evt_unknown")))?.status).toBe(204);
    const request = wakeBody({ type: "request", event_id: "evt_unknown", request_id: "req_1" });
    expect((await handle(requestFor(request, "evt_unknown")))?.status).toBe(204);
    await settle();
    expect(seen).toEqual(["request"]);
  });

  it("still delivers a wake whose fetch host is not the platform host", async () => {
    const seen: WakeEvent[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: (event) => seen.push(event), now: () => NOW });
    const body = wakeBody({
      type: "request",
      event_id: "evt_foreign",
      request_id: "req_foreign",
      fetch: "https://evil.example/wake/v0.2/requests/req_foreign",
    });
    expect((await handle(requestFor(body, "evt_foreign")))?.status).toBe(204);
    await settle();
    expect(seen).toHaveLength(1);
    expect(fetchUrlAllowed(seen[0] ?? {}, "platform.example.com")).toBe(false);
  });

  it("reads a raw Node body and refuses a parsed JSON body", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: (event) => seen.push(String(event.event_id)), now: () => NOW });
    const body = wakeBody({ type: "outcome", event_id: "evt_node" });
    const written: { status?: number; body?: string } = {};
    const res = {
      writeHead(status: number) {
        written.status = status;
      },
      end(payload?: string) {
        written.body = payload;
      },
    };
    await handle(
      {
        headers: {
          "webhook-id": "evt_node",
          "webhook-timestamp": String(NOW),
          "webhook-signature": sign(body, "evt_node", String(NOW)),
        },
        rawBody: Buffer.from(body),
      },
      res,
    );
    expect(written.status).toBe(204);
    const parsed = { status: 0 };
    await handle(
      { headers: { "webhook-id": "evt_parsed", "webhook-timestamp": String(NOW), "webhook-signature": "v1,aa" }, body: { type: "request" } },
      {
        writeHead(status: number) {
          parsed.status = status;
        },
        end() {},
      },
    );
    expect(parsed.status).toBe(401);
    await settle();
    expect(seen).toEqual(["evt_node"]);
  });
});

describe("preview and fetch helpers", () => {
  it("uses a complete preview, fetches a partial one, and ignores a broken one", () => {
    expect(checkPreview({ text: "abc", text_complete: true, text_bytes: 3, text_sha256: HASH_ABC })).toBe("use");
    expect(checkPreview({ text: "abc", text_complete: false, text_bytes: 3, text_sha256: HASH_ABC })).toBe("fetch");
    expect(checkPreview({ text: "abc", text_bytes: 3, text_sha256: HASH_ABC })).toBe("fetch");
    expect(checkPreview({ text: "abc" })).toBe("ignore");
    expect(checkPreview({ text: "abc", text_complete: true })).toBe("ignore");
    expect(checkPreview({ text_complete: true })).toBe("ignore");
    expect(checkPreview({})).toBe("fetch");
    expect(checkPreview(null)).toBe("ignore");
  });

  it("fetches when integrity fields are sent without text, and ignores placeholders", () => {
    const pair = { text_bytes: 3, text_sha256: HASH_ABC };
    expect(checkPreview(pair)).toBe("fetch");
    expect(verifyBody(pair, "abc")).toEqual({ ok: true });
    expect(verifyBody(pair, Buffer.from("abc"))).toEqual({ ok: true });
    expect(checkPreview({ text_sha256: "", text_bytes: 0 })).toBe("ignore");
    expect(checkPreview({ text_sha256: "", text_bytes: 3 })).toBe("ignore");
    expect(verifyBody({ text_sha256: "", text_bytes: 3 }, "abc")).toEqual({ ok: false, reason: "unavailable" });
    expect(checkPreview({ text_bytes: 3 })).toBe("ignore");
    expect(checkPreview({ text_sha256: HASH_ABC })).toBe("ignore");
    expect(checkPreview({ text_sha256: HASH_ABC.toUpperCase(), text_bytes: 3 })).toBe("ignore");
    expect(checkPreview({ text_bytes: 3.5, text_sha256: HASH_ABC })).toBe("ignore");
    expect(checkPreview({ text_bytes: true, text_sha256: HASH_ABC })).toBe("ignore");
    expect(checkPreview({ text: "", text_complete: true, text_bytes: 0, text_sha256: HASH_EMPTY })).toBe("use");
    expect(checkPreview({ text_bytes: 0, text_sha256: HASH_EMPTY })).toBe("fetch");
    expect(verifyBody({ text_bytes: 0, text_sha256: HASH_EMPTY }, "")).toEqual({ ok: true });
  });

  it("reports a typed mismatch for length and digest", () => {
    const full = "abcdef";
    const hashFull = sha256(full);
    const wakeFields = { text: "abc", text_complete: true, text_bytes: full.length, text_sha256: hashFull };
    expect(checkPreview(wakeFields)).toBe("fetch");
    expect(verifyBody(wakeFields, full)).toEqual({ ok: true });
    expect(verifyBody({ text_bytes: 4, text_sha256: HASH_ABC }, "abc")).toEqual({ ok: false, reason: "length" });
    expect(verifyBody({ text_bytes: 3, text_sha256: HASH_ABC }, "xyz")).toEqual({ ok: false, reason: "sha256" });
    expect(verifyBody({ text_bytes: 3, text_sha256: HASH_ABC }, "ab")).toEqual({ ok: false, reason: "both" });
    expect(verifyBody({}, "abc")).toEqual({ ok: false, reason: "unavailable" });
    const accent = "é";
    const accentHash = sha256(accent);
    expect(checkPreview({ text: accent, text_complete: true, text_bytes: 2, text_sha256: accentHash })).toBe("use");
    expect(verifyBody({ text_bytes: 2, text_sha256: accentHash }, accent)).toEqual({ ok: true });
  });

  it("allows an absent fetch and refuses a foreign host", () => {
    const host = "platform.example.com";
    expect(fetchUrlAllowed({}, host)).toBe(true);
    expect(fetchUrlAllowed({ fetch: "https://platform.example.com/wake/v0.2/requests/req_1" }, host)).toBe(true);
    expect(fetchUrlAllowed({ fetch: "https://platform.example.com:443/wake/v0.2/requests/req_1" }, host)).toBe(true);
    expect(fetchUrlAllowed({ fetch: "https://PLATFORM.example.com/x" }, host)).toBe(true);
    expect(fetchUrlAllowed({ fetch: "https://platform.example.com./x" }, "platform.example.com.")).toBe(true);
    expect(fetchUrlAllowed({ fetch: "https://platform.example.com./x" }, host)).toBe(true);
    expect(fetchUrlAllowed({ fetch: "https://platform.example.com/x" }, "https://platform.example.com/wake/v0.2")).toBe(true);
    expect(fetchUrlAllowed({ fetch: "https://evil.example/x" }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: "https://platform.example.com.evil.example/x" }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: "http://platform.example.com/x" }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: "https://platform.example.com:8443/x" }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: "https://user:pw@platform.example.com/x" }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: "not a url" }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: "" }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: null }, host)).toBe(false);
    expect(fetchUrlAllowed({ fetch: "https://127.0.0.1/x" }, host)).toBe(false);
    expect(fetchUrlAllowed(null, host)).toBe(false);
  });
});
