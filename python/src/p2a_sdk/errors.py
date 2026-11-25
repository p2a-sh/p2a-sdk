from __future__ import annotations

import re

_TOKEN = re.compile(r"ibi_[A-Za-z0-9]+")


def redact(value: str) -> str:
    return _TOKEN.sub("ibi_[redacted]", value)


class P2AError(Exception):
    def __init__(
        self,
        code: str,
        *,
        retry_after: float | None = None,
        request_id: str | None = None,
        message: str | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(redact(message if message is not None else code))
        self.code = code
        self.retry_after = retry_after
        self.request_id = request_id
        self.status = status

    def __str__(self) -> str:
        return redact(f"{type(self).__name__}: {super().__str__()}")


class AuthError(P2AError):
    def __init__(self, message: str = "unauthorized") -> None:
        super().__init__("unauthorized", message=message, status=401)


class RateLimited(P2AError):
    def __init__(self, retry_after: float | None = None, request_id: str | None = None) -> None:
        super().__init__("rate_limited", retry_after=retry_after, request_id=request_id, message="rate_limited")


class ConfirmationRequired(P2AError):
    def __init__(self, recipient: str | None = None, request_id: str | None = None) -> None:
        super().__init__("confirmation_required", request_id=request_id, message="confirmation_required")
        self.recipient = recipient


class ConnectionDeclined(P2AError):
    def __init__(self, retry_after: float | None = None, request_id: str | None = None) -> None:
        super().__init__(
            "connection_declined",
            retry_after=retry_after,
            request_id=request_id,
            message="connection_declined",
        )


def is_retryable(err: BaseException) -> bool:
    if isinstance(err, (AuthError, ConfirmationRequired, ConnectionDeclined)):
        return False
    if isinstance(err, RateLimited):
        return True
    if isinstance(err, P2AError):
        if err.code == "network":
            return True
        if err.status in {408, 425, 429}:
            return True
        if err.status is not None and err.status >= 500:
            return True
    return False
