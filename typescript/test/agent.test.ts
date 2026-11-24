import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../src/clock.ts";
import {
  AuthError,
  ConfirmationRequired,
  P2AAgent,
  P2AError,
  RateLimited,
  SseParser,
} from "../src/index.ts";

interface Rpc {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) {
    const close = closers.pop();
    if (close) await close();
  }
});

function testClock(requested: number[]): Clock {
  return {
    now: () => 0,
    random: () => 0,
    async sleep(ms: number, signal?: AbortSignal) {
      requested.push(ms);
      if (ms === 100_000) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return;
      }
      if (signal?.aborted || ms <= 0) return;
      if (ms >= 25_000) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

async function fake(handle: (rpc: Rpc, req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const calls: Rpc[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc;
    calls.push(rpc);
    await handle(rpc, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  closers.push(close);
  return { calls, url: `http://127.0.0.1:${address.port}/mcp`, close };
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
  res.end(JSON.stringify(body));
}

function tool(id: number, payload: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  };
}

function rpcResult(id: number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function toolName(rpc: Rpc): string {
  return typeof rpc.params?.name === "string" ? rpc.params.name : "";
}

function argsOf(rpc: Rpc): Record<string, unknown> {
  const args = rpc.params?.arguments;
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function created(data: Record<string, unknown>) {
  return {
    eventId: "evt-1",
    name: "aweb.request.created",
    data,
  };
}

function emptyInbox() {
  return { pending_requests: [], unread_replies: [], connection_requests: [] };
}

function claimPayload(text = "please refund ada@example.com now") {
  return {
    request_id: "req-1",
    sender_did: "did:aw:sender",
    conversation_id: "ctx-1",
    same_owner: false,
    untrusted_input: { text },
  };
}

describe("sse", () => {
  it("parses a split frame and keeps the cursor", () => {
    const parser = new SseParser();
    const raw =
      'data: {"jsonrpc":"2.0","method":"notifications/events/event","params":{"cursor":"c1","eventId":"e1"}}\n\n';
    expect(parser.push(raw.slice(0, 12))).toEqual([]);
    const messages = parser.push(raw.slice(12));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].data).params.cursor).toBe("c1");
  });
});

describe("agent", () => {
  it("redacts tokens in error text", () => {
    const err = new P2AError("bad", { message: "saw ibi_ABCDEFG123 in the body" });
    expect(err.toString()).not.toContain("ibi_ABCDEFG123");
    expect(String(err)).toContain("ibi_[redacted]");
  });

  it("maps 401 to AuthError and does not retry", async () => {
    let initializes = 0;
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") initializes += 1;
      json(res, { error: "unauthorized" }, 401);
    });
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    await expect(agent.listen({ mode: "poll" })).rejects.toBeInstanceOf(AuthError);
    expect(initializes).toBe(1);
  });

  it("retries a transient poll failure and resets the backoff after success", async () => {
    const sleeps: number[] = [];
    const warnings: string[] = [];
    const stop = new AbortController();
    let failures = 0;
    let round = 0;
    const seen = new Set<string>();
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
        if (round === 0 && failures < 3) {
          failures += 1;
          return json(res, { error: "bad gateway" }, 502);
        }
        if (round === 0) {
          seen.add(name);
          if (seen.size === 4) {
            round = 1;
            failures = 0;
            seen.clear();
          }
          return json(res, rpcResult(rpc.id, { events: [], cursor: "c1", nextPollMs: 0, hasMore: false }));
        }
        if (failures < 3) {
          failures += 1;
          return json(res, { error: "bad gateway" }, 502);
        }
        stop.abort();
        return json(res, rpcResult(rpc.id, { events: [], cursor: "c1", nextPollMs: 0, hasMore: false }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      return json(res, tool(rpc.id, {}));
    });
    const agent = new P2AAgent({
      token: "ibi_ABCDEFG123",
      url: server.url,
      clock: testClock(sleeps),
      logger: {
        info() {},
        warn(line) {
          warnings.push(line);
        },
      },
    });
    await agent.listen({ mode: "poll", signal: stop.signal });
    expect(warnings).toEqual(["poll_retry http_502", "poll_retry http_502"]);
    expect(sleeps).toEqual([500, 1_000, 500, 0, 500, 1_000, 500]);
    const logged = warnings.join("\n");
    expect(logged).not.toContain("ibi_ABCDEFG123");
    expect(logged).not.toContain(server.url);
    expect(logged).not.toContain("Bearer");
  });

  it("does not retry an auth failure from the poll loop", async () => {
    let polls = 0;
    const warnings: string[] = [];
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        polls += 1;
        return json(res, { error: "forbidden" }, 403);
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      return json(res, tool(rpc.id, {}));
    });
    const agent = new P2AAgent({
      token: "ibi_ABCDEFG123",
      url: server.url,
      clock: testClock([]),
      logger: {
        info() {},
        warn(line) {
          warnings.push(line);
        },
      },
    });
    await expect(agent.listen({ mode: "poll" })).rejects.toMatchObject({ status: 403 });
    expect(polls).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("completes a string handler and never logs the token, text, or email", async () => {
    const lines: string[] = [];
    const sleeps: number[] = [];
    const stop = new AbortController();
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, { protocolVersion: "2025-11-25" }));
      if (rpc.method === "events/poll") {
        const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.request.created").length === 1;
        const events = first
          ? [created({ request_id: "req-1", text: "please refund ada@example.com now", sender: "pat@acme", same_owner: false })]
          : [];
        return json(res, rpcResult(rpc.id, { events, cursor: "c1", nextPollMs: 60_000, hasMore: false }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "claim_request") return json(res, tool(rpc.id, claimPayload()));
      if (toolName(rpc) === "p2a_progress") return json(res, tool(rpc.id, { ok: true }));
      if (toolName(rpc) === "complete_request") {
        json(res, tool(rpc.id, { ok: true }));
        return;
      }
      json(res, tool(rpc.id, {}));
    });
    const agent = new P2AAgent({
      token: "ibi_ABCDEFG123",
      url: server.url,
      clock: testClock(sleeps),
      logger: { info: (line) => lines.push(line) },
    });
    let seen = "";
    agent.onRequest(async (req) => {
      seen = req.text;
      expect(req.sameOwner).toBe(false);
      expect(req.sender.did).toBe("did:aw:sender");
      expect(req.sender.address).toBe("pat@acme");
      expect(req.contextId).toBe("ctx-1");
      return "plain text";
    });
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => server.calls.some((call) => toolName(call) === "complete_request"));
    stop.abort();
    await listening;
    const complete = server.calls.find((call) => toolName(call) === "complete_request");
    expect(argsOf(complete!).result).toEqual({ text: "plain text" });
    expect(argsOf(complete!).outcome).toBe("completed");
    expect(seen).toContain("ada@example.com");
    const logged = lines.join("\n");
    expect(logged).not.toContain("ibi_");
    expect(logged).not.toContain("ada@example.com");
    expect(logged).not.toContain("please refund");
    expect(server.calls.filter((call) => toolName(call) === "p2a_check_new")).toHaveLength(1);
    expect(server.calls.some((call) => toolName(call) === "renew_request_lease")).toBe(false);
  });

  it("escalates to needs_approval and asks the customer with input_required", async () => {
    const outcomes: string[] = [];
    const server = await fake(async (rpc, _req, res) => answer(server, rpc, res, outcomes));
    const stop = new AbortController();
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onRequest(async (_req, ctx) => ctx.escalate("Refund over $500?"));
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => outcomes.length === 1);
    stop.abort();
    await listening;
    expect(outcomes[0]).toBe("needs_approval");
    const first = server.calls.find((call) => toolName(call) === "complete_request");
    expect(argsOf(first!).result).toEqual({
      text: "Refund over $500?",
      customer_text: "A person from Acme will follow up here.",
    });

    const stop2 = new AbortController();
    const server2 = await fake(async (rpc, _req, res) => answer(server2, rpc, res, outcomes));
    const agent2 = new P2AAgent({ token: "ibi_ABCDEFG123", url: server2.url, clock: testClock([]) });
    agent2.onRequest(async (_req, ctx) => ctx.askCustomer("Which order?"));
    const listening2 = agent2.listen({ mode: "poll", signal: stop2.signal });
    await until(() => outcomes.length === 2);
    stop2.abort();
    await listening2;
    const second = server2.calls.find((call) => toolName(call) === "complete_request");
    expect(argsOf(second!).outcome).toBe("input_required");
    expect(argsOf(second!).result).toEqual({ text: "Which order?" });
  });

  it("turns a thrown handler into a generic failure", async () => {
    const server = await fake(async (rpc, _req, res) => answer(server, rpc, res, []));
    const stop = new AbortController();
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onRequest(async () => {
      throw new Error("stack ada@example.com ibi_ABCDEFG123");
    });
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => server.calls.some((call) => toolName(call) === "complete_request"));
    stop.abort();
    await listening;
    const complete = server.calls.find((call) => toolName(call) === "complete_request");
    const result = argsOf(complete!).result as Record<string, unknown>;
    expect(argsOf(complete!).outcome).toBe("failed");
    expect(result.text).toBe("Sorry, something went wrong.");
    expect(JSON.stringify(result)).not.toContain("ada@example.com");
    expect(JSON.stringify(result)).not.toContain("ibi_");
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("retries rate limits for complete and not for send", async () => {
    let completes = 0;
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.request.created").length === 1;
        return json(res, rpcResult(rpc.id, {
          events: first ? [created({ request_id: "req-1", kind: "request", text: "hi" })] : [],
          cursor: "c",
          nextPollMs: 60_000,
        }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "claim_request") return json(res, tool(rpc.id, claimPayload("hi")));
      if (toolName(rpc) === "p2a_progress") return json(res, tool(rpc.id, { ok: true }));
      if (toolName(rpc) === "complete_request") {
        completes += 1;
        if (completes === 1) return json(res, tool(rpc.id, { error: "rate_limited", retry_after: 0 }));
        return json(res, tool(rpc.id, { ok: true }));
      }
      json(res, tool(rpc.id, {}));
    });
    const stop = new AbortController();
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onRequest(async () => "ok");
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => completes === 2);
    stop.abort();
    await listening;
    expect(completes).toBe(2);

    let sends = 0;
    const sender = await fake(async (rpc, _req, res) => {
      if (toolName(rpc) === "p2a_send_message") {
        sends += 1;
        return json(res, tool(rpc.id, { error: "rate_limited", retry_after: 1 }));
      }
      json(res, tool(rpc.id, {}));
    });
    const sending = new P2AAgent({ token: "ibi_ABCDEFG123", url: sender.url, clock: testClock([]) });
    await expect(sending.send("pat@acme", "hello")).rejects.toBeInstanceOf(RateLimited);
    expect(sends).toBe(1);
  });

  it("retries a failed complete with the same arguments", async () => {
    const seen: Array<Record<string, unknown>> = [];
    let completes = 0;
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.request.created").length === 1;
        return json(res, rpcResult(rpc.id, {
          events: first ? [created({ request_id: "req-1", text: "hi" })] : [],
          nextPollMs: 60_000,
        }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "claim_request") return json(res, tool(rpc.id, claimPayload("hi")));
      if (toolName(rpc) === "p2a_progress") return json(res, tool(rpc.id, { ok: true }));
      if (toolName(rpc) === "complete_request") {
        completes += 1;
        seen.push(argsOf(rpc));
        if (completes < 3) return json(res, { error: "down" }, 500);
        return json(res, tool(rpc.id, { ok: true }));
      }
      json(res, tool(rpc.id, {}));
    });
    const stop = new AbortController();
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onRequest(async () => "same");
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => completes === 3);
    stop.abort();
    await listening;
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1]).toEqual(seen[2]);
    expect(seen[0].result).toEqual({ text: "same" });
  });

  it("keeps the lease with p2a_progress and never renew_request_lease", async () => {
    let progress = 0;
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.request.created").length === 1;
        return json(res, rpcResult(rpc.id, {
          events: first ? [created({ request_id: "req-1", text: "hi" })] : [],
          nextPollMs: 60_000,
        }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "claim_request") return json(res, tool(rpc.id, claimPayload("hi")));
      if (toolName(rpc) === "p2a_progress") {
        progress += 1;
        return json(res, tool(rpc.id, { ok: true }));
      }
      if (toolName(rpc) === "complete_request") return json(res, tool(rpc.id, { ok: true }));
      json(res, tool(rpc.id, {}));
    });
    const stop = new AbortController();
    const sleeps: number[] = [];
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock(sleeps) });
    agent.onRequest(async () => {
      await until(() => progress >= 1);
      return "ok";
    });
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => server.calls.some((call) => toolName(call) === "complete_request"));
    stop.abort();
    await listening;
    expect(progress).toBeGreaterThan(0);
    expect(server.calls.some((call) => toolName(call) === "renew_request_lease")).toBe(false);
    expect(sleeps).toContain(100_000);
    const progressCall = server.calls.find((call) => toolName(call) === "p2a_progress");
    expect(argsOf(progressCall!).state).toBe("working");
  });

  it("does not claim a kind message, an outcome, or an unknown kind", async () => {
    const messages: string[] = [];
    const outcomes: string[] = [];
    let step = 0;
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        if (toolName(rpc) !== "aweb.request.created") {
          return json(res, rpcResult(rpc.id, { events: [], nextPollMs: 60_000 }));
        }
        step += 1;
        const data =
          step === 1
            ? { request_id: "mail-1", kind: "message", text: "stored note", reply_required: false }
            : step === 2
              ? { request_id: "out-1", kind: "outcome", parent_request_id: "plan-1" }
              : { request_id: "odd-1", kind: "future" };
        const events = step <= 3 ? [created(data)] : [];
        return json(res, rpcResult(rpc.id, { events, nextPollMs: step <= 3 ? 0 : 60_000 }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "claim_request") return json(res, tool(rpc.id, claimPayload("nope")));
      json(res, tool(rpc.id, {}));
    });
    const stop = new AbortController();
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onMessage((msg) => {
      messages.push(msg.requestId ?? "");
    });
    agent.onOutcome((evt) => {
      outcomes.push(evt.requestId ?? "");
    });
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => messages.length === 1 && outcomes.length === 1 && step >= 3);
    stop.abort();
    await listening;
    expect(messages).toEqual(["mail-1"]);
    expect(outcomes).toEqual(["out-1"]);
    expect(server.calls.some((call) => toolName(call) === "claim_request")).toBe(false);
    expect(server.calls.some((call) => toolName(call) === "complete_request")).toBe(false);
  });

  it("resumes a stream from the last cursor and falls back to poll after three failures", async () => {
    let streams = 0;
    const server = await fake(async (rpc, req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/stream") {
        streams += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (streams === 1) {
          res.end(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/events/event",
              params: {
                cursor: "c1",
                eventId: "e1",
                name: "aweb.request.created",
                data: { request_id: "req-1", kind: "message", text: "notice" },
              },
            })}\n\n`,
          );
          return;
        }
        expect(rpc.params?.cursor).toBe("c1");
        req.on("close", () => res.end());
        return;
      }
      if (rpc.method === "events/poll") return json(res, rpcResult(rpc.id, { events: [], nextPollMs: 60_000 }));
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      json(res, tool(rpc.id, {}));
    });
    const stop = new AbortController();
    const seen: string[] = [];
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onMessage((msg) => seen.push(msg.eventId ?? ""));
    const listening = agent.listen({ signal: stop.signal });
    await until(() => streams >= 2 && seen.includes("e1"));
    stop.abort();
    await listening;
    expect(server.calls.filter((call) => call.method === "events/stream")[1].params?.cursor).toBe("c1");

    let failedStreams = 0;
    let polls = 0;
    const fallback = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/stream") {
        failedStreams += 1;
        return json(res, { error: "down" }, 500);
      }
      if (rpc.method === "events/poll") {
        if (toolName(rpc) === "aweb.request.created") polls += 1;
        return json(res, rpcResult(rpc.id, { events: [], nextPollMs: 60_000 }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      json(res, tool(rpc.id, {}));
    });
    const stop2 = new AbortController();
    const agent2 = new P2AAgent({ token: "ibi_ABCDEFG123", url: fallback.url, clock: testClock([]) });
    const listening2 = agent2.listen({ signal: stop2.signal });
    await until(() => polls >= 1);
    stop2.abort();
    await listening2;
    expect(failedStreams).toBe(3);
  });

  it("calls onConnectionRequest and accepts with confirm true", async () => {
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.connection.requested").length === 1;
        const events = first
          ? [{ eventId: "evt-c", name: "aweb.connection.requested", data: { link_id: "link-1", from: "pat@acme", owner: "acme", text: "p2a connection request" } }]
          : [];
        return json(res, rpcResult(rpc.id, { events, nextPollMs: 60_000 }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "p2a_respond_connection") {
        return json(res, tool(rpc.id, { state: "connected", link_id: "link-1" }));
      }
      json(res, tool(rpc.id, {}));
    });
    const stop = new AbortController();
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onConnectionRequest(async (req) => {
      expect(req.linkId).toBe("link-1");
      await agent.respondConnection(req.linkId, "accept");
    });
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => server.calls.some((call) => toolName(call) === "p2a_respond_connection"));
    stop.abort();
    await listening;
    const respond = server.calls.find((call) => toolName(call) === "p2a_respond_connection");
    expect(argsOf(respond!)).toEqual({ link_id: "link-1", action: "accept", confirm: true });
    expect(server.calls.some((call) => toolName(call) === "claim_request")).toBe(false);
  });

  it("waits for a reply once and resolves the sender and brief from the claim", async () => {
    let waits = 0;
    const waiting = await fake(async (rpc, _req, res) => {
      if (toolName(rpc) === "p2a_wait_for_reply") {
        waits += 1;
        return json(res, tool(rpc.id, { error: "rate_limited", retry_after: 1 }));
      }
      json(res, tool(rpc.id, {}));
    });
    const waiter = new P2AAgent({ token: "ibi_ABCDEFG123", url: waiting.url, clock: testClock([]) });
    await expect(waiter.waitForReply("req-9", { timeout: 5 })).rejects.toBeInstanceOf(RateLimited);
    expect(waits).toBe(1);
    expect(argsOf(waiting.calls[0])).toEqual({ request_id: "req-9", wait_seconds: 5 });

    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.request.created").length === 1;
        return json(res, rpcResult(rpc.id, {
          events: first ? [created({ request_id: "req-1", text: "hi", sender: "pat@acme" })] : [],
          nextPollMs: 60_000,
        }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "claim_request") return json(res, tool(rpc.id, claimPayload("hi")));
      if (toolName(rpc) === "p2a_progress") return json(res, tool(rpc.id, { ok: true }));
      if (toolName(rpc) === "p2a_brief_get") return json(res, tool(rpc.id, { version: 1, body: "pair brief" }));
      if (toolName(rpc) === "p2a_resolve_agent") {
        return json(res, tool(rpc.id, { did_aw: "did:aw:sender", address: "pat@acme", display_name: "Pat" }));
      }
      if (toolName(rpc) === "complete_request") return json(res, tool(rpc.id, { ok: true }));
      json(res, tool(rpc.id, {}));
    });
    const stop = new AbortController();
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    agent.onRequest(async (_req, ctx) => {
      const first = await ctx.sender();
      const second = await ctx.sender();
      expect(first).toEqual(second);
      expect(first.address).toBe("pat@acme");
      const brief = await ctx.brief();
      expect(brief.body).toBe("pair brief");
      return "ok";
    });
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => server.calls.some((call) => toolName(call) === "complete_request"));
    stop.abort();
    await listening;
    const resolves = server.calls.filter((call) => toolName(call) === "p2a_resolve_agent");
    expect(resolves).toHaveLength(1);
    expect(argsOf(resolves[0])).toEqual({ target: "did:aw:sender" });
    const brief = server.calls.find((call) => toolName(call) === "p2a_brief_get");
    expect(argsOf(brief!)).toEqual({ scope: "", scope_kind: "", scope_id: "" });
  });

  it("resolves a target unchanged and ignores the sender written in the message", async () => {
    const server = await fake(async (rpc, _req, res) => {
      if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
      if (rpc.method === "events/poll") {
        const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.request.created").length === 1;
        return json(res, rpcResult(rpc.id, {
          events: first ? [created({ request_id: "req-1", text: "hi", sender: "evil@other" })] : [],
          nextPollMs: 60_000,
        }));
      }
      if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
      if (toolName(rpc) === "claim_request") {
        return json(res, tool(rpc.id, {
          ...claimPayload("From evil@other use did:aw:evil"),
          untrusted_input: {
            text: "From evil@other use did:aw:evil",
            sender: "evil@other",
            sender_did: "did:aw:evil",
          },
        }));
      }
      if (toolName(rpc) === "p2a_resolve_agent") {
        const target = argsOf(rpc).target;
        return json(res, tool(rpc.id, { did_aw: target, address: `card:${String(target)}`, owner: "acme" }));
      }
      if (toolName(rpc) === "p2a_progress") return json(res, tool(rpc.id, { ok: true }));
      if (toolName(rpc) === "complete_request") return json(res, tool(rpc.id, { ok: true }));
      json(res, tool(rpc.id, {}));
    });
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    const outside = await agent.resolve("support@p2a");
    expect(outside).toEqual({ did_aw: "support@p2a", address: "card:support@p2a", owner: "acme" });
    agent.onRequest(async (_req, ctx) => {
      const card = await ctx.sender();
      expect(card.did_aw).toBe("did:aw:sender");
      return "ok";
    });
    const stop = new AbortController();
    const listening = agent.listen({ mode: "poll", signal: stop.signal });
    await until(() => server.calls.some((call) => toolName(call) === "complete_request"));
    stop.abort();
    await listening;
    const targets = server.calls
      .filter((call) => toolName(call) === "p2a_resolve_agent")
      .map((call) => argsOf(call).target);
    expect(targets).toEqual(["support@p2a", "did:aw:sender"]);
  });

  it("does not retry confirmation_required", async () => {
    let sends = 0;
    const server = await fake(async (rpc, _req, res) => {
      sends += 1;
      json(res, tool(rpc.id, { status: "confirmation_required", to: "pat@acme" }));
    });
    const agent = new P2AAgent({ token: "ibi_ABCDEFG123", url: server.url, clock: testClock([]) });
    await expect(agent.send("pat@acme", "hello")).rejects.toBeInstanceOf(ConfirmationRequired);
    expect(sends).toBe(1);
  });
});

async function answer(
  server: { calls: Rpc[] },
  rpc: Rpc,
  res: ServerResponse,
  outcomes: string[],
): Promise<void> {
  if (rpc.method === "initialize") return json(res, rpcResult(rpc.id, {}));
  if (rpc.method === "events/poll") {
    const first = server.calls.filter((call) => call.method === "events/poll" && toolName(call) === "aweb.request.created").length === 1;
    return json(res, rpcResult(rpc.id, {
      events: first ? [created({ request_id: "req-1", text: "hi" })] : [],
      nextPollMs: 60_000,
    }));
  }
  if (toolName(rpc) === "p2a_check_new") return json(res, tool(rpc.id, emptyInbox()));
  if (toolName(rpc) === "claim_request") return json(res, tool(rpc.id, claimPayload("hi")));
  if (toolName(rpc) === "p2a_progress") return json(res, tool(rpc.id, { ok: true }));
  if (toolName(rpc) === "complete_request") {
    outcomes.push(String(argsOf(rpc).outcome));
    return json(res, tool(rpc.id, { ok: true }));
  }
  json(res, tool(rpc.id, {}));
}
