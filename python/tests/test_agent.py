from __future__ import annotations

import asyncio
import json

import httpx

from p2a_sdk import AuthError, ConfirmationRequired, P2AAgent, P2AError, RateLimited, SseParser


class FakeClock:
    def __init__(self) -> None:
        self.requested: list[float] = []

    def random(self) -> float:
        return 0

    def now(self) -> float:
        return 0

    async def sleep(self, ms: float, stop: asyncio.Event | None = None) -> None:
        self.requested.append(ms)
        if ms == 100_000:
            await asyncio.sleep(0)
            return
        if ms <= 0 or (stop is not None and stop.is_set()):
            return
        if ms >= 25_000:
            if stop is not None:
                await stop.wait()
            return
        await asyncio.sleep(0)


def _body(request: httpx.Request) -> dict:
    return json.loads(request.content.decode())


def _tool(payload: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"content": [{"type": "text", "text": json.dumps(payload)}]},
        },
    )


def _rpc(result: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json={"jsonrpc": "2.0", "id": 1, "result": result})


def _name(body: dict) -> str:
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    name = params.get("name")
    return name if isinstance(name, str) else ""


def _args(body: dict) -> dict:
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    args = params.get("arguments")
    return args if isinstance(args, dict) else {}


async def _until(check) -> None:
    for _ in range(400):
        if check():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("timed out")


def _created(data: dict) -> dict:
    return {"eventId": "evt-1", "name": "aweb.request.created", "data": data}


def _inbox() -> dict:
    return {"pending_requests": [], "unread_replies": [], "connection_requests": []}


def _claim(text: str = "please refund ada@example.com now") -> dict:
    return {
        "request_id": "req-1",
        "sender_did": "did:aw:sender",
        "conversation_id": "ctx-1",
        "same_owner": False,
        "untrusted_input": {"text": text},
    }


def test_sse_split_frame_keeps_the_cursor():
    parser = SseParser()
    raw = 'data: {"jsonrpc":"2.0","method":"notifications/events/event","params":{"cursor":"c1","eventId":"e1"}}\n\n'
    assert parser.push(raw[:12]) == []
    messages = parser.push(raw[12:])
    assert json.loads(messages[0].data)["params"]["cursor"] == "c1"


def test_error_text_redacts_tokens():
    err = P2AError("bad", message="saw ibi_ABCDEFG123 in the body")
    assert "ibi_ABCDEFG123" not in str(err)
    assert "ibi_[redacted]" in str(err)


def test_unauthorized_is_not_retried():
    async def run() -> None:
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(_body(request))
            return httpx.Response(401)

        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=FakeClock())
        try:
            with pytest_raises(AuthError):
                await agent.listen("poll")
            assert sum(1 for call in calls if call["method"] == "initialize") == 1
        finally:
            await agent.aclose()

    asyncio.run(run())


def test_string_handler_completes_without_logging_secrets():
    async def run() -> None:
        calls: list[dict] = []
        lines: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({"protocolVersion": "2025-11-25"})
            if body["method"] == "events/poll":
                first = sum(1 for call in calls if call["method"] == "events/poll" and _name(call) == "aweb.request.created") == 1
                events = [_created({"request_id": "req-1", "text": "please refund ada@example.com now", "sender": "pat@acme", "same_owner": False})] if first else []
                return _rpc({"events": events, "cursor": "c1", "nextPollMs": 60_000, "hasMore": False})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            if _name(body) == "claim_request":
                return _tool(_claim())
            if _name(body) == "complete_request":
                return _tool({"ok": True})
            return _tool({"ok": True})

        class Logger:
            def info(self, line: str) -> None:
                lines.append(line)

        stop = asyncio.Event()
        seen = {}
        agent = P2AAgent(
            "ibi_ABCDEFG123",
            "https://p2a.test/mcp",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            clock=FakeClock(),
            logger=Logger(),
        )

        @agent.on_request
        async def handle(req, _ctx):
            seen["text"] = req.text
            assert req.same_owner is False
            assert req.sender["did"] == "did:aw:sender"
            assert req.sender["address"] == "pat@acme"
            return "plain text"

        listen = asyncio.create_task(agent.listen("poll", stop))
        try:
            await _until(lambda: any(_name(call) == "complete_request" for call in calls))
            stop.set()
            await listen
            complete = next(call for call in calls if _name(call) == "complete_request")
            assert _args(complete)["result"] == {"text": "plain text"}
            assert _args(complete)["outcome"] == "completed"
            logged = "\n".join(lines)
            assert "ibi_" not in logged
            assert "ada@example.com" not in logged
            assert "please refund" not in logged
            assert seen["text"]
            assert sum(1 for call in calls if _name(call) == "p2a_check_new") == 1
            assert not any(_name(call) == "renew_request_lease" for call in calls)
        finally:
            stop.set()
            await agent.aclose()

    asyncio.run(run())


