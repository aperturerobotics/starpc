from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncGenerator, AsyncIterable
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, TypeVar

from google.protobuf.message import Message

from starpc.call import CallError


class MethodKind(StrEnum):
    UNARY = "unary"
    SERVER_STREAMING = "server_streaming"
    CLIENT_STREAMING = "client_streaming"
    BIDIRECTIONAL = "bidirectional"


MessageType = type[Message]


@dataclass(frozen=True)
class MethodDescriptor:
    name: str
    input_type: MessageType
    output_type: MessageType
    client_streaming: bool = False
    server_streaming: bool = False

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("method name is required")

    @property
    def kind(self) -> MethodKind:
        if self.client_streaming and self.server_streaming:
            return MethodKind.BIDIRECTIONAL
        if self.client_streaming:
            return MethodKind.CLIENT_STREAMING
        if self.server_streaming:
            return MethodKind.SERVER_STREAMING
        return MethodKind.UNARY


@dataclass(frozen=True)
class ServiceDescriptor:
    name: str
    methods: tuple[MethodDescriptor, ...]

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("service name is required")
        names = [method.name for method in self.methods]
        if len(names) != len(set(names)):
            raise ValueError("method names must be unique")


class _ByteCall(Protocol):
    async def send(self, data: bytes) -> None: ...
    async def finish(
        self, data: bytes | None = None, error: str | None = None
    ) -> None: ...
    async def receive(self) -> bytes | None: ...
    async def cancel(self) -> None: ...
    async def aclose(self) -> None: ...


TCall = TypeVar("TCall", bound=_ByteCall)


async def bidirectional_bytes(
    call: TCall, requests: AsyncIterable[bytes]
) -> AsyncGenerator[bytes, None]:
    sender = asyncio.create_task(_send_requests(call, requests))
    receiver: asyncio.Task[bytes | None] | None = None
    try:
        while True:
            receiver = asyncio.create_task(call.receive())
            done, _ = await asyncio.wait(
                (sender, receiver), return_when=asyncio.FIRST_COMPLETED
            )
            if sender in done:
                if sender.cancelled() or sender.exception() is not None:
                    receiver.cancel()
                    await _join_receiver(receiver)
                await sender
            response = await receiver
            receiver = None
            if response is None:
                if not sender.done():
                    sender.cancel()
                await _join_sender(sender)
                return
            yield response
    finally:
        if receiver is not None and not receiver.done():
            receiver.cancel()
        await _join_receiver(receiver)
        if not sender.done():
            sender.cancel()
        await _join_sender(sender)
        await call.aclose()


async def _send_requests(call: _ByteCall, requests: AsyncIterable[bytes]) -> None:
    try:
        async for request in requests:
            await call.send(request)
        await call.finish()
    except asyncio.CancelledError:
        raise
    except Exception:
        with contextlib.suppress(CallError):
            await call.cancel()
        raise


async def _join_task(task: asyncio.Task[object] | None) -> None:
    if task is None:
        return
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def _join_receiver(task: asyncio.Task[bytes | None] | None) -> None:
    if task is None:
        return
    with contextlib.suppress(asyncio.CancelledError, CallError):
        await task


async def _join_sender(sender: asyncio.Task[None]) -> None:
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await sender


__all__ = [
    "MethodDescriptor",
    "MethodKind",
    "ServiceDescriptor",
    "bidirectional_bytes",
]
