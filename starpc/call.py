from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from typing import Self

from srpc import rpcproto_pb2
from starpc.codec import (
    AsyncPacketWriter,
    CodecError,
    PacketDecoder,
    TruncatedFrameError,
)
from starpc.stream import ByteStream, StreamClosedError


class CallError(Exception):
    """Base class for call failures."""


class CallCompletedError(CallError):
    """The local call has already reached a terminal state."""


class CallCancelledError(CallError):
    """The call was cancelled by either endpoint."""


class RemoteCallError(CallError):
    """The remote endpoint completed the call with an error."""


class ClosedBeforeCompletionError(CallError):
    """The transport closed before a remote terminal packet arrived."""


class CallProtocolError(CallError):
    """The peer sent malformed or out-of-sequence call data."""


class _PacketIO:
    def __init__(self, stream: ByteStream) -> None:
        self.stream = stream
        self.decoder = PacketDecoder()
        self.writer = AsyncPacketWriter(stream)
        self.pending: deque[rpcproto_pb2.Packet] = deque()

    async def read_packet(self) -> rpcproto_pb2.Packet:
        if self.pending:
            return self.pending.popleft()
        while True:
            data = await self.stream.read(65536)
            if not data:
                self.decoder.finish()
                raise EOFError
            packets = self.decoder.feed(data)
            if packets:
                self.pending.extend(packets[1:])
                return packets[0]

    async def write_packet(self, packet: rpcproto_pb2.Packet) -> None:
        await self.writer.write(packet)