def test_escalate_ask_and_thrown_failure():
    async def run() -> None:
        await _one("needs_approval", lambda _req, ctx: ctx.escalate("Refund over $500?"), {
            "text": "Refund over $500?",
            "customer_text": "A person from Acme will follow up here.",
        })
        await _one("input_required", lambda _req, ctx: ctx.ask_customer("Which order?"), {"text": "Which order?"})

        def explode(_req, _ctx):
            raise RuntimeError("stack ada@example.com ibi_ABCDEFG123")

        result = await _one("failed", explode, None)
        assert result["text"] == "Sorry, something went wrong."
        assert "ada@example.com" not in json.dumps(result)
        assert "ibi_" not in json.dumps(result)

    asyncio.run(run())


def test_rate_limit_retries_complete_but_not_send():
    async def run() -> None:
        calls: list[dict] = []
        completes = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/poll":
                first = sum(1 for call in calls if call["method"] == "events/poll" and _name(call) == "aweb.request.created") == 1
                events = [_created({"request_id": "req-1", "kind": "request", "text": "hi"})] if first else []
                return _rpc({"events": events, "cursor": "c", "nextPollMs": 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            if _name(body) == "claim_request":
                return _tool(_claim("hi"))
            if _name(body) == "complete_request":
                completes["n"] += 1
                if completes["n"] == 1:
                    return _tool({"error": "rate_limited", "retry_after": 0})
                return _tool({"ok": True})
            return _tool({"ok": True})

        stop = asyncio.Event()
        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=FakeClock())
        agent.on_request(lambda _req, _ctx: "ok")
        listen = asyncio.create_task(agent.listen("poll", stop))
        try:
            await _until(lambda: completes["n"] == 2)
            stop.set()
            await listen
            assert completes["n"] == 2
        finally:
            stop.set()
            await agent.aclose()

        sends = {"n": 0}

        def send_handler(request: httpx.Request) -> httpx.Response:
            sends["n"] += 1
            return _tool({"error": "rate_limited", "retry_after": 1})

        sender = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(send_handler)), clock=FakeClock())
        try:
            with pytest_raises(RateLimited):
                await sender.send("pat@acme", "hello")
            assert sends["n"] == 1
        finally:
            await sender.aclose()

    asyncio.run(run())


