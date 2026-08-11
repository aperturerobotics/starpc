from __future__ import annotations

import asyncio
import contextlib
from collections.abc import (
    AsyncGenerator,
    AsyncIterable,
    AsyncIterator,
    Awaitable,
    Callable,
)
from dataclasses import dataclass, field
from typing import TypeAlias

from google.protobuf.message import DecodeError

from rpcstream import rpcstream_pb2
from srpc import rpcproto_pb2
from starpc.call import CallError
from starpc.codec import (
    CodecError,
    PacketDecoder,
    WriteCountError,
    ZeroProgressError,
    encode_packet,
)
from starpc.server import Server
from starpc.stream import ByteStream, StreamClosedError, memory_stream_pair

DEFAULT_INNER_CAPACITY = 65_536


class RpcStreamError(Exception):
    """Base class for nested RPC stream failures."""


class RpcStreamProtocolError(RpcStreamError):
    """The peer sent an invalid nested RPC stream packet."""


class RpcStreamRemoteError(RpcStreamError):
    """The remote endpoint rejected a nested RPC stream."""


class ComponentNotFoundError(RpcStreamError):
    """The requested component is not registered."""


RpcStreamCaller: TypeAlias = Callable[
    [AsyncIterable[rpcstream_pb2.RpcStreamPacket]],
    AsyncIterator[rpcstream_pb2.RpcStreamPacket],
]
LeaseRelease: TypeAlias = Callable[[], Awaitable[None] | None]


