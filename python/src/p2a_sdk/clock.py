from __future__ import annotations

import asyncio
import random
import time
from typing import Protocol


class Clock(Protocol):
    async def sleep(self, ms: float, stop: asyncio.Event | None = None) -> None: ...

    def random(self) -> float: ...

    def now(self) -> float: ...


class SystemClock:
    async def sleep(self, ms: float, stop: asyncio.Event | None = None) -> None:
        if ms <= 0 or (stop is not None and stop.is_set()):
            return
        delay = ms / 1000
        if stop is None:
            await asyncio.sleep(delay)
            return
        try:
            await asyncio.wait_for(stop.wait(), delay)
        except (TimeoutError, asyncio.TimeoutError):
            return

    def random(self) -> float:
        return random.random()

    def now(self) -> float:
        return time.time() * 1000


def backoff_ms(failures: int, random_value: float) -> float:
    base = min(30_000, 1_000 * 2 ** max(0, failures - 1))
    return round(base * (0.5 + random_value * 0.5))
