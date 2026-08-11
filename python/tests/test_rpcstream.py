from __future__ import annotations

import asyncio
import contextlib
import unittest
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable

from rpcstream import rpcstream_pb2
from srpc import rpcproto_pb2
from starpc.call import Call, CallCancelledError, CallError, RemoteCallError
from starpc.client import Client
from starpc.rpcstream import (
    ComponentRegistry,
    RpcStreamProtocolError,
    RpcStreamRemoteError,
    build_rpc_stream_open_stream,
    handle_rpc_stream,
)
from starpc.server import Handler, Server, ServiceRegistry
from starpc.stream import ByteStream


class RpcStreamContractTest(unittest.TestCase):
    def test_build_rpc_stream_open_stream_is_public(self) -> None:
        self.assertTrue(callable(build_rpc_stream_open_stream))


class RpcStreamTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.components = ComponentRegistry(capacity_bytes=64)

    async def asyncTearDown(self) -> None:
        for component_id in tuple(self.components._components):
            await asyncio.wait_for(self.components.unregister(component_id), 1)
        self.assertFalse(self.components._retired)

    def client(
        self,
        component_id: str = "test",
        seen: list[rpcstream_pb2.RpcStreamPacket] | None = None,
    ) -> Client:
        async def caller(
            requests: AsyncIterable[rpcstream_pb2.RpcStreamPacket],
        ) -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
            async def recorded() -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
                async for request in requests:
                    if seen is not None:
                        seen.append(request)
                    yield request

            async for response in handle_rpc_stream(recorded(), self.components):
                yield response

        return Client(
            build_rpc_stream_open_stream(component_id, caller, capacity_bytes=64),
            inbound_capacity=1,
        )

    async def register(
        self,
        handler: Handler,
        component_id: str = "test",
        on_release: Callable[[], Awaitable[None] | None] | None = None,
    ) -> None:
        services = ServiceRegistry()
        services.register("test.Service", "Do", handler)
        await self.components.register(
            component_id, Server(services, inbound_capacity=1), on_release
        )

    async def test_acknowledged_unary_uses_unframed_outer_packets(self) -> None:
        released = asyncio.Event()
        seen: list[rpcstream_pb2.RpcStreamPacket] = []

        async def handler(call: Call) -> None:
            self.assertEqual(await call.receive(), b"request")
            await call.finish(b"response")

        await self.register(handler, on_release=released.set)
        call = await self.client(seen=seen).open_call("test.Service", "Do", b"request")
        self.assertEqual(await call.receive(), b"response")
        self.assertIsNone(await call.receive())
        await call.aclose()
        await asyncio.wait_for(released.wait(), 1)

        self.assertEqual(seen[0].WhichOneof("body"), "init")
        self.assertEqual(seen[0].init.component_id, "test")
        self.assertEqual(seen[1].WhichOneof("body"), "data")
        inner = rpcproto_pb2.Packet.FromString(seen[1].data)
        self.assertEqual(inner.WhichOneof("body"), "call_start")
        self.assertEqual(inner.call_start.rpc_service, "test.Service")
        self.assertEqual(inner.call_start.rpc_method, "Do")
        self.assertEqual(
            seen[1].data,
            inner.SerializeToString(deterministic=True),
        )
        self.assertFalse(self.components._components["test"].routes)

    async def test_closing_after_ack_releases_route_once(self) -> None:
        releases: list[None] = []

        async def requests() -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
            yield rpcstream_pb2.RpcStreamPacket(
                init=rpcstream_pb2.RpcStreamInit(component_id="test")
            )

        await self.register(
            lambda _call: asyncio.sleep(0), on_release=lambda: releases.append(None)
        )
        nested = handle_rpc_stream(requests(), self.components)
        self.assertEqual((await anext(nested)).WhichOneof("body"), "ack")
        await nested.aclose()
        self.assertEqual(releases, [None])
        self.assertFalse(self.components._components["test"].routes)
        await asyncio.wait_for(self.components.unregister("test"), 1)
        self.assertFalse(self.components._retired)

    async def test_open_waits_for_acknowledgement(self) -> None:
        seen_init = asyncio.Event()
        release_ack = asyncio.Event()

        async def caller(
            requests: AsyncIterable[rpcstream_pb2.RpcStreamPacket],
        ) -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
            request = await anext(requests.__aiter__())
            self.assertEqual(request.WhichOneof("body"), "init")
            seen_init.set()
            await release_ack.wait()
            yield rpcstream_pb2.RpcStreamPacket(ack=rpcstream_pb2.RpcAck())

        opener = build_rpc_stream_open_stream("test", caller)

        async def open_stream() -> ByteStream:
            return await opener()

        opening: asyncio.Task[ByteStream] = asyncio.create_task(open_stream())
        await asyncio.wait_for(seen_init.wait(), 1)
        self.assertFalse(opening.done())
        release_ack.set()
        stream = await asyncio.wait_for(opening, 1)
        await stream.aclose()

    async def test_unknown_component_is_rejected_in_ack(self) -> None:
        async def caller(
            requests: AsyncIterable[rpcstream_pb2.RpcStreamPacket],
        ) -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
            async for response in handle_rpc_stream(
                requests.__aiter__(), self.components
            ):
                yield response

        client = Client(build_rpc_stream_open_stream("missing", caller))
        with self.assertRaisesRegex(RpcStreamRemoteError, "unknown component"):
            await client.open_call("test.Service", "Do")
        self.assertFalse(self.components._components)

    async def test_later_data_and_cancel_settle_the_route_once(self) -> None:
        handler_done = asyncio.Event()
        released = asyncio.Event()
        seen: list[rpcstream_pb2.RpcStreamPacket] = []

        async def handler(call: Call) -> None:
            try:
                self.assertEqual(await call.receive(), b"later")
                await asyncio.Future()
            finally:
                handler_done.set()

        await self.register(handler, on_release=released.set)
        call = await self.client(seen=seen).open_call("test.Service", "Do")
        await call.send(b"later")
        await call.cancel()
        with self.assertRaises(CallCancelledError):
            await call.wait_closed()
        await call.aclose()
        await asyncio.wait_for(handler_done.wait(), 1)
        await asyncio.wait_for(released.wait(), 1)

        bodies = [
            rpcproto_pb2.Packet.FromString(packet.data).WhichOneof("body")
            for packet in seen
            if packet.WhichOneof("body") == "data"
        ]
        self.assertEqual(bodies, ["call_start", "call_data", "call_cancel"])
        self.assertFalse(self.components._components["test"].routes)

    async def test_terminal_handler_error_releases_after_server_settles(self) -> None:
        released = asyncio.Event()

        async def handler(call: Call) -> None:
            raise RuntimeError("handler failed")

        await self.register(handler, on_release=released.set)
        call = await self.client().open_call("test.Service", "Do")
        with self.assertRaisesRegex(RemoteCallError, "handler failed"):
            await call.receive()
        await call.aclose()
        await asyncio.wait_for(released.wait(), 1)
        self.assertFalse(self.components._components["test"].routes)

    async def test_unregister_removes_before_cancellation_and_waits_for_handler(
        self,
    ) -> None:
        handler_started = asyncio.Event()
        cleanup_started = asyncio.Event()
        release_cleanup = asyncio.Event()
        handler_done = asyncio.Event()
        release_count = 0

        async def handler(call: Call) -> None:
            handler_started.set()
            try:
                await asyncio.Future()
            finally:
                cleanup_started.set()
                await release_cleanup.wait()
                handler_done.set()

        def on_release() -> None:
            nonlocal release_count
            self.assertTrue(handler_done.is_set())
            release_count += 1

        await self.register(handler, on_release=on_release)
        call = await self.client().open_call("test.Service", "Do")
        await asyncio.wait_for(handler_started.wait(), 1)
        unregistering = asyncio.create_task(self.components.unregister("test"))
        joined = asyncio.create_task(self.components.unregister("test"))
        await asyncio.wait_for(cleanup_started.wait(), 1)
        self.assertNotIn("test", self.components._components)
        with self.assertRaises(RpcStreamRemoteError):
            await self.client().open_call("test.Service", "Do")
        with self.assertRaises(ValueError):
            await self.components.register("test", Server(ServiceRegistry()))
        self.assertFalse(unregistering.done())
        self.assertFalse(joined.done())

        release_cleanup.set()
        await asyncio.wait_for(asyncio.gather(unregistering, joined), 1)
        self.assertEqual(release_count, 1)
        self.assertTrue(handler_done.is_set())
        self.assertNotIn("test", self.components._retired)
        await self.register(handler)
        self.assertIn("test", self.components._components)
        await self.components.unregister("test")
        self.assertNotIn("test", self.components._retired)
        with contextlib.suppress(CallError):
            await call.wait_closed()
        await call.aclose()

    async def test_abrupt_close_releases_active_handler(self) -> None:
        handler_done = asyncio.Event()
        released = asyncio.Event()

        async def handler(call: Call) -> None:
            try:
                await asyncio.Future()
            finally:
                handler_done.set()

        await self.register(handler, on_release=released.set)
        call = await self.client().open_call("test.Service", "Do")
        await call.aclose()
        await asyncio.wait_for(handler_done.wait(), 1)
        await asyncio.wait_for(released.wait(), 1)
        self.assertFalse(self.components._components["test"].routes)

    async def test_unregister_unblocks_backpressured_input(self) -> None:
        handler_started = asyncio.Event()
        handler_done = asyncio.Event()
        released = asyncio.Event()

        async def handler(call: Call) -> None:
            handler_started.set()
            try:
                await asyncio.Future()
            finally:
                handler_done.set()

        await self.register(handler, on_release=released.set)
        call = await self.client().open_call("test.Service", "Do")
        await asyncio.wait_for(handler_started.wait(), 1)
        sends = [asyncio.create_task(call.send(b"x" * 64)) for _ in range(8)]
        await asyncio.sleep(0)
        self.assertTrue(any(not send.done() for send in sends))
        await asyncio.wait_for(self.components.unregister("test"), 1)
        await asyncio.gather(*sends, return_exceptions=True)
        self.assertTrue(all(send.done() for send in sends))
        await asyncio.wait_for(handler_done.wait(), 1)
        await asyncio.wait_for(released.wait(), 1)
        await call.aclose()

    async def test_unregister_unblocks_backpressured_output(self) -> None:
        handler_started = asyncio.Event()
        handler_finished = asyncio.Event()
        released = asyncio.Event()

        async def handler(call: Call) -> None:
            handler_started.set()
            try:
                for _ in range(16):
                    await call.send(b"x" * 64)
                handler_finished.set()
            finally:
                pass

        await self.register(handler, on_release=released.set)
        call = await self.client().open_call("test.Service", "Do")
        await asyncio.wait_for(handler_started.wait(), 1)
        await asyncio.sleep(0)
        self.assertFalse(handler_finished.is_set())
        await asyncio.wait_for(self.components.unregister("test"), 1)
        await asyncio.wait_for(released.wait(), 1)
        self.assertNotIn("test", self.components._retired)
        await call.aclose()

    async def test_malformed_post_ack_input_propagates_after_route_cleanup(
        self,
    ) -> None:
        releases: list[None] = []
        await self.register(
            lambda _call: asyncio.sleep(0), on_release=lambda: releases.append(None)
        )

        async def requests() -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
            yield rpcstream_pb2.RpcStreamPacket(
                init=rpcstream_pb2.RpcStreamInit(component_id="test")
            )
            yield rpcstream_pb2.RpcStreamPacket(data=b"not-a-packet")

        nested = handle_rpc_stream(requests(), self.components)
        self.assertEqual((await anext(nested)).WhichOneof("body"), "ack")
        with self.assertRaises(RpcStreamProtocolError):
            await anext(nested)
        self.assertEqual(releases, [None])
        self.assertFalse(self.components._components["test"].routes)
        self.assertFalse(self.components._retired)

    async def test_invalid_inner_packet_releases_route_without_tasks(self) -> None:
        releases: list[None] = []
        await self.register(
            lambda _call: asyncio.sleep(0), on_release=lambda: releases.append(None)
        )

        async def requests() -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
            yield rpcstream_pb2.RpcStreamPacket(
                init=rpcstream_pb2.RpcStreamInit(component_id="test")
            )
            yield rpcstream_pb2.RpcStreamPacket(data=b"\x80")

        nested = handle_rpc_stream(requests(), self.components)
        await anext(nested)
        with self.assertRaises(RpcStreamProtocolError):
            await anext(nested)
        self.assertEqual(releases, [None])
        self.assertFalse(self.components._components["test"].routes)

    async def test_partial_inner_frame_is_rejected_at_eof(self) -> None:
        failure: asyncio.Future[RpcStreamProtocolError] = (
            asyncio.get_running_loop().create_future()
        )

        async def caller(
            requests: AsyncIterable[rpcstream_pb2.RpcStreamPacket],
        ) -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
            iterator = requests.__aiter__()
            request = await anext(iterator)
            self.assertEqual(request.WhichOneof("body"), "init")
            yield rpcstream_pb2.RpcStreamPacket(ack=rpcstream_pb2.RpcAck())
            try:
                async for _ in iterator:
                    pass
            except RpcStreamProtocolError as exc:
                failure.set_result(exc)

        stream = await build_rpc_stream_open_stream("test", caller)()
        await stream.write(b"\x01\x00")
        await stream.write_eof()
        error = await asyncio.wait_for(failure, 1)
        self.assertIsInstance(error, RpcStreamProtocolError)
        await stream.aclose()
