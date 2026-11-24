import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { wake, type WakeEvent } from "../src/index.ts";

const NOW = 1_700_000_000;
const SECRET = "whsec_" + Buffer.from("k".repeat(32)).toString("base64");
const PREVIOUS = "whsec_" + Buffer.from("p".repeat(32)).toString("base64");

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

describe("wake.handler", () => {
  it("accepts the current key and the previous key", async () => {
    const seen: WakeEvent[] = [];
    const handle = wake.handler({ secret: SECRET, previousSecret: PREVIOUS, onWake: (event) => seen.push(event), now: () => NOW });
    const body = JSON.stringify({ wake_version: "0.1", type: "request", event_id: "evt_current" });
    const current = await handle(requestFor(body, "evt_current"));
    expect(current?.status).toBe(204);
    const previousBody = JSON.stringify({ wake_version: "0.1", type: "request", event_id: "evt_previous" });
    const previous = await handle(requestFor(previousBody, "evt_previous", String(NOW), PREVIOUS));
    expect(previous?.status).toBe(204);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.map((event) => event.event_id)).toEqual(["evt_current", "evt_previous"]);
  });

  it("rejects a bad signature and a stale timestamp", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: () => seen.push("called"), now: () => NOW });
    const body = JSON.stringify({ wake_version: "0.1", type: "request", event_id: "evt_bad" });
    const request = requestFor(body, "evt_bad");
    request.headers.set("webhook-signature", "v1,aaaa");
    expect((await handle(request))?.status).toBe(401);
    const stale = requestFor(body, "evt_stale", String(NOW - 301));
    expect((await handle(stale))?.status).toBe(401);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([]);
  });

  it("echoes a verification challenge and does not call onWake", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: () => seen.push("called"), now: () => NOW });
    const body = JSON.stringify({ type: "verification", challenge: "chal_1" });
    const first = await handle(requestFor(body, "verify_chal_1"));
    const second = await handle(requestFor(body, "verify_chal_1"));
    expect(first?.status).toBe(200);
    expect(await first?.json()).toEqual({ challenge: "chal_1" });
    expect(second?.status).toBe(200);
    expect(seen).toEqual([]);
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
    const body = JSON.stringify({ wake_version: "0.1", type: "request", event_id: "evt_once" });
    const response = await handle(requestFor(body, "evt_once"));
    expect(response?.status).toBe(204);
    expect(finished).toBe(false);
    expect((await handle(requestFor(body, "evt_once")))?.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    expect(finished).toBe(true);
  });

  it("ignores an unknown wake_version and does not claim a test", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: (event) => seen.push(event.type), now: () => NOW });
    const unknown = JSON.stringify({ wake_version: "9", type: "request", event_id: "evt_unknown" });
    expect((await handle(requestFor(unknown, "evt_unknown")))?.status).toBe(204);
    const test = JSON.stringify({ wake_version: "0.1", type: "test", event_id: "evt_test" });
    expect((await handle(requestFor(test, "evt_test")))?.status).toBe(204);
    const request = JSON.stringify({ wake_version: "0.1", type: "request", event_id: "evt_unknown" });
    expect((await handle(requestFor(request, "evt_unknown")))?.status).toBe(204);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["request"]);
  });

  it("reads a raw Node body and refuses a parsed JSON body", async () => {
    const seen: string[] = [];
    const handle = wake.handler({ secret: SECRET, onWake: (event) => seen.push(String(event.event_id)), now: () => NOW });
    const body = JSON.stringify({ wake_version: "0.1", type: "outcome", event_id: "evt_node" });
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
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["evt_node"]);
  });
});
