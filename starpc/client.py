from __future__ import annotations

from collections.abc import Awaitable, Callable

from starpc.call import Call
from starpc.stream import ByteStream

StreamOpener = Callable[[], Awaitable[ByteStream]]


class Client:
    def __init__(self, opener: StreamOpener, inbound_capacity: int = 1) -> None:
        if inbound_capacity <= 0:
            raise ValueError("inbound_capacity must be positive")
        self._opener = opener
        self._inbound_capacity = inbound_capacity

    async def open_call(
        self,
        service: str,
        method: str,
        initial_data: bytes | None = None,
    ) -> Call:
        stream = await self._opener()
        return await Call.open(
            stream,
            service,
            method,
            initial_data=initial_data,
            inbound_capacity=self._inbound_capacity,
        )


__all__ = ["Client", "StreamOpener"]
