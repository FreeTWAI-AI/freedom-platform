"""FW-05 pure fake settlement provider (fixture-defined interface).

Supports only accept / confirm / unknown so retry and reconcile stay local.
No network, no real money, no provider sandbox.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

FakeResponse = Literal["accept", "confirm", "unknown"]
ALLOWED_RESPONSES = frozenset({"accept", "confirm", "unknown"})


@dataclass
class FakeSettlementProvider:
    scripted: list[FakeResponse] = field(default_factory=list)
    calls: list[dict[str, Any]] = field(default_factory=list)
    _cursor: int = 0
    _last_by_key: dict[str, FakeResponse] = field(default_factory=dict)

    def _next(self, operation_key: str) -> FakeResponse:
        if self._cursor < len(self.scripted):
            response = self.scripted[self._cursor]
            self._cursor += 1
        else:
            response = self._last_by_key.get(operation_key, "unknown")
        if response not in ALLOWED_RESPONSES:
            raise ValueError(f"unsupported fake provider response: {response!r}")
        self._last_by_key[operation_key] = response
        return response

    def submit_transfer(self, *, operation_key: str, payload: dict[str, Any]) -> FakeResponse:
        if not operation_key:
            raise ValueError("operation_key is required")
        response = self._next(operation_key)
        self.calls.append(
            {
                "method": "submit_transfer",
                "operation_key": operation_key,
                "payload": dict(payload),
                "response": response,
            }
        )
        return response

    def query_transfer(self, *, operation_key: str) -> FakeResponse:
        if not operation_key:
            raise ValueError("operation_key is required")
        response = self._next(operation_key)
        self.calls.append(
            {
                "method": "query_transfer",
                "operation_key": operation_key,
                "response": response,
            }
        )
        return response
