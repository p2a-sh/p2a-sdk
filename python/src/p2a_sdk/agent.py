from __future__ import annotations

import asyncio
import inspect
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from uuid import uuid4

from p2a_sdk.clock import Clock, SystemClock, backoff_ms
from p2a_sdk.errors import AuthError, P2AError
from p2a_sdk.transport import Transport

LEASE_SECONDS = 300
CUSTOMER_TEXT = "A person from Acme will follow up here."
FAILED_TEXT = "Sorry, something went wrong."
REQUEST_NAMES = ["aweb.request.created"]
SIDE_NAMES = ["aweb.reply.received", "aweb.connection.requested", "aweb.connection.updated"]
ALL_NAMES = [*REQUEST_NAMES, *SIDE_NAMES]


class Directive:
    def __init__(self, outcome: str, result: dict[str, Any]) -> None:
        self.outcome = outcome
        self.result = result


@dataclass
class Request:
    request_id: str
    text: str
    sender: dict[str, str | None]
    same_owner: bool
    context_id: str | None = None
    brief: Any = None
    event_id: str | None = None


class Context:
    def __init__(
        self,
        agent: P2AAgent,
        request_id: str,
        attempt_id: str,
        stop: asyncio.Event,
        sender_did: str | None,
    ) -> None:
        self.signal = stop
        self._agent = agent
        self._request_id = request_id
        self._attempt_id = attempt_id
        self._sender_did = sender_did
        self._sender: dict[str, Any] | None = None

    async def progress(self, note: str = "") -> None:
        args: dict[str, Any] = {
            "request_id": self._request_id,
            "attempt_id": self._attempt_id,
            "state": "working",
        }
        if note:
            args["note"] = note
        await self._agent.transport.call_tool("p2a_progress", args, True)

    async def brief(self, scope: str = "", scope_kind: str = "", scope_id: str = "") -> dict[str, Any]:
        return await self._agent.transport.call_tool(
            "p2a_brief_get",
            {"scope": scope, "scope_kind": scope_kind, "scope_id": scope_id},
            True,
        )

    async def sender(self) -> dict[str, Any]:
        if self._sender is not None:
            return self._sender
        if not self._sender_did:
            self._sender = {}
            return self._sender
        card = await self._agent.transport.call_tool(
            "p2a_resolve_agent",
            {"target": self._sender_did},
            True,
        )
        self._sender = card
        return card

    def escalate(self, question: str, customer_text: str | None = None) -> Directive:
        return Directive(
            "needs_approval",
            {"text": question, "customer_text": customer_text or CUSTOMER_TEXT},
        )

    def ask_customer(self, text: str) -> Directive:
        return Directive("input_required", {"text": text})

    def plan(self, title: str, items: list[Any]) -> Directive:
        return Directive("completed", {"kind": "plan", "title": title, "items": items})