def test_complete_retry_repeats_the_same_arguments():
    async def run() -> None:
        calls: list[dict] = []
        seen: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/poll":
                first = sum(1 for call in calls if call["method"] == "events/poll" and _name(call) == "aweb.request.created") == 1
                events = [_created({"request_id": "req-1", "text": "hi"})] if first else []
                return _rpc({"events": events, "nextPollMs": 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            if _name(body) == "claim_request":
                return _tool(_claim("hi"))
            if _name(body) == "complete_request":
                seen.append(_args(body))
                if len(seen) < 3:
                    return httpx.Response(500, json={"error": "down"})
                return _tool({"ok": True})
            return _tool({"ok": True})

        stop = asyncio.Event()
        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=FakeClock())
        agent.on_request(lambda _req, _ctx: "same")
        listen = asyncio.create_task(agent.listen("poll", stop))
        try:
            await _until(lambda: len(seen) == 3)
            stop.set()
            await listen
            assert seen[0] == seen[1] == seen[2]
            assert seen[0]["result"] == {"text": "same"}
        finally:
            stop.set()
            await agent.aclose()

    asyncio.run(run())


def test_lease_keeper_uses_progress():
    async def run() -> None:
        calls: list[dict] = []
        progress = {"n": 0}
        clock = FakeClock()

        def handler(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/poll":
                first = sum(1 for call in calls if call["method"] == "events/poll" and _name(call) == "aweb.request.created") == 1
                events = [_created({"request_id": "req-1", "text": "hi"})] if first else []
                return _rpc({"events": events, "nextPollMs": 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            if _name(body) == "claim_request":
                return _tool(_claim("hi"))
            if _name(body) == "p2a_progress":
                progress["n"] += 1
                return _tool({"ok": True})
            return _tool({"ok": True})

        stop = asyncio.Event()
        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=clock)

        async def handle(_req, _ctx):
            await _until(lambda: progress["n"] >= 1)
            return "ok"

        agent.on_request(handle)
        listen = asyncio.create_task(agent.listen("poll", stop))
        try:
            await _until(lambda: any(_name(call) == "complete_request" for call in calls))
            stop.set()
            await listen
            assert progress["n"] >= 1
            assert not any(_name(call) == "renew_request_lease" for call in calls)
            assert 100_000 in clock.requested
            progress_call = next(call for call in calls if _name(call) == "p2a_progress")
            assert _args(progress_call)["state"] == "working"
        finally:
            stop.set()
            await agent.aclose()

    asyncio.run(run())


def test_message_outcome_and_unknown_kind_are_not_claimed():
    async def run() -> None:
        calls: list[dict] = []
        step = {"n": 0}
        messages: list[str] = []
        outcomes: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/poll":
                if _name(body) != "aweb.request.created":
                    return _rpc({"events": [], "nextPollMs": 60_000})
                step["n"] += 1
                data = (
                    {"request_id": "mail-1", "kind": "message", "text": "stored note", "reply_required": False}
                    if step["n"] == 1
                    else {"request_id": "out-1", "kind": "outcome", "parent_request_id": "plan-1"}
                    if step["n"] == 2
                    else {"request_id": "odd-1", "kind": "future"}
                )
                events = [_created(data)] if step["n"] <= 3 else []
                return _rpc({"events": events, "nextPollMs": 0 if step["n"] <= 3 else 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            if _name(body) == "claim_request":
                return _tool(_claim("nope"))
            return _tool({"ok": True})

        stop = asyncio.Event()
        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=FakeClock())
        agent.on_message(lambda msg: messages.append(msg["request_id"]))
        agent.on_outcome(lambda evt: outcomes.append(evt["request_id"]))
        listen = asyncio.create_task(agent.listen("poll", stop))
        try:
            await _until(lambda: messages == ["mail-1"] and outcomes == ["out-1"] and step["n"] >= 3)
            stop.set()
            await listen
            assert not any(_name(call) == "claim_request" for call in calls)
            assert not any(_name(call) == "complete_request" for call in calls)
        finally:
            stop.set()
            await agent.aclose()

    asyncio.run(run())


def test_stream_resumes_cursor_and_falls_back_after_three_failures():
    async def run() -> None:
        calls: list[dict] = []
        streams = {"n": 0}
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/stream":
                streams["n"] += 1
                if streams["n"] == 1:
                    frame = json.dumps({
                        "jsonrpc": "2.0",
                        "method": "notifications/events/event",
                        "params": {
                            "cursor": "c1",
                            "eventId": "e1",
                            "name": "aweb.request.created",
                            "data": {"request_id": "req-1", "kind": "message", "text": "notice"},
                        },
                    })
                    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=f"data: {frame}\n\n".encode())
                assert body["params"]["cursor"] == "c1"
                return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b"")
            if body["method"] == "events/poll":
                return _rpc({"events": [], "nextPollMs": 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            return _tool({"ok": True})

        stop = asyncio.Event()
        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=FakeClock())
        agent.on_message(lambda msg: seen.append(msg["event_id"]))
        listen = asyncio.create_task(agent.listen(stop=stop))
        try:
            await _until(lambda: streams["n"] >= 2 and "e1" in seen)
            resumed = [call for call in calls if call["method"] == "events/stream"][1]
            assert resumed["params"]["cursor"] == "c1"
            stop.set()
            await listen
        finally:
            stop.set()
            await agent.aclose()

        failed = {"n": 0}
        polls = {"n": 0}

        def fail(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/stream":
                failed["n"] += 1
                return httpx.Response(500, json={"error": "down"})
            if body["method"] == "events/poll":
                if _name(body) == "aweb.request.created":
                    polls["n"] += 1
                return _rpc({"events": [], "nextPollMs": 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            return _tool({"ok": True})

        stop2 = asyncio.Event()
        agent2 = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(fail)), clock=FakeClock())
        listen2 = asyncio.create_task(agent2.listen(stop=stop2))
        try:
            await _until(lambda: polls["n"] >= 1)
            stop2.set()
            await listen2
            assert failed["n"] == 3
        finally:
            stop2.set()
            await agent2.aclose()

    asyncio.run(run())


def test_connection_request_accepts_with_confirm_true():
    async def run() -> None:
        calls: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/poll":
                first = sum(1 for call in calls if call["method"] == "events/poll" and _name(call) == "aweb.connection.requested") == 1
                events = [{
                    "eventId": "evt-c",
                    "name": "aweb.connection.requested",
                    "data": {"link_id": "link-1", "from": "pat@acme", "owner": "acme", "text": "p2a connection request"},
                }] if first else []
                return _rpc({"events": events, "nextPollMs": 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            if _name(body) == "p2a_respond_connection":
                return _tool({"state": "connected", "link_id": "link-1"})
            return _tool({"ok": True})

        stop = asyncio.Event()
        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=FakeClock())

        async def accept(req):
            assert req["link_id"] == "link-1"
            await agent.respond_connection(req["link_id"], "accept")

        agent.on_connection_request(accept)
        listen = asyncio.create_task(agent.listen("poll", stop))
        try:
            await _until(lambda: any(_name(call) == "p2a_respond_connection" for call in calls))
            stop.set()
            await listen
            respond = next(call for call in calls if _name(call) == "p2a_respond_connection")
            assert _args(respond) == {"link_id": "link-1", "action": "accept", "confirm": True}
            assert not any(_name(call) == "claim_request" for call in calls)
        finally:
            stop.set()
            await agent.aclose()

    asyncio.run(run())


def test_wait_brief_and_sender_resolve_once():
    async def run():
        waits = {"n": 0}

        def wait_transport(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            waits["n"] += 1
            assert _name(body) == "p2a_wait_for_reply"
            assert _args(body) == {"request_id": "req-9", "wait_seconds": 5}
            return _tool({"error": "rate_limited", "retry_after": 1})

        waiter = P2AAgent(
            "ibi_ABCDEFG123",
            "https://p2a.test/mcp",
            client=httpx.AsyncClient(transport=httpx.MockTransport(wait_transport)),
            clock=FakeClock(),
        )
        try:
            with pytest_raises(RateLimited):
                await waiter.wait_for_reply("req-9", timeout=5)
            assert waits["n"] == 1
        finally:
            await waiter.aclose()

        calls: list[dict] = []

        def transport(request: httpx.Request) -> httpx.Response:
            body = _body(request)
            calls.append(body)
            if body["method"] == "initialize":
                return _rpc({})
            if body["method"] == "events/poll":
                first = sum(1 for call in calls if call["method"] == "events/poll" and _name(call) == "aweb.request.created") == 1
                events = [_created({"request_id": "req-1", "text": "hi", "sender": "pat@acme"})] if first else []
                return _rpc({"events": events, "nextPollMs": 60_000})
            if _name(body) == "p2a_check_new":
                return _tool(_inbox())
            if _name(body) == "claim_request":
                return _tool(_claim("hi"))
            if _name(body) == "p2a_brief_get":
                return _tool({"version": 1, "body": "pair brief"})
            if _name(body) == "p2a_resolve_agent":
                return _tool({"did_aw": "did:aw:sender", "address": "pat@acme", "display_name": "Pat"})
            return _tool({"ok": True})

        stop = asyncio.Event()
        agent = P2AAgent(
            "ibi_ABCDEFG123",
            "https://p2a.test/mcp",
            client=httpx.AsyncClient(transport=httpx.MockTransport(transport)),
            clock=FakeClock(),
        )

        async def handler(_req, ctx):
            first = await ctx.sender()
            second = await ctx.sender()
            assert first == second
            assert first["address"] == "pat@acme"
            brief = await ctx.brief()
            assert brief["body"] == "pair brief"
            return "ok"

        agent.on_request(handler)
        listen = asyncio.create_task(agent.listen("poll", stop))
        try:
            await _until(lambda: any(_name(call) == "complete_request" for call in calls))
            stop.set()
            await listen
        finally:
            stop.set()
            await agent.aclose()
        resolves = [call for call in calls if _name(call) == "p2a_resolve_agent"]
        assert len(resolves) == 1
        assert _args(resolves[0]) == {"target": "did:aw:sender"}
        brief = next(call for call in calls if _name(call) == "p2a_brief_get")
        assert _args(brief) == {"scope": "", "scope_kind": "", "scope_id": ""}

    asyncio.run(run())


def test_confirmation_required_is_not_retried():
    async def run() -> None:
        sends = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            sends["n"] += 1
            return _tool({"status": "confirmation_required", "to": "pat@acme"})

        agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=FakeClock())
        try:
            with pytest_raises(ConfirmationRequired):
                await agent.send("pat@acme", "hello")
            assert sends["n"] == 1
        finally:
            await agent.aclose()

    asyncio.run(run())


class pytest_raises:
    def __init__(self, expected: type[BaseException]) -> None:
        self.expected = expected

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, _tb) -> bool:
        if exc_type is None:
            raise AssertionError(f"expected {self.expected.__name__}")
        if not issubclass(exc_type, self.expected):
            return False
        return True


async def _one(outcome: str, handler, expected):
    calls: list[dict] = []

    def transport(request: httpx.Request) -> httpx.Response:
        body = _body(request)
        calls.append(body)
        if body["method"] == "initialize":
            return _rpc({})
        if body["method"] == "events/poll":
            first = sum(1 for call in calls if call["method"] == "events/poll" and _name(call) == "aweb.request.created") == 1
            events = [_created({"request_id": "req-1", "text": "hi"})] if first else []
            return _rpc({"events": events, "nextPollMs": 60_000})
        if _name(body) == "p2a_check_new":
            return _tool(_inbox())
        if _name(body) == "claim_request":
            return _tool(_claim("hi"))
        return _tool({"ok": True})

    stop = asyncio.Event()
    agent = P2AAgent("ibi_ABCDEFG123", "https://p2a.test/mcp", client=httpx.AsyncClient(transport=httpx.MockTransport(transport)), clock=FakeClock())
    agent.on_request(handler)
    listen = asyncio.create_task(agent.listen("poll", stop))
    try:
        await _until(lambda: any(_name(call) == "complete_request" for call in calls))
        stop.set()
        await listen
        complete = next(call for call in calls if _name(call) == "complete_request")
        assert _args(complete)["outcome"] == outcome
        if expected is not None:
            assert _args(complete)["result"] == expected
        return _args(complete)["result"]
    finally:
        stop.set()
        await agent.aclose()
