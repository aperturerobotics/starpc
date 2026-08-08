from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from typing import Protocol, Self, TypeAlias


class StreamClosedError(ConnectionError):
    """The byte stream has been closed."""


class ByteStream(Protocol):
    """One independently closable, bidirectional byte stream."""

    async def read(self, max_bytes: int) -> bytes:
        """Read at most max_bytes, returning empty bytes after peer half-close."""
        ...

    async def write(self, data: bytes) -> int:
        """Write a noninterleaved prefix and return the accepted byte count."""
        ...

    async def write_eof(self) -> None:
        """Half-close writes after all accepted bytes while retaining reads."""
        ...

    async def aclose(self) -> None:
        """Abort both directions and wake blocked local operations."""
        ...


class _Channel:
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.buffer: deque[bytes] = deque()
        self.size = 0
        self.eof = False
        self.closed = False
        self.condition = asyncio.Condition()

    async def write(self, data: bytes, max_write_size: int | None) -> int:
        async with self.condition:
            if self.closed or self.eof:
                raise StreamClosedError
            if not data:
                return 0
            while self.size >= self.capacity and not self.closed and not self.eof:
                await self.condition.wait()
            if self.closed or self.eof:
                raise StreamClosedError
            count = min(len(data), self.capacity - self.size)
            if max_write_size is not None:
                count = min(count, max_write_size)
            self.buffer.append(bytes(data[:count]))
            self.size += count
            self.condition.notify_all()
            return count

    async def read(self, max_bytes: int) -> bytes:
        async with self.condition:
            while not self.buffer and not self.eof and not self.closed:
                await self.condition.wait()
            if self.closed:
                raise StreamClosedError
            if not self.buffer:
                return b""
            remaining = max_bytes
            pieces: list[bytes] = []
            while self.buffer and remaining:
                chunk = self.buffer.popleft()
                piece, rest = chunk[:remaining], chunk[remaining:]
                pieces.append(piece)
                remaining -= len(piece)
                self.size -= len(piece)
                if rest:
                    self.buffer.appendleft(rest)
            self.condition.notify_all()
            return b"".join(pieces)

    async def finish(self) -> None:
        async with self.condition:
            if not self.closed:
                self.eof = True
                self.condition.notify_all()

    async def close(self) -> None:
        async with self.condition:
            self.closed = True
            self.buffer.clear()
            self.size = 0
            self.condition.notify_all()


class _MemoryStream:
    def __init__(
        self, inbound: _Channel, outbound: _Channel, max_write_size: int | None
    ) -> None:
        self._inbound = inbound
        self._outbound = outbound
        self._max_write_size = max_write_size
        self._closed = False

    async def read(self, max_bytes: int) -> bytes:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        return await self._inbound.read(max_bytes)

    async def write(self, data: bytes) -> int:
        if self._closed:
            raise StreamClosedError
        return await self._outbound.write(data, self._max_write_size)

    async def write_eof(self) -> None:
        if self._closed:
            return
        await self._outbound.finish()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._inbound.close()
        await self._outbound.close()


def memory_stream_pair(
    capacity_bytes: int, max_write_size: int | None = None
) -> tuple[ByteStream, ByteStream]:
    """Create two bounded endpoints whose writes feed the opposite reader."""
    if capacity_bytes <= 0:
        raise ValueError("capacity_bytes must be positive")
    if max_write_size is not None and max_write_size <= 0:
        raise ValueError("max_write_size must be positive")
    first_to_second = _Channel(capacity_bytes)
    second_to_first = _Channel(capacity_bytes)
    return (
        _MemoryStream(second_to_first, first_to_second, max_write_size),
        _MemoryStream(first_to_second, second_to_first, max_write_size),
    )


class TCPByteStream:
    """Adapt one asyncio TCP connection to the byte-stream contract."""

    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._write_lock = asyncio.Lock()
        self._closed = False
        self._eof = False

    async def read(self, max_bytes: int) -> bytes:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        if self._closed:
            raise StreamClosedError
        return await self._reader.read(max_bytes)

    async def write(self, data: bytes) -> int:
        async with self._write_lock:
            if self._closed or self._eof:
                raise StreamClosedError
            self._writer.write(data)
            await self._writer.drain()
            return len(data)

    async def write_eof(self) -> None:
        async with self._write_lock:
            if self._closed or self._eof:
                return
            self._eof = True
            self._writer.write_eof()
            await self._writer.drain()

    async def aclose(self) -> None:
        async with self._write_lock:
            if self._closed:
                return
            self._closed = True
            self._writer.close()
            await self._writer.wait_closed()


async def open_tcp_stream(host: str, port: int) -> TCPByteStream:
    """Open one independent TCP byte stream."""

    reader, writer = await asyncio.open_connection(host, port)
    return TCPByteStream(reader, writer)


Address: TypeAlias = tuple[str, int]


class TCPStreamServer:
    """Accept bounded TCP streams and transfer their cleanup to accept callers."""

    def __init__(self, max_pending_streams: int = 64) -> None:
        if max_pending_streams <= 0:
            raise ValueError("max_pending_streams must be positive")
        self._server: asyncio.Server | None = None
        self._streams: deque[TCPByteStream] = deque()
        self._waiters: deque[asyncio.Future[TCPByteStream]] = deque()
        self._max_pending_streams = max_pending_streams
        self._closed = False

    async def start(self, host: str = "127.0.0.1", port: int = 0) -> None:
        if self._server is not None:
            return
        self._server = await asyncio.start_server(self._on_connection, host, port)
        self._closed = False

    @property
    def address(self) -> Address:
        if self._server is None:
            raise RuntimeError("server is not started")
        if not self._server.sockets:
            raise RuntimeError("server has no address")
        sockname = self._server.sockets[0].getsockname()
        return str(sockname[0]), int(sockname[1])

    def _on_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        stream = TCPByteStream(reader, writer)
        if self._closed:
            writer.close()
            return
        while self._waiters:
            waiter = self._waiters.popleft()
            if not waiter.done():
                waiter.set_result(stream)
                return
        if len(self._streams) < self._max_pending_streams:
            self._streams.append(stream)
        else:
            writer.close()

    async def accept(self) -> TCPByteStream:
        """Transfer one accepted stream to a caller that must close it."""
        if self._closed:
            raise StreamClosedError
        if self._streams:
            return self._streams.popleft()
        waiter: asyncio.Future[TCPByteStream] = (
            asyncio.get_running_loop().create_future()
        )
        self._waiters.append(waiter)
        transferred = False
        try:
            stream = await waiter
            transferred = True
            return stream
        finally:
            if not waiter.done():
                waiter.cancel()
            with contextlib.suppress(ValueError):
                self._waiters.remove(waiter)
            if (
                waiter.done()
                and not waiter.cancelled()
                and waiter.exception() is None
                and not transferred
            ):
                await waiter.result().aclose()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        queued = list(self._streams)
        self._streams.clear()
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_exception(StreamClosedError())
        self._waiters.clear()
        await asyncio.gather(*(stream.aclose() for stream in queued))

    async def __aenter__(self) -> Self:
        if self._server is None:
            await self.start()
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        await self.aclose()


__all__ = [
    "ByteStream",
    "StreamClosedError",
    "TCPByteStream",
    "TCPStreamServer",
    "memory_stream_pair",
    "open_tcp_stream",
]
