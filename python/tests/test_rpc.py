from __future__ import annotations

import asyncio
import contextlib
import unittest
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any, TypeVar

T = TypeVar("T")

from starpc.call import Call, CallProtocolError, RemoteCallError
from starpc.client import Client
from starpc.server import Server, ServiceRegistry
from starpc.stream import ByteStream, memory_stream_pair


class RpcRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tasks: set[asyncio.Task[Any]] = set()
        self.streams: list[ByteStream] = []

    async def asyncTearDown(self) -> None:
        for stream in self.streams:
            await stream.aclose()
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def track(self, awaitable: Coroutine[Any, Any, T]) -> asyncio.Task[T]:
        task = asyncio.create_task(awaitable)
        self.tasks.add(task)
        return task

    async def runtime(
        self, handler: Callable[[Call], Awaitable[None]], method: str = "method"
    ) -> tuple[Client, Callable[[], asyncio.Task[Any]]]:
        registry = ServiceRegistry()
        registry.register("svc", method, handler)
        server = Server(registry, inbound_capacity=1)
        pending: list[asyncio.Task[Any]] = []

        async def opener() -> ByteStream:
            client_stream, server_stream = memory_stream_pair(4096)
            self.streams.extend((client_stream, server_stream))
            pending.append(self.track(server.serve(server_stream)))
            return client_stream

        return Client(opener, inbound_capacity=1), lambda: pending.pop(0)

    async def test_unary_empty_and_nonempty_terminal_order(self) -> None:
        async def handler(call: Call) -> None:
            self.assertEqual(call.service, "svc")
            self.assertEqual(call.method, "method")
            self.assertEqual(await call.receive(), b"request")
            await call.send(b"response")

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method", initial_data=b"request")
        self.assertEqual(await call.receive(), b"response")
        self.assertIsNone(await call.receive())
        await call.aclose()
        await server_task()

    async def test_server_closes_after_terminal_without_peer_eof(self) -> None:
        async def handler(call: Call) -> None:
            self.assertEqual(await call.receive(), b"request")
            await call.send(b"response")

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method", initial_data=b"request")
        self.assertEqual(await call.receive(), b"response")
        self.assertIsNone(await call.receive())
        await asyncio.wait_for(server_task(), 1)
        await call.aclose()

    async def test_server_streaming_emits_each_message_and_explicit_finish(
        self,
    ) -> None:
        async def handler(call: Call) -> None:
            self.assertEqual(await call.receive(), b"")
            await call.send(b"one")
            await call.send(b"two")
            await call.finish()

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method", initial_data=b"")
        self.assertEqual(await call.receive(), b"one")
        self.assertEqual(await call.receive(), b"two")
        self.assertIsNone(await call.receive())
        await call.aclose()
        await server_task()

    async def test_client_streaming_receives_order_and_finishes(self) -> None:
        async def handler(call: Call) -> None:
            values = [await call.receive(), await call.receive(), await call.receive()]
            self.assertEqual(values, [b"one", b"two", b"three"])
            self.assertIsNone(await call.receive())
            await call.finish(b"done")

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method")
        await call.send(b"one")
        await call.send(b"two")
        await call.send(b"three")
        await call.finish()
        self.assertEqual(await call.receive(), b"done")
        self.assertIsNone(await call.receive())
        await call.aclose()
        await server_task()

    async def test_bidirectional_messages_are_independent_and_ordered(self) -> None:
        async def handler(call: Call) -> None:
            first = await call.receive()
            if first is None:
                self.fail("expected first message")
            await call.send(first.upper())
            second = await call.receive()
            if second is None:
                self.fail("expected second message")
            await call.send(second.upper())
            await call.finish()

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method")
        await call.send(b"left")
        self.assertEqual(await call.receive(), b"LEFT")
        await call.send(b"right")
        self.assertEqual(await call.receive(), b"RIGHT")
        await call.finish()
        self.assertIsNone(await call.receive())
        await call.aclose()
        await server_task()

    async def test_concurrent_calls_use_one_opened_stream_each(self) -> None:
        seen: list[bytes] = []

        async def handler(call: Call) -> None:
            value = await call.receive()
            if value is None:
                self.fail("expected initial message")
            seen.append(value)
            await call.finish(value.upper())

        client, server_task = await self.runtime(handler)
        first, second = await asyncio.gather(
            client.open_call("svc", "method", initial_data=b"first"),
            client.open_call("svc", "method", initial_data=b"second"),
        )
        self.assertEqual(await first.receive(), b"FIRST")
        self.assertEqual(await second.receive(), b"SECOND")
        self.assertIsNone(await first.receive())
        self.assertIsNone(await second.receive())
        await first.aclose()
        await second.aclose()
        await server_task()
        await server_task()
        self.assertCountEqual(seen, [b"first", b"second"])

    async def test_handler_finish_then_raise_keeps_published_terminal(self) -> None:
        async def handler(call: Call) -> None:
            await call.finish(b"done")
            raise RuntimeError("late handler failure")

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method")
        self.assertEqual(await call.receive(), b"done")
        self.assertIsNone(await call.receive())
        await call.aclose()
        await server_task()

    async def test_client_error_wakes_handler_without_abort_cancellation(self) -> None:
        observed = asyncio.Event()

        async def handler(call: Call) -> None:
            try:
                await call.receive()
            except RemoteCallError:
                observed.set()
                await call.finish()

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method")
        await call.finish(error="client failed")
        await observed.wait()
        await call.aclose()
        await server_task()

    async def test_handler_error_is_terminal_remote_error(self) -> None:
        async def handler(call: Call) -> None:
            raise ValueError("handler boom")

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method")
        with self.assertRaisesRegex(RemoteCallError, "handler boom"):
            await call.receive()
        await call.aclose()
        await server_task()

    async def test_handler_protocol_error_is_terminal_remote_error(self) -> None:
        async def handler(call: Call) -> None:
            raise CallProtocolError("invalid request")

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method")
        with self.assertRaisesRegex(RemoteCallError, "invalid request"):
            await call.receive()
        await call.aclose()
        await server_task()

    async def test_unknown_method_is_terminal_remote_error(self) -> None:
        registry = ServiceRegistry()
        server = Server(registry)
        client_stream, server_stream = memory_stream_pair(4096)
        self.streams.extend((client_stream, server_stream))
        task = self.track(server.serve(server_stream))
        client = Client(lambda: _return_stream(client_stream))
        call = await client.open_call("svc", "missing")
        with self.assertRaises(RemoteCallError):
            await call.receive()
        await call.aclose()
        await task

    async def test_remote_cancel_waits_for_handler_cleanup_barrier(self) -> None:
        cleanup_entered = asyncio.Event()
        release_cleanup = asyncio.Event()
        cleanup_done = asyncio.Event()
        started = asyncio.Event()
        never = asyncio.Event()

        async def handler(call: Call) -> None:
            started.set()
            try:
                await never.wait()
            finally:
                cleanup_entered.set()
                await release_cleanup.wait()
                cleanup_done.set()

        client, server_task = await self.runtime(handler)
        call = await client.open_call("svc", "method")
        await started.wait()
        server = server_task()
        await call.cancel()
        await cleanup_entered.wait()
        self.assertFalse(server.done())
        release_cleanup.set()
        await cleanup_done.wait()
        await call.aclose()
        await server

    async def test_server_cancellation_waits_for_handler_cleanup(self) -> None:
        handler_started = asyncio.Event()
        cleanup_entered = asyncio.Event()
        release_cleanup = asyncio.Event()
        cleanup_done = asyncio.Event()
        never = asyncio.Event()

        async def handler(call: Call) -> None:
            handler_started.set()
            try:
                await never.wait()
            finally:
                cleanup_entered.set()
                await release_cleanup.wait()
                cleanup_done.set()

        registry = ServiceRegistry()
        registry.register("svc", "method", handler)
        server = Server(registry)
        client_stream, server_stream = memory_stream_pair(4096)
        self.streams.extend((client_stream, server_stream))
        serve_task = self.track(server.serve(server_stream))
        client = Client(lambda: _return_stream(client_stream))
        call = await client.open_call("svc", "method")
        await handler_started.wait()
        serve_task.cancel()
        await cleanup_entered.wait()
        self.assertFalse(serve_task.done())
        release_cleanup.set()
        await cleanup_done.wait()
        with self.assertRaises(asyncio.CancelledError):
            await serve_task
        await call.aclose()

    async def test_registry_rejects_duplicate_registration(self) -> None:
        registry = ServiceRegistry()
        registry.register("svc", "method", lambda call: _empty_handler(call))
        with self.assertRaises(ValueError):
            registry.register("svc", "method", lambda call: _empty_handler(call))


async def _empty_handler(call: Call) -> None:
    return None


async def _return_stream(stream: ByteStream) -> ByteStream:
    return stream


if __name__ == "__main__":
    unittest.main()
