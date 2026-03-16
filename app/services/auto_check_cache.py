from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Generic, TypeVar


T = TypeVar("T")


@dataclass(frozen=True)
class CacheItem(Generic[T]):
    value: T
    expires_at: float


class TtlCache(Generic[T]):
    def __init__(self, *, max_items: int = 256) -> None:
        self._max_items = max(1, int(max_items))
        self._items: dict[str, CacheItem[T]] = {}

    def get(self, key: str) -> T | None:
        item = self._items.get(key)
        if not item:
            return None
        if item.expires_at < time.time():
            self._items.pop(key, None)
            return None
        return item.value

    def set(self, key: str, value: T, *, ttl_seconds: int) -> None:
        if ttl_seconds <= 0:
            return
        if len(self._items) >= self._max_items:
            # Best-effort eviction: drop an arbitrary key.
            self._items.pop(next(iter(self._items)))
        self._items[key] = CacheItem(value=value, expires_at=time.time() + ttl_seconds)

    def clear(self) -> None:
        self._items.clear()

