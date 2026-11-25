from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx

from p2a_sdk.clock import Clock, SystemClock, backoff_ms
from p2a_sdk.errors import (
    AuthError,
    ConfirmationRequired,
    ConnectionDeclined,
    P2AError,
    RateLimited,
    is_retryable,
)
from p2a_sdk.sse import SseParser

_TRIES = 3


class Transport:
    def __init__(self, token: str, url: str, *, client: httpx.AsyncClient | None = None, clock: Clock | None = None) -> None:
        self.token = token
        self.url = url
        self.clock = clock or SystemClock()
        self._client = client or httpx.AsyncClient(timeout=None)
        self._owns_client = client is None
        self._next_id = 1
        self._initialized = False

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def initialize(self) -> None:
        if self._initialized:
            return
        await self._attempt(
            True,
            lambda: self._rpc_once(
                "initialize",
                {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "p2a-sdk", "version": "0.1.1"},
                },
            ),
        )
        self._initialized = True

    async def call_tool(self, name: str, args: dict[str, Any], retry: bool) -> dict[str, Any]:
        async def run() -> dict[str, Any]:
            result = await self._rpc_once("tools/call", {"name": name, "arguments": args})
            payload = _unwrap_tool(result)
            _classify(payload)
            return payload

        return await self._attempt(retry, run)

    async def poll(self, name: str, cursor: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"name": name}
        if cursor:
            params["cursor"] = cursor
        result = await self._attempt(True, lambda: self._rpc_once("events/poll", params))
        events = result.get("events")
        return {
            "events": events if isinstance(events, list) else [],
            "cursor": result.get("cursor") if isinstance(result.get("cursor"), str) else cursor,
            "nextPollMs": result.get("nextPollMs") if isinstance(result.get("nextPollMs"), (int, float)) else 25_000,
            "hasMore": result.get("hasMore") is True,
        }

    async def stream(self, name: str, cursor: str | None, stop: asyncio.Event) -> AsyncIterator[dict[str, Any]]:
        params: dict[str, Any] = {"name": name}
        if cursor:
            params["cursor"] = cursor
        body, headers = self._request("events/stream", params)
        async with self._client.stream("POST", self.url, headers=headers, content=body) as response:
            if response.status_code == 401:
                raise AuthError()
            if response.status_code >= 400:
                raise P2AError(
                    f"http_{response.status_code}",
                    message=f"http_{response.status_code}",
                    status=response.status_code,
                )
            watcher = asyncio.create_task(_close_on_stop(response, stop))
            parser = SseParser()
            try:
                async for chunk in response.aiter_text():
                    if stop.is_set():
                        break
                    for message in parser.push(chunk):
                        note = _parse_note(message.data)
                        if note is not None:
                            yield note
            finally:
                watcher.cancel()

    async def _attempt(self, retry: bool, run: Callable[[], Awaitable[Any]]) -> Any:
        last: BaseException | None = None
        tries = _TRIES if retry else 1
        for attempt in range(1, tries + 1):
            try:
                return await run()
            except Exception as err:
                last = err
                if not retry or attempt == tries or not is_retryable(err):
                    raise
                wait = (
                    max(0, err.retry_after) * 1000
                    if isinstance(err, RateLimited) and err.retry_after is not None
                    else backoff_ms(attempt, self.clock.random())
                )
                await self.clock.sleep(wait, None)
        raise last or P2AError("network", message="network")

    async def _rpc_once(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        body, headers = self._request(method, params)
        try:
            response = await self._client.post(self.url, headers=headers, content=body)
        except P2AError:
            raise
        except Exception as err:
            raise P2AError("network", message="network") from err
        if response.status_code == 401:
            raise AuthError()
        if response.status_code == 429:
            raw = response.headers.get("retry-after")
            retry_after = float(raw) if raw and raw.replace(".", "", 1).isdigit() else None
            raise RateLimited(retry_after)
        if response.status_code >= 400:
            raise P2AError(
                f"http_{response.status_code}",
                message=f"http_{response.status_code}",
                status=response.status_code,
            )
        try:
            payload = response.json()
        except Exception as err:
            raise P2AError("invalid_response", message="invalid_response") from err
        if not isinstance(payload, dict):
            raise P2AError("invalid_response", message="invalid_response")
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message") if isinstance(error.get("message"), str) else "rpc_error"
            raise P2AError(message, message=message)
        result = payload.get("result")
        return result if isinstance(result, dict) else {}

    def _request(self, method: str, params: dict[str, Any]) -> tuple[bytes, dict[str, str]]:
        body = json.dumps(
            {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params}
        ).encode()
        self._next_id += 1
        return body, {
            "authorization": f"Bearer {self.token}",
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        }


async def _close_on_stop(response: httpx.Response, stop: asyncio.Event) -> None:
    await stop.wait()
    await response.aclose()


def _unwrap_tool(result: dict[str, Any]) -> dict[str, Any]:
    content = result.get("content")
    if not isinstance(content, list):
        return result
    text = "".join(
        item.get("text", "")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
    )
    if not text:
        return result
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}
    return parsed if isinstance(parsed, dict) else {"text": text}


def _classify(payload: dict[str, Any]) -> None:
    code = payload.get("error") if isinstance(payload.get("error"), str) else None
    status = payload.get("status") if isinstance(payload.get("status"), str) else None
    retry_after = payload.get("retry_after") if isinstance(payload.get("retry_after"), (int, float)) else None
    request_id = payload.get("request_id") if isinstance(payload.get("request_id"), str) else None
    recipient = payload.get("to") if isinstance(payload.get("to"), str) and payload.get("to") else None
    if recipient is None and isinstance(payload.get("recipient"), str):
        recipient = payload.get("recipient")
    if code == "rate_limited" or status == "rate_limited":
        raise RateLimited(retry_after, request_id)
    if code == "confirmation_required" or status == "confirmation_required":
        raise ConfirmationRequired(recipient, request_id)
    if code == "connection_declined" or status == "connection_declined":
        raise ConnectionDeclined(retry_after, request_id)
    if code:
        raise P2AError(code, retry_after=retry_after, request_id=request_id, message=code)


def _parse_note(data: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    method = parsed.get("method") if isinstance(parsed.get("method"), str) else ""
    params = parsed.get("params") if isinstance(parsed.get("params"), dict) else {}
    cursor = params.get("cursor") if isinstance(params.get("cursor"), str) else None
    if method != "notifications/events/event":
        return {"method": method, "cursor": cursor}
    data_field = params.get("data") if isinstance(params.get("data"), dict) else {}
    return {
        "method": method,
        "cursor": cursor,
        "event": {
            "eventId": params.get("eventId") if isinstance(params.get("eventId"), str) else None,
            "name": params.get("name") if isinstance(params.get("name"), str) else None,
            "data": data_field,
            "cursor": cursor,
        },
    }