async def _write_all(stream: ByteStream, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        remaining = len(data) - offset
        written = await stream.write(data[offset:])
        if written <= 0:
            raise ZeroProgressError("writer made no progress")
        if written > remaining:
            raise WriteCountError("writer exceeded supplied bytes")
        offset += written


def _frame_inner_packet(data: bytes) -> bytes:
    try:
        packet = rpcproto_pb2.Packet.FromString(data)
    except DecodeError as exc:
        raise RpcStreamProtocolError("malformed nested packet") from exc
    try:
        return encode_packet(packet)
    except CodecError as exc:
        raise RpcStreamProtocolError("invalid nested packet") from exc


def _unframe_inner_packet(packet: rpcproto_pb2.Packet) -> rpcstream_pb2.RpcStreamPacket:
    return rpcstream_pb2.RpcStreamPacket(
        data=packet.SerializeToString(deterministic=True)
    )


class _ClientStream:
    def __init__(
        self,
        stream: ByteStream,
        peer: ByteStream,
        responses: asyncio.Task[None],
    ) -> None:
        self._stream = stream
        self._peer = peer
        self._responses = responses
        self._closed = False
        self._close_lock = asyncio.Lock()

    async def read(self, max_bytes: int) -> bytes:
        return await self._stream.read(max_bytes)

    async def write(self, data: bytes) -> int:
        return await self._stream.write(data)

    async def write_eof(self) -> None:
        await self._stream.write_eof()

    async def aclose(self) -> None:
        async with self._close_lock:
            if self._closed:
                return
            self._closed = True
            await self._stream.aclose()
            await self._peer.aclose()
            if not self._responses.done():
                self._responses.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._responses


async def _open_rpc_stream(
    component_id: str,
    caller: RpcStreamCaller,
    capacity_bytes: int,
) -> ByteStream:
    stream, peer = memory_stream_pair(capacity_bytes)
    acknowledged = asyncio.Event()

    async def requests() -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
        yield rpcstream_pb2.RpcStreamPacket(
            init=rpcstream_pb2.RpcStreamInit(component_id=component_id)
        )
        await acknowledged.wait()
        decoder = PacketDecoder()
        try:
            while True:
                data = await peer.read(65_536)
                if not data:
                    decoder.finish()
                    return
                for packet in decoder.feed(data):
                    yield _unframe_inner_packet(packet)
        except StreamClosedError:
            return
        except CodecError as exc:
            raise RpcStreamProtocolError("truncated nested packet") from exc

    responses = caller(requests()).__aiter__()
    try:
        first = await anext(responses)
        if first.WhichOneof("body") != "ack":
            raise RpcStreamProtocolError("expected nested stream acknowledgement")
        if first.ack.error:
            raise RpcStreamRemoteError(first.ack.error)
        acknowledged.set()

        async def copy_responses() -> None:
            try:
                async for response in responses:
                    if response.WhichOneof("body") != "data":
                        raise RpcStreamProtocolError("unexpected nested stream packet")
                    await _write_all(peer, _frame_inner_packet(bytes(response.data)))
                await peer.write_eof()
            except StreamClosedError:
                await peer.aclose()
            except BaseException:
                await peer.aclose()
                raise

        response_task = asyncio.create_task(copy_responses())
        return _ClientStream(stream, peer, response_task)
    except BaseException:
        await stream.aclose()
        await peer.aclose()
        if isinstance(responses, AsyncGenerator):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await responses.aclose()
        raise


def build_rpc_stream_open_stream(
    component_id: str,
    caller: RpcStreamCaller,
    capacity_bytes: int = DEFAULT_INNER_CAPACITY,
) -> Callable[[], Awaitable[ByteStream]]:
    """Build an opener that sends one acknowledged nested stream per inner call."""
    if not component_id:
        raise ValueError("component ID is required")
    if capacity_bytes <= 0:
        raise ValueError("capacity_bytes must be positive")

    async def open_stream() -> ByteStream:
        return await _open_rpc_stream(component_id, caller, capacity_bytes)

    return open_stream


@dataclass
class _Component:
    server: Server
    on_release: LeaseRelease | None
    routes: set[_ServerRoute] = field(default_factory=set)
    drained: asyncio.Event = field(default_factory=asyncio.Event)
    closing: bool = False

    def __post_init__(self) -> None:
        self.drained.set()


class ComponentRegistry:
    """Route named nested streams to registered inner StarPC servers."""

    def __init__(self, capacity_bytes: int = DEFAULT_INNER_CAPACITY) -> None:
        if capacity_bytes <= 0:
            raise ValueError("capacity_bytes must be positive")
        self._capacity_bytes = capacity_bytes
        self._components: dict[str, _Component] = {}
        self._retired: dict[str, _Component] = {}
        self._lock = asyncio.Lock()

    async def register(
        self,
        component_id: str,
        server: Server,
        on_release: LeaseRelease | None = None,
    ) -> None:
        """Register one component ID before it accepts nested streams."""
        if not component_id:
            raise ValueError("component ID is required")
        async with self._lock:
            if component_id in self._components or component_id in self._retired:
                raise ValueError("component ID is already registered")
            self._components[component_id] = _Component(server, on_release)

    async def unregister(self, component_id: str) -> None:
        """Invalidate one component and wait for every acquired route to settle."""
        async with self._lock:
            component = self._components.pop(component_id, None)
            if component is not None:
                component.closing = True
                self._retired[component_id] = component
            else:
                component = self._retired.get(component_id)
            if component is None:
                return
            routes = tuple(component.routes)

        for route in routes:
            await route.cancel()
        await component.drained.wait()
        async with self._lock:
            if self._retired.get(component_id) is component:
                del self._retired[component_id]

    async def _acquire(self, component_id: str) -> _ServerRoute:
        async with self._lock:
            component = self._components.get(component_id)
            if component is None or component.closing:
                raise ComponentNotFoundError(f"unknown component: {component_id}")
            route = _ServerRoute(
                component.server, component.on_release, self._capacity_bytes
            )
            component.routes.add(route)
            component.drained.clear()
            route._component = component
            return route

    async def _release(self, route: _ServerRoute) -> None:
        component = route._component
        if component is None:
            return
        async with self._lock:
            component.routes.discard(route)
            if not component.routes:
                component.drained.set()


class _ServerRoute:
    def __init__(
        self,
        server: Server,
        on_release: LeaseRelease | None,
        capacity_bytes: int,
    ) -> None:
        self._server = server
        self._on_release = on_release
        self._client, self._server_stream = memory_stream_pair(capacity_bytes)
        self._component: _Component | None = None
        self._input_task: asyncio.Task[None] | None = None
        self._server_task: asyncio.Task[None] | None = None
        self._closed = False
        self._cancelled = False
        self._released = False
        self._failure: BaseException | None = None
        self._close_lock = asyncio.Lock()

    def start(self, requests: AsyncIterator[rpcstream_pb2.RpcStreamPacket]) -> None:
        self._server_task = asyncio.create_task(self._run_server())
        self._input_task = asyncio.create_task(self._run_input(requests))

    def _remember_failure(self, error: BaseException) -> None:
        if isinstance(
            error, (asyncio.CancelledError, StreamClosedError, EOFError, CallError)
        ):
            return
        if self._failure is None:
            self._failure = error

    async def _run_server(self) -> None:
        try:
            await self._server.serve(self._server_stream)
        except BaseException as exc:
            self._remember_failure(exc)
            raise

    async def _run_input(
        self, requests: AsyncIterator[rpcstream_pb2.RpcStreamPacket]
    ) -> None:
        try:
            await self._copy_requests(requests)
        except BaseException as exc:
            self._remember_failure(exc)
            raise

    async def _copy_requests(
        self, requests: AsyncIterator[rpcstream_pb2.RpcStreamPacket]
    ) -> None:
        try:
            async for request in requests:
                if request.WhichOneof("body") != "data":
                    raise RpcStreamProtocolError("unexpected nested stream packet")
                await _write_all(self._client, _frame_inner_packet(bytes(request.data)))
            await self._client.write_eof()
        except BaseException:
            await self._client.aclose()
            raise

    async def responses(self) -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
        decoder = PacketDecoder()
        while True:
            try:
                data = await self._client.read(65_536)
            except StreamClosedError:
                if self._cancelled:
                    raise
                return
            if not data:
                decoder.finish()
                return
            for packet in decoder.feed(data):
                yield _unframe_inner_packet(packet)

    async def _close_streams(self) -> None:
        await self._client.aclose()
        await self._server_stream.aclose()

    async def cancel(self) -> None:
        """Wake both pumps after the registry has removed the component."""
        self._cancelled = True
        await self._close_streams()

    async def aclose(self) -> None:
        async with self._close_lock:
            if self._closed:
                return
            self._closed = True
            await self._close_streams()
            for task in (self._input_task, self._server_task):
                if task is not None and not task.done():
                    task.cancel()
            for task in (self._input_task, self._server_task):
                if task is not None:
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
            if not self._released:
                self._released = True
                if self._on_release is not None:
                    result = self._on_release()
                    if result is not None:
                        await result
            if self._failure is not None and not self._cancelled:
                raise self._failure


async def handle_rpc_stream(
    requests: AsyncIterator[rpcstream_pb2.RpcStreamPacket],
    components: ComponentRegistry,
) -> AsyncGenerator[rpcstream_pb2.RpcStreamPacket, None]:
    """Acknowledge one component and proxy its framed packets through a Server."""
    try:
        first = await anext(requests)
    except StopAsyncIteration as exc:
        raise RpcStreamProtocolError(
            "closed before nested stream initialization"
        ) from exc
    if first.WhichOneof("body") != "init":
        raise RpcStreamProtocolError("expected nested stream initialization")
    component_id = first.init.component_id
    try:
        route = await components._acquire(component_id)
    except ComponentNotFoundError as exc:
        yield rpcstream_pb2.RpcStreamPacket(ack=rpcstream_pb2.RpcAck(error=str(exc)))
        return

    try:
        route.start(requests)
        yield rpcstream_pb2.RpcStreamPacket(ack=rpcstream_pb2.RpcAck())
        async for response in route.responses():
            yield response
    finally:
        try:
            await route.aclose()
        finally:
            await components._release(route)


__all__ = [
    "DEFAULT_INNER_CAPACITY",
    "ComponentNotFoundError",
    "ComponentRegistry",
    "RpcStreamError",
    "RpcStreamProtocolError",
    "RpcStreamRemoteError",
    "build_rpc_stream_open_stream",
    "handle_rpc_stream",
]