class P2AAgent:
    def __init__(
        self,
        token: str | None = None,
        url: str | None = None,
        *,
        logger: Any = None,
        max_concurrent: int = 4,
        clock: Clock | None = None,
        client: Any = None,
    ) -> None:
        resolved_token = token if token is not None else os.environ.get("P2A_TOKEN", "")
        resolved_url = url if url is not None else os.environ.get("P2A_URL", "")
        if not resolved_token or not resolved_url:
            raise P2AError("missing_config", message="Set P2A_TOKEN and P2A_URL")
        self.clock = clock or SystemClock()
        self.logger = logger
        self.max_concurrent = max_concurrent
        self.transport = Transport(resolved_token, resolved_url, client=client, clock=self.clock)
        self._on_request: Callable[..., Any] | None = None
        self._on_message: Callable[..., Any] | None = None
        self._on_outcome: Callable[..., Any] | None = None
        self._on_reply: Callable[..., Any] | None = None
        self._on_connection: Callable[..., Any] | None = None
        self._seen: set[str] = set()

    async def aclose(self) -> None:
        await self.transport.aclose()

    def on_request(self, handler: Callable[..., Any] | None = None):
        def register(fn: Callable[..., Any]) -> Callable[..., Any]:
            self._on_request = fn
            return fn

        if handler is None:
            return register
        return register(handler)

    def on_message(self, handler: Callable[..., Any]) -> None:
        self._on_message = handler

    def on_outcome(self, handler: Callable[..., Any]) -> None:
        self._on_outcome = handler

    def on_reply(self, handler: Callable[..., Any]) -> None:
        self._on_reply = handler

    def on_connection_request(self, handler: Callable[..., Any]) -> None:
        """Default is no handler, which does nothing. The handler decides whether to accept."""
        self._on_connection = handler

    async def respond_connection(self, link_id: str, action: str) -> dict[str, Any]:
        """Accept, decline, or block. This call is the confirmation, so confirm is true."""
        if action not in {"accept", "decline", "block"}:
            raise P2AError("invalid_action", message="invalid_action")
        return await self.transport.call_tool(
            "p2a_respond_connection",
            {"link_id": link_id, "action": action, "confirm": True},
            False,
        )

    async def send(
        self,
        to: str,
        text: str,
        *,
        idempotency_key: str | None = None,
        deadline_seconds: int | None = None,
        wait: int = 0,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {
            "to": to,
            "text": text,
            "idempotency_key": idempotency_key or str(uuid4()),
            "wait_seconds": wait,
        }
        if deadline_seconds is not None:
            args["deadline_seconds"] = deadline_seconds
        payload = await self.transport.call_tool("p2a_send_message", args, False)
        return _send_result(payload)

    async def wait_for_reply(self, request_id: str, *, timeout: int | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"request_id": request_id}
        if timeout is not None:
            args["wait_seconds"] = timeout
        payload = await self.transport.call_tool("p2a_wait_for_reply", args, False)
        return _send_result(payload)

    async def listen(self, mode: str = "stream", stop: asyncio.Event | None = None) -> None:
        signal = stop or asyncio.Event()
        # Handshake only. The server marks the runtime connected on the first
        # tools/call or events feed read, not on initialize.
        await self.transport.initialize()
        if signal.is_set():
            return
        await self._drain_inbox()
        if signal.is_set():
            return
        if mode == "poll":
            await self._poll_loop(ALL_NAMES, signal)
            return
        outcome = await self._stream_with_side(signal)
        if outcome == "fallback" and not signal.is_set():
            await self._poll_loop(ALL_NAMES, signal)

    async def _drain_inbox(self) -> None:
        inbox = await self.transport.call_tool("p2a_check_new", {}, True)
        pending = inbox.get("pending_requests") if isinstance(inbox.get("pending_requests"), list) else []
        replies = inbox.get("unread_replies") if isinstance(inbox.get("unread_replies"), list) else []
        connections = inbox.get("connection_requests") if isinstance(inbox.get("connection_requests"), list) else []
        events = []
        for item in pending:
            record = item if isinstance(item, dict) else {}
            if record.get("kind") == "outcome":
                events.append(
                    {
                        "name": "aweb.request.created",
                        "data": {
                            "request_id": record.get("request_id"),
                            "kind": "outcome",
                            "parent_request_id": record.get("parent_request_id"),
                        },
                    }
                )
            else:
                events.append(
                    {
                        "name": "aweb.request.created",
                        "data": {
                            "request_id": record.get("request_id"),
                            "sender": record.get("from"),
                            "same_owner": record.get("same_owner"),
                            "kind": record.get("kind"),
                        },
                    }
                )
        await self._each(events)
        for item in replies:
            record = item if isinstance(item, dict) else {}
            await self._dispatch_reply(
                {
                    "request_id": record.get("request_id") if isinstance(record.get("request_id"), str) else None,
                    "summary": record.get("summary") if isinstance(record.get("summary"), str) else None,
                }
            )
        for item in connections:
            await self._dispatch_connection(item if isinstance(item, dict) else {})

    async def _poll_loop(self, names: list[str], stop: asyncio.Event) -> None:
        cursors: dict[str, str] = {}
        while not stop.is_set():
            wait = 25_000
            more = False
            for name in names:
                if stop.is_set():
                    return
                page = await self.transport.poll(name, cursors.get(name))
                if isinstance(page.get("cursor"), str):
                    cursors[name] = page["cursor"]
                if isinstance(page.get("nextPollMs"), (int, float)):
                    wait = min(wait, page["nextPollMs"])
                if page.get("hasMore") is True:
                    more = True
                await self._each(page.get("events") or [])
            if stop.is_set():
                return
            if not more:
                await self.clock.sleep(wait, stop)

    async def _stream_with_side(self, stop: asyncio.Event) -> str:
        side = asyncio.Event()

        async def watch() -> None:
            await stop.wait()
            side.set()

        watcher = asyncio.create_task(watch())
        polling = asyncio.create_task(self._poll_loop(SIDE_NAMES, side))
        try:
            return await self._stream_loop(stop)
        finally:
            side.set()
            watcher.cancel()
            await polling

    async def _stream_loop(self, stop: asyncio.Event) -> str:
        failures = 0
        cursor = None
        while not stop.is_set():
            try:
                async for note in self.transport.stream("aweb.request.created", cursor, stop):
                    if stop.is_set():
                        return "stopped"
                    failures = 0
                    if note.get("cursor"):
                        cursor = note["cursor"]
                    if note.get("event"):
                        await self._accept(note["event"])
                if stop.is_set():
                    return "stopped"
                failures += 1
            except AuthError:
                raise
            except Exception as err:
                if stop.is_set() or _is_abort(err):
                    return "stopped"
                failures += 1
            if failures >= 3:
                return "fallback"
            await self.clock.sleep(backoff_ms(failures, self.clock.random()), stop)
        return "stopped"

    async def _each(self, events: list[dict[str, Any]]) -> None:
        queue = list(events)

        async def worker() -> None:
            while queue:
                event = queue.pop(0)
                await self._accept(event)

        count = min(self.max_concurrent, len(queue))
        if count:
            await asyncio.gather(*(worker() for _ in range(count)))

    async def _accept(self, event: dict[str, Any]) -> None:
        name = event.get("name") or ""
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        event_id = event.get("eventId") if isinstance(event.get("eventId"), str) else None
        if name == "aweb.reply.received":
            await self._dispatch_reply(
                {
                    "event_id": event_id,
                    "request_id": _text(data, "request_id"),
                    "text": _text(data, "text") or _text(data, "reply_text"),
                    "summary": _text(data, "summary"),
                }
            )
            return
        if name == "aweb.connection.requested":
            await self._dispatch_connection(data, event_id)
            return
        if name != "aweb.request.created":
            self._log(event_id=event_id)
            return
        kind = _text(data, "kind")
        if kind == "message":
            if self._on_message:
                await _maybe(self._on_message, {
                    "event_id": event_id,
                    "request_id": _text(data, "request_id"),
                    "text": _text(data, "text"),
                    "sender": _text(data, "sender"),
                    "same_owner": data.get("same_owner") is True,
                })
            else:
                self._log(event_id=event_id)
            return
        if kind == "outcome":
            if self._on_outcome:
                await _maybe(self._on_outcome, {
                    "event_id": event_id,
                    "request_id": _text(data, "request_id"),
                    "parent_request_id": _text(data, "parent_request_id"),
                    "outcome": data.get("outcome"),
                })
            else:
                self._log(event_id=event_id)
            return
        if kind and kind != "request":
            self._log(event_id=event_id)
            return
        await self._claim_and_run(data, event_id)

    async def _dispatch_reply(self, reply: dict[str, Any]) -> None:
        if self._on_reply:
            await _maybe(self._on_reply, reply)
        else:
            self._log(event_id=reply.get("event_id"), request_id=reply.get("request_id"))

    async def _dispatch_connection(self, data: dict[str, Any], event_id: str | None = None) -> None:
        link_id = _text(data, "link_id")
        if not link_id or self._on_connection is None:
            self._log(event_id=event_id)
            return
        await _maybe(
            self._on_connection,
            {
                "link_id": link_id,
                "from": _text(data, "from"),
                "owner": _text(data, "owner"),
                "text": _text(data, "text"),
            },
        )

    async def _claim_and_run(self, data: dict[str, Any], event_id: str | None) -> None:
        request_id = _text(data, "request_id")
        if not request_id or request_id in self._seen:
            return
        self._seen.add(request_id)
        attempt_id = str(uuid4())
        started = self.clock.now()
        try:
            claim = await self.transport.call_tool(
                "claim_request",
                {"request_id": request_id, "attempt_id": attempt_id, "lease_seconds": LEASE_SECONDS},
                True,
            )
        except AuthError:
            raise
        except P2AError as err:
            self._log(request_id=request_id, event_id=event_id, outcome=err.code if _skip_claim(err.code) else None)
            return
        handler_stop = asyncio.Event()
        keeper_stop = asyncio.Event()
        keeper = asyncio.create_task(self._keep_lease(request_id, attempt_id, keeper_stop))
        try:
            directive = await self._run_handler(claim, data, event_id, handler_stop, attempt_id)
        finally:
            keeper_stop.set()
            handler_stop.set()
            await keeper
        await self._finish(request_id, attempt_id, directive, event_id, started)

    async def _run_handler(
        self,
        claim: dict[str, Any],
        data: dict[str, Any],
        event_id: str | None,
        stop: asyncio.Event,
        attempt_id: str,
    ) -> Directive:
        request_id = _text(claim, "request_id") or _text(data, "request_id") or ""
        raw_input = claim.get("untrusted_input") if isinstance(claim.get("untrusted_input"), dict) else {}
        req = Request(
            request_id=request_id,
            text=_text(raw_input, "text") or _text(data, "text") or "",
            sender={"did": _text(claim, "sender_did"), "address": _text(data, "sender") or _text(raw_input, "sender")},
            same_owner=claim.get("same_owner") is True,
            context_id=_text(claim, "conversation_id"),
            brief=claim.get("brief"),
            event_id=event_id,
        )
        ctx = Context(self, request_id, attempt_id, stop, _text(claim, "sender_did"))
        if self._on_request is None:
            return Directive("completed", {"text": ""})
        try:
            returned = await _maybe(self._on_request, req, ctx)
        except Exception:
            return Directive("failed", {"text": FAILED_TEXT})
        if isinstance(returned, Directive):
            return returned
        return Directive("completed", {"text": returned if isinstance(returned, str) else ""})

    async def _finish(
        self,
        request_id: str,
        attempt_id: str,
        body: Directive,
        event_id: str | None,
        started: float,
    ) -> None:
        args = {
            "request_id": request_id,
            "attempt_id": attempt_id,
            "outcome": body.outcome,
            "result": body.result,
        }
        try:
            await self.transport.call_tool("complete_request", args, True)
            self._log(
                request_id=request_id,
                event_id=event_id,
                outcome=body.outcome,
                duration_ms=self.clock.now() - started,
            )
        except AuthError:
            raise
        except P2AError as err:
            self._log(request_id=request_id, event_id=event_id, outcome=err.code)

    async def _keep_lease(self, request_id: str, attempt_id: str, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.clock.sleep((LEASE_SECONDS / 3) * 1000, stop)
            if stop.is_set():
                return
            try:
                await self.transport.call_tool(
                    "p2a_progress",
                    {"request_id": request_id, "attempt_id": attempt_id, "state": "working"},
                    True,
                )
            except AuthError:
                raise
            except P2AError:
                return

    def _log(
        self,
        *,
        request_id: str | None = None,
        event_id: str | None = None,
        outcome: str | None = None,
        duration_ms: float | None = None,
    ) -> None:
        if self.logger is None:
            return
        parts = []
        if request_id:
            parts.append(f"request_id={request_id}")
        if event_id:
            parts.append(f"event_id={event_id}")
        if outcome:
            parts.append(f"outcome={outcome}")
        if duration_ms is not None:
            parts.append(f"duration_ms={duration_ms}")
        if parts:
            self.logger.info(" ".join(parts))


def _send_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": payload.get("status") if isinstance(payload.get("status"), str) else None,
        "request_id": payload.get("request_id") if isinstance(payload.get("request_id"), str) else None,
        "reply_text": payload.get("reply_text") if isinstance(payload.get("reply_text"), str) else None,
        "summary": payload.get("summary") if isinstance(payload.get("summary"), str) else None,
    }


async def _maybe(fn: Callable[..., Any], *args: Any) -> Any:
    if inspect.iscoroutinefunction(fn):
        return await fn(*args)
    result = await asyncio.to_thread(fn, *args)
    if inspect.isawaitable(result):
        return await result
    return result


def _skip_claim(code: str) -> bool:
    return code == "request_already_claimed" or code.startswith("request_not_claimable")


def _text(record: dict[str, Any], key: str) -> str | None:
    value = record.get(key)
    return value if isinstance(value, str) else None


def _is_abort(err: BaseException) -> bool:
    return err.__class__.__name__ in {"AbortError", "CancelledError"}
