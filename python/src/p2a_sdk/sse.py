from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SseMessage:
    data: str
    event: str | None = None


class SseParser:
    def __init__(self) -> None:
        self._buffer = ""

    def push(self, chunk: str) -> list[SseMessage]:
        self._buffer += chunk.replace("\r\n", "\n").replace("\r", "\n")
        messages: list[SseMessage] = []
        while "\n\n" in self._buffer:
            block, self._buffer = self._buffer.split("\n\n", 1)
            message = _parse_block(block)
            if message is not None:
                messages.append(message)
        return messages


def _parse_block(block: str) -> SseMessage | None:
    event = None
    data: list[str] = []
    for line in block.split("\n"):
        if not line or line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
            continue
        if line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if not data:
        return None
    return SseMessage(data="\n".join(data), event=event)