class Call:
    def __init__(
        self,
        io: _PacketIO,
        service: str,
        method: str,
        inbound_capacity: int,
        accepted: bool = False,
    ) -> None:
        self._io = io
        self._accepted = accepted
        self._service = service
        self._method = method
        self._capacity = inbound_capacity
        self._messages: deque[bytes] = deque()
        self._condition = asyncio.Condition()
        self._send_lock = asyncio.Lock()
        self._remote_terminal = False
        self._remote_error: CallError | None = None
        self._abort_error: CallError | None = None
        self._aborted = asyncio.Event()
        self._local_terminal = False
        self._cancelled = False
        self._closed = False
        self._receiver_ready = asyncio.Event()
        self._receiver: asyncio.Task[None] | None = None

    @classmethod
    async def open(
        cls,
        stream: ByteStream,
        service: str,
        method: str,
        initial_data: bytes | None = None,
        inbound_capacity: int = 1,
    ) -> Self:
        if not service or not method:
            raise ValueError("service and method are required")
        if inbound_capacity <= 0:
            raise ValueError("inbound_capacity must be positive")
        call = cls(_PacketIO(stream), service, method, inbound_capacity)
        data_is_zero = initial_data is not None and len(initial_data) == 0
        packet = rpcproto_pb2.Packet(
            call_start=rpcproto_pb2.CallStart(
                rpc_service=service,
                rpc_method=method,
                data=initial_data or b"",
                data_is_zero=data_is_zero,
            )
        )
        try:
            await call._io.write_packet(packet)
            await call._start_receiver()
        except BaseException:
            await call.aclose()
            raise
        return call

    @classmethod
    async def accept(cls, stream: ByteStream, inbound_capacity: int = 1) -> Self:
        if inbound_capacity <= 0:
            raise ValueError("inbound_capacity must be positive")
        io = _PacketIO(stream)
        try:
            packet = await io.read_packet()
            if packet.WhichOneof("body") != "call_start" or packet.call_start is None:
                raise CallProtocolError("first packet must be call start")
            start = packet.call_start
            call = cls(
                io, start.rpc_service, start.rpc_method, inbound_capacity, accepted=True
            )
            if start.data or start.data_is_zero:
                call._messages.append(bytes(start.data))
            await call._start_receiver()
            return call
        except BaseException:
            await stream.aclose()
            raise

    async def _start_receiver(self) -> None:
        if self._receiver is not None:
            return
        self._receiver = asyncio.create_task(self._receive_packets())
        await self._receiver_ready.wait()

    @property
    def service(self) -> str:
        return self._service

    @property
    def method(self) -> str:
        return self._method

    async def _receive_packets(self) -> None:
        self._receiver_ready.set()
        try:
            while True:
                try:
                    packet = await self._io.read_packet()
                except EOFError:
                    async with self._condition:
                        if (
                            not (self._accepted and self._local_terminal)
                            and not self._remote_terminal
                            and self._remote_error is None
                        ):
                            self._set_abort_locked(ClosedBeforeCompletionError())
                        self._remote_terminal = True
                        self._condition.notify_all()
                    return
                except (CodecError, TruncatedFrameError, ValueError) as exc:
                    await self._set_protocol_error(exc)
                    return
                except StreamClosedError:
                    async with self._condition:
                        if (
                            not (self._accepted and self._local_terminal)
                            and not self._remote_terminal
                            and self._remote_error is None
                        ):
                            self._set_abort_locked(ClosedBeforeCompletionError())
                        self._remote_terminal = True
                        self._condition.notify_all()
                    return
                try:
                    await self._handle_packet(packet)
                except CallProtocolError as exc:
                    await self._set_protocol_error(exc)
                    return
        except asyncio.CancelledError:
            raise
        except (TypeError, ValueError, RuntimeError) as exc:
            await self._set_protocol_error(exc)

    async def _set_protocol_error(self, error: BaseException) -> None:
        async with self._condition:
            failure = (
                error if isinstance(error, CallError) else CallProtocolError(str(error))
            )
            self._set_abort_locked(failure)
            self._remote_terminal = True
            self._condition.notify_all()

    def _set_abort_locked(self, error: CallError) -> None:
        if self._abort_error is None:
            self._abort_error = error
            self._remote_error = error
        self._aborted.set()

    async def _handle_packet(self, packet: rpcproto_pb2.Packet) -> None:
        body = packet.WhichOneof("body")
        if body == "call_cancel":
            if not packet.call_cancel:
                return
            async with self._condition:
                self._set_abort_locked(CallCancelledError())
                self._remote_terminal = True
                self._condition.notify_all()
            return
        if body != "call_data" or packet.call_data is None:
            raise CallProtocolError("unexpected call packet")
        data = packet.call_data
        if (
            not data.data
            and not data.data_is_zero
            and not data.complete
            and not data.error
        ):
            raise CallProtocolError("empty nonterminal call data")
        async with self._condition:
            if self._remote_terminal:
                if (
                    data.complete
                    and not data.data
                    and not data.data_is_zero
                    and not data.error
                ):
                    return
                raise CallProtocolError("packet after completion")
            if data.data or data.data_is_zero:
                while len(self._messages) >= self._capacity and not self._closed:
                    await self._condition.wait()
                if self._closed:
                    return
                self._messages.append(bytes(data.data))
            if data.error:
                self._remote_error = RemoteCallError(data.error)
                self._remote_terminal = True
                self._condition.notify_all()
            elif data.complete:
                self._remote_terminal = True
            self._condition.notify_all()

    async def send(self, data: bytes) -> None:
        async with self._send_lock:
            self._ensure_writable()
            await self._io.write_packet(
                rpcproto_pb2.Packet(
                    call_data=rpcproto_pb2.CallData(
                        data=data, data_is_zero=len(data) == 0
                    )
                )
            )

    async def finish(self, data: bytes | None = None, error: str | None = None) -> None:
        async with self._send_lock:
            if self._local_terminal:
                if data is None and error is None:
                    return
                raise CallCompletedError
            self._local_terminal = True
            packet = rpcproto_pb2.Packet(
                call_data=rpcproto_pb2.CallData(
                    data=data or b"",
                    data_is_zero=data is not None and len(data) == 0,
                    complete=True,
                    error=error or "",
                )
            )
            try:
                await self._io.write_packet(packet)
            except (OSError, StreamClosedError, CodecError):
                await self._mark_closed()
                raise
            try:
                await self._io.stream.write_eof()
            except (OSError, StreamClosedError):
                pass

    async def receive(self) -> bytes | None:
        async with self._condition:
            while not self._messages and not self._remote_terminal and not self._closed:
                await self._condition.wait()
            if self._messages:
                value = self._messages.popleft()
                self._condition.notify_all()
                return value
            if self._remote_error is not None:
                raise self._remote_error
            if self._closed:
                raise CallCancelledError
            return None

    async def cancel(self) -> None:
        async with self._send_lock:
            if self._cancelled:
                return
            if self._local_terminal:
                raise CallCompletedError
            self._cancelled = True
            self._local_terminal = True
            async with self._condition:
                self._remote_error = CallCancelledError()
                self._remote_terminal = True
                self._condition.notify_all()
            try:
                await self._io.write_packet(rpcproto_pb2.Packet(call_cancel=True))
                await self._io.stream.write_eof()
            except (StreamClosedError, OSError):
                pass
        await self._cancel_receiver()

    async def _cancel_receiver(self) -> None:
        receiver = self._receiver
        if receiver is None or receiver is asyncio.current_task():
            return
        if not receiver.done():
            receiver.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await receiver

    async def wait_closed(self) -> None:
        receiver = self._receiver
        if receiver is not None and receiver is not asyncio.current_task():
            with contextlib.suppress(asyncio.CancelledError):
                await receiver
        if self._remote_error is not None:
            raise self._remote_error

    async def wait_aborted(self) -> None:
        await self._aborted.wait()
        if self._abort_error is not None:
            raise self._abort_error

    async def aclose(self) -> None:
        if self._closed:
            return
        if not self._local_terminal and not self._remote_terminal:
            try:
                await self.cancel()
            except CallCompletedError:
                pass
        self._closed = True
        async with self._condition:
            self._condition.notify_all()
        if self._receiver is not None:
            if not self._receiver.done():
                self._receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._receiver
        await self._io.stream.aclose()

    async def _mark_closed(self) -> None:
        self._closed = True
        async with self._condition:
            self._condition.notify_all()

    def _ensure_writable(self) -> None:
        if self._local_terminal or self._closed:
            raise CallCompletedError


__all__ = [
    "Call",
    "CallCancelledError",
    "CallCompletedError",
    "CallError",
    "CallProtocolError",
    "ClosedBeforeCompletionError",
    "RemoteCallError",
]
