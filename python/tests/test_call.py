from __future__ import annotations

import asyncio
import contextlib
import struct
import unittest
from collections.abc import Coroutine
from typing import Any

from srpc import rpcproto_pb2
from starpc.call import (
    Call,
    CallCancelledError,
    CallCompletedError,
    CallProtocolError,
    ClosedBeforeCompletionError,
    RemoteCallError,
)
from starpc.codec import encode_packet
from starpc.stream import ByteStream, memory_stream_pair


async def cancel_and_await(task: asyncio.Task[Any]) -> None:
    if not task.done():
        task.cancel()
    with contextlib.suppress(BaseException):
        await task


class ScriptedStream:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.read_events = [asyncio.Event() for _ in chunks]
        self.writes: list[bytes] = []
        self.index = 0
        self.closed = False

    async def read(self, max_bytes: int) -> bytes:
        if self.index >= len(self.chunks):
            await asyncio.Future()
        event = self.read_events[self.index]
        event.set()
        chunk = self.chunks[self.index]
        self.index += 1
        return chunk[:max_bytes]

    async def write(self, data: bytes) -> int:
        self.writes.append(bytes(data))
        return len(data)

    async def write_eof(self) -> None:
        return None

    async def aclose(self) -> None:
        self.closed = True


class CallTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client_stream, self.peer_stream = memory_stream_pair(4096)
        self.call = await Call.open(
            self.client_stream, "svc", "method", inbound_capacity=1
        )
        self.tasks: set[asyncio.Task[Any]] = set()

    async def asyncTearDown(self) -> None:
        for task in self.tasks:
            await cancel_and_await(task)
        await self.call.aclose()
        await self.peer_stream.aclose()

    def track(self, awaitable: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        task = asyncio.create_task(awaitable)
        self.tasks.add(task)
        return task

    async def peer_send(self, packet: rpcproto_pb2.Packet) -> None:
        frame = encode_packet(packet)
        offset = 0
        while offset < len(frame):
            offset += await self.peer_stream.write(frame[offset:])

    async def peer_packet(self) -> rpcproto_pb2.Packet:
        header = await self.peer_stream.read(4)
        self.assertEqual(len(header), 4)
        size = struct.unpack("<I", header)[0]
        body = bytearray()
        while len(body) < size:
            body.extend(await self.peer_stream.read(size - len(body)))
        return rpcproto_pb2.Packet.FromString(bytes(body))

    async def assert_call_start(
        self, initial_data: bytes | None = None
    ) -> rpcproto_pb2.Packet:
        packet = await self.peer_packet()
        self.assertEqual(packet.WhichOneof("body"), "call_start")
        self.assertEqual(packet.call_start.rpc_service, "svc")
        self.assertEqual(packet.call_start.rpc_method, "method")
        if initial_data is not None:
            self.assertEqual(packet.call_start.data, initial_data)
            self.assertTrue(packet.call_start.data_is_zero)
        return packet

    async def test_call_start_absent_and_present_empty_initial_data(self) -> None:
        await self.assert_call_start()
        await self.call.aclose()

        client, peer = memory_stream_pair(4096)
        call = await Call.open(client, "svc", "method", initial_data=b"")
        try:
            packet = await self.peer_packet_from(peer)
            self.assertEqual(packet.call_start.data, b"")
            self.assertTrue(packet.call_start.data_is_zero)
        finally:
            await call.aclose()
            await peer.aclose()

    async def peer_packet_from(self, peer: ByteStream) -> rpcproto_pb2.Packet:
        header = await peer.read(4)
        size = struct.unpack("<I", header)[0]
        body = bytearray()
        while len(body) < size:
            body.extend(await peer.read(size - len(body)))
        return rpcproto_pb2.Packet.FromString(bytes(body))

    async def test_empty_and_nonempty_messages_preserve_order_and_presence(
        self,
    ) -> None:
        await self.assert_call_start()
        await self.peer_send(
            rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(data_is_zero=True))
        )
        await self.peer_send(
            rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(data=b"one"))
        )
        await self.peer_send(
            rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(complete=True))
        )
        self.assertEqual(await self.call.receive(), b"")
        self.assertEqual(await self.call.receive(), b"one")
        self.assertIsNone(await self.call.receive())

    async def test_finish_emits_clean_terminal_packet_and_repeated_empty_finish_is_noop(
        self,
    ) -> None:
        await self.assert_call_start()
        await self.call.finish()
        packet = await self.peer_packet()
        self.assertTrue(packet.call_data.complete)
        self.assertFalse(packet.call_data.data_is_zero)
        await self.call.finish()

    async def test_queued_data_is_drained_before_remote_error(self) -> None:
        await self.assert_call_start()
        await self.peer_send(
            rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(data=b"queued"))
        )
        await self.peer_send(
            rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(error="boom"))
        )
        self.assertEqual(await self.call.receive(), b"queued")
        with self.assertRaisesRegex(RemoteCallError, "boom"):
            await self.call.receive()

    async def test_cancel_wakes_receive_emits_one_cancel_and_is_idempotent(
        self,
    ) -> None:
        await self.assert_call_start()
        receive = self.track(self.call.receive())
        await self.call.cancel()
        with self.assertRaises(CallCancelledError):
            await receive
        packet = await self.peer_packet()
        self.assertTrue(packet.call_cancel)
        await self.call.cancel()

    async def test_cancel_full_inbound_queue_joins_receiver_and_emits_one_cancel(
        self,
    ) -> None:
        frames = [
            encode_packet(
                rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(data=data))
            )
            for data in (b"first", b"second")
        ]
        stream = ScriptedStream(frames)
        call = await Call.open(stream, "svc", "method", inbound_capacity=1)
        await stream.read_events[1].wait()
        await call.cancel()
        with self.assertRaises(CallCancelledError):
            await call.wait_closed()
        packets = [rpcproto_pb2.Packet.FromString(write[4:]) for write in stream.writes]
        self.assertEqual(
            sum(packet.WhichOneof("body") == "call_cancel" for packet in packets), 1
        )
        await call.aclose()

    async def test_client_finish_then_peer_eof_is_not_remote_completion(self) -> None:
        await self.assert_call_start()
        await self.call.finish()
        await self.peer_stream.read(65536)
        await self.peer_stream.aclose()
        with self.assertRaises(ClosedBeforeCompletionError):
            await self.call.wait_closed()

    async def test_close_before_completion_wakes_receive_with_specific_error(
        self,
    ) -> None:
        await self.assert_call_start()
        receive = self.track(self.call.receive())
        await self.peer_stream.aclose()
        with self.assertRaises(ClosedBeforeCompletionError):
            await receive
        await self.call.aclose()
        await self.call.aclose()

    async def test_malformed_and_late_packets_are_protocol_errors(self) -> None:
        await self.assert_call_start()
        await self.peer_stream.write(struct.pack("<I", 3) + b"\x08\xff\x00")
        with self.assertRaises(CallProtocolError):
            await self.call.receive()

    async def test_late_packet_after_remote_completion_is_protocol_error(self) -> None:
        await self.assert_call_start()
        await self.peer_send(
            rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(complete=True))
        )
        self.assertIsNone(await self.call.receive())
        await self.peer_send(
            rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(data=b"late"))
        )
        with self.assertRaises(CallProtocolError):
            await self.call.wait_closed()

    async def test_duplicate_terminal_operations_and_post_terminal_send(self) -> None:
        await self.assert_call_start()
        await self.call.finish(b"done")
        with self.assertRaises(CallCompletedError):
            await self.call.finish(b"again")
        with self.assertRaises(CallCompletedError):
            await self.call.finish(error="again")
        with self.assertRaises(CallCompletedError):
            await self.call.cancel()
        with self.assertRaises(CallCompletedError):
            await self.call.send(b"late")
        await self.call.aclose()
        await self.call.aclose()

    async def test_inbound_bound_stops_reading_until_oldest_message_is_consumed(
        self,
    ) -> None:
        frames = [
            encode_packet(
                rpcproto_pb2.Packet(call_data=rpcproto_pb2.CallData(data=data))
            )
            for data in (b"first", b"second", b"third")
        ]
        stream = ScriptedStream(frames)
        call = await Call.open(stream, "svc", "method", inbound_capacity=1)
        try:
            self.assertTrue(stream.read_events[0].is_set())
            await stream.read_events[1].wait()
            self.assertFalse(stream.read_events[2].is_set())
            self.assertEqual(await call.receive(), b"first")
            await stream.read_events[2].wait()
            self.assertEqual(await call.receive(), b"second")
            self.assertEqual(await call.receive(), b"third")
        finally:
            await call.aclose()

    async def test_accept_validates_first_start_and_exposes_properties(self) -> None:
        client, peer = memory_stream_pair(4096)
        try:
            await peer.write(
                encode_packet(
                    rpcproto_pb2.Packet(
                        call_start=rpcproto_pb2.CallStart(
                            rpc_service="accepted", rpc_method="run"
                        )
                    )
                )
            )
            call = await Call.accept(client)
            self.assertEqual(call.service, "accepted")
            self.assertEqual(call.method, "run")
            await call.aclose()
        finally:
            await client.aclose()
            await peer.aclose()

    async def test_accept_seeds_present_empty_initial_data(self) -> None:
        client, peer = memory_stream_pair(4096)
        try:
            await peer.write(
                encode_packet(
                    rpcproto_pb2.Packet(
                        call_start=rpcproto_pb2.CallStart(
                            rpc_service="svc", rpc_method="run", data_is_zero=True
                        )
                    )
                )
            )
            call = await Call.accept(client)
            self.assertEqual(await call.receive(), b"")
            await call.aclose()
        finally:
            await client.aclose()
            await peer.aclose()

    async def test_accept_rejects_later_call_start_as_protocol_error(self) -> None:
        client, peer = memory_stream_pair(4096)
        try:
            await peer.write(
                encode_packet(
                    rpcproto_pb2.Packet(
                        call_start=rpcproto_pb2.CallStart(
                            rpc_service="svc", rpc_method="run"
                        )
                    )
                )
            )
            call = await Call.accept(client)
            await peer.write(
                encode_packet(
                    rpcproto_pb2.Packet(
                        call_start=rpcproto_pb2.CallStart(
                            rpc_service="svc", rpc_method="later"
                        )
                    )
                )
            )
            with self.assertRaises(CallProtocolError):
                await call.receive()
            await call.aclose()
        finally:
            await client.aclose()
            await peer.aclose()

    async def test_accept_local_completion_treats_peer_eof_as_normal(self) -> None:
        client, peer = memory_stream_pair(4096)
        try:
            await peer.write(
                encode_packet(
                    rpcproto_pb2.Packet(
                        call_start=rpcproto_pb2.CallStart(
                            rpc_service="svc", rpc_method="run"
                        )
                    )
                )
            )
            call = await Call.accept(client)
            await call.finish()
            await peer.read(65536)
            await peer.aclose()
            await call.wait_closed()
            await call.aclose()
        finally:
            await client.aclose()
            await peer.aclose()


if __name__ == "__main__":
    unittest.main()
