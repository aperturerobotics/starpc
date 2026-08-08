from __future__ import annotations

import asyncio
import unittest
from collections.abc import AsyncIterator

from google.protobuf.empty_pb2 import Empty

from starpc.call import CallCancelledError
from starpc.service import (
    MethodDescriptor,
    MethodKind,
    ServiceDescriptor,
    bidirectional_bytes,
)


class FakeCall:
    def __init__(self) -> None:
        self.responses: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.sent: list[bytes] = []
        self.finished = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.closed = asyncio.Event()

    async def send(self, data: bytes) -> None:
        self.sent.append(data)

    async def finish(self, data: bytes | None = None, error: str | None = None) -> None:
        self.finished.set()

    async def receive(self) -> bytes | None:
        if self.cancelled.is_set():
            raise CallCancelledError
        return await self.responses.get()

    async def cancel(self) -> None:
        self.cancelled.set()

    async def aclose(self) -> None:
        self.closed.set()


async def next_item(stream: AsyncIterator[bytes]) -> bytes:
    return await anext(stream)


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    def test_method_kinds_and_frozen_metadata(self) -> None:
        flags = [
            (False, False, MethodKind.UNARY),
            (False, True, MethodKind.SERVER_STREAMING),
            (True, False, MethodKind.CLIENT_STREAMING),
            (True, True, MethodKind.BIDIRECTIONAL),
        ]
        methods = tuple(
            MethodDescriptor(f"m{index}", Empty, Empty, client, server)
            for index, (client, server, _) in enumerate(flags)
        )
        self.assertEqual(
            [method.kind for method in methods], [kind for _, _, kind in flags]
        )
        descriptor = ServiceDescriptor("acme.Echo", methods)
        with self.assertRaises(AttributeError):
            descriptor.name = "other"  # type: ignore[misc]
        with self.assertRaises(ValueError):
            ServiceDescriptor("acme.Echo", (methods[0], methods[0]))

    async def test_bidirectional_interleaving_sends_and_finishes(self) -> None:
        call = FakeCall()
        first_sent = asyncio.Event()
        release_second = asyncio.Event()

        async def requests() -> AsyncIterator[bytes]:
            yield b"one"
            first_sent.set()
            await release_second.wait()
            yield b"two"

        stream = bidirectional_bytes(call, requests())
        first = asyncio.create_task(next_item(stream))
        await first_sent.wait()
        await call.responses.put(b"out-one")
        self.assertEqual(await first, b"out-one")
        release_second.set()
        await call.responses.put(b"out-two")
        self.assertEqual(await anext(stream), b"out-two")
        await call.finished.wait()
        await call.responses.put(None)
        with self.assertRaises(StopAsyncIteration):
            await anext(stream)
        self.assertEqual(call.sent, [b"one", b"two"])
        self.assertTrue(call.closed.is_set())

    async def test_sender_failure_cancels_call_and_propagates_original(self) -> None:
        call = FakeCall()

        async def requests() -> AsyncIterator[bytes]:
            yield b"before"
            raise RuntimeError("request failure")

        stream = bidirectional_bytes(call, requests())
        with self.assertRaisesRegex(RuntimeError, "request failure"):
            await anext(stream)
        self.assertTrue(call.cancelled.is_set())
        self.assertTrue(call.closed.is_set())

    async def test_remote_completion_cancels_blocked_sender(self) -> None:
        call = FakeCall()
        request_cancelled = asyncio.Event()
        request_started = asyncio.Event()

        async def requests() -> AsyncIterator[bytes]:
            request_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                request_cancelled.set()
                raise
            yield b"never"

        stream = bidirectional_bytes(call, requests())
        first = asyncio.create_task(next_item(stream))
        await request_started.wait()
        await call.responses.put(None)
        with self.assertRaises(StopAsyncIteration):
            await first
        self.assertTrue(request_cancelled.is_set())
        self.assertTrue(call.closed.is_set())

    async def test_consumer_break_closes_call_and_joins_sender(self) -> None:
        call = FakeCall()
        request_cancelled = asyncio.Event()

        async def requests() -> AsyncIterator[bytes]:
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                request_cancelled.set()
                raise
            yield b"never"

        stream = bidirectional_bytes(call, requests())
        first = asyncio.create_task(next_item(stream))
        await call.responses.put(b"response")
        self.assertEqual(await first, b"response")
        await stream.aclose()
        self.assertTrue(request_cancelled.is_set())
        self.assertTrue(call.closed.is_set())


if __name__ == "__main__":
    unittest.main()
