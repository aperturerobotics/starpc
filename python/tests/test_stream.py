from __future__ import annotations

import asyncio
import contextlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from srpc import rpcproto_pb2
from starpc.codec import AsyncPacketWriter, PacketDecoder
from starpc.stream import (
    ByteStream,
    StreamClosedError,
    TCPByteStream,
    TCPStreamServer,
    memory_stream_pair,
    open_tcp_stream,
    open_unix_stream,
)


async def cancel_task(task: asyncio.Task[Any] | None) -> None:
    if task is None:
        return
    if not task.done():
        task.cancel()
    with contextlib.suppress(asyncio.CancelledError, StreamClosedError):
        await task


async def receive_packets(stream: ByteStream, count: int) -> list[rpcproto_pb2.Packet]:
    decoder = PacketDecoder()
    packets: list[rpcproto_pb2.Packet] = []
    while len(packets) < count:
        data = await stream.read(3)
        if not data:
            decoder.finish()
            break
        packets.extend(decoder.feed(data))
    return packets


class StreamTest(unittest.IsolatedAsyncioTestCase):
    async def assert_task_blocked(self, task: asyncio.Task[Any]) -> None:
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(task), 0.01)

    async def test_memory_stream_fragments_reads_and_short_writes(self) -> None:
        left, right = memory_stream_pair(capacity_bytes=8, max_write_size=2)
        try:
            left_stream: ByteStream = left
            right_stream: ByteStream = right
            self.assertIs(left_stream, left)
            self.assertIs(right_stream, right)
            payload = b"abcdef"
            sent = 0
            while sent < len(payload):
                sent += await left.write(payload[sent:])
            self.assertEqual(await right.read(3), b"abc")
            self.assertEqual(await right.read(3), b"def")
        finally:
            await left.aclose()
            await right.aclose()

    async def test_memory_backpressure_blocks_at_capacity_and_wakes_on_read(
        self,
    ) -> None:
        left, right = memory_stream_pair(capacity_bytes=4)
        blocked: asyncio.Task[int] | None = None
        try:
            self.assertEqual(await left.write(b"1234"), 4)
            blocked = asyncio.create_task(left.write(b"5"))
            await self.assert_task_blocked(blocked)
            self.assertEqual(await right.read(1), b"1")
            self.assertEqual(await asyncio.wait_for(blocked, 1), 1)
            self.assertEqual(await right.read(4), b"2345")
        finally:
            await cancel_task(blocked)
            await left.aclose()
            await right.aclose()

    async def test_memory_half_close_drains_and_allows_reverse_traffic(self) -> None:
        left, right = memory_stream_pair(capacity_bytes=16)
        try:
            await left.write(b"request")
            await left.write_eof()
            await left.write_eof()
            self.assertEqual(await right.read(100), b"request")
            self.assertEqual(await right.read(1), b"")
            with self.assertRaises(StreamClosedError):
                await left.write(b"later")
            await right.write(b"response")
            self.assertEqual(await left.read(100), b"response")
            await right.write_eof()
            self.assertEqual(await left.read(1), b"")
        finally:
            await left.aclose()
            await right.aclose()

    async def test_memory_full_close_aborts_and_wakes_both_directions(self) -> None:
        left, right = memory_stream_pair(capacity_bytes=1)
        blocked_read = asyncio.create_task(left.read(1))
        blocked_write: asyncio.Task[int] | None = None
        try:
            await left.write(b"x")
            blocked_write = asyncio.create_task(left.write(b"y"))
            await self.assert_task_blocked(blocked_read)
            await self.assert_task_blocked(blocked_write)
            await left.aclose()
            await left.aclose()
            with self.assertRaises(StreamClosedError):
                await blocked_read
            with self.assertRaises(StreamClosedError):
                await blocked_write
            with self.assertRaises(StreamClosedError):
                await right.read(1)
            with self.assertRaises(StreamClosedError):
                await right.write(b"z")
        finally:
            await cancel_task(blocked_read)
            await cancel_task(blocked_write)
            await left.aclose()
            await right.aclose()

    async def test_memory_validates_limits(self) -> None:
        with self.assertRaises(ValueError):
            memory_stream_pair(0)
        with self.assertRaises(ValueError):
            memory_stream_pair(1, max_write_size=0)
        with self.assertRaises(ValueError):
            TCPStreamServer(max_pending_streams=0)
        left, right = memory_stream_pair(1)
        try:
            with self.assertRaises(ValueError):
                await left.read(0)
        finally:
            await left.aclose()
            await right.aclose()

    async def test_codec_runs_over_fragmented_memory_stream(self) -> None:
        left, right = memory_stream_pair(capacity_bytes=7, max_write_size=2)
        packets = [
            rpcproto_pb2.Packet(call_cancel=True),
            rpcproto_pb2.Packet(
                call_data=rpcproto_pb2.CallData(data=b"payload", complete=True)
            ),
        ]
        send_task = asyncio.create_task(self.send_packets(left, packets))
        try:
            received = await receive_packets(right, len(packets))
            await asyncio.wait_for(send_task, 1)
            self.assertEqual(received, packets)
            self.assertEqual(await right.read(1), b"")
        finally:
            await cancel_task(send_task)
            await left.aclose()
            await right.aclose()

    async def send_packets(
        self, stream: ByteStream, packets: list[rpcproto_pb2.Packet]
    ) -> None:
        writer = AsyncPacketWriter(stream)
        for packet in packets:
            await writer.write(packet)
        await stream.write_eof()

    async def test_tcp_connections_are_independent_packet_streams(self) -> None:
        server = TCPStreamServer()
        await server.start()
        address = server.address
        try:
            for value in (b"one", b"two"):
                client = await open_tcp_stream(*address)
                accepted = await asyncio.wait_for(server.accept(), 1)
                packet = rpcproto_pb2.Packet(
                    call_data=rpcproto_pb2.CallData(data=value, complete=True)
                )
                send_task = asyncio.create_task(self.send_packets(client, [packet]))
                try:
                    self.assertEqual(await receive_packets(accepted, 1), [packet])
                    await asyncio.wait_for(send_task, 1)
                    self.assertEqual(await accepted.read(1), b"")
                    response = rpcproto_pb2.Packet(call_cancel=True)
                    await AsyncPacketWriter(accepted).write(response)
                    await accepted.write_eof()
                    self.assertEqual(await receive_packets(client, 1), [response])
                    self.assertEqual(await client.read(1), b"")
                finally:
                    await cancel_task(send_task)
                    await accepted.aclose()
                    await client.aclose()
        finally:
            await server.aclose()

    async def test_tcp_server_bounds_pending_connections(self) -> None:
        server = TCPStreamServer(max_pending_streams=1)
        await server.start()
        first = await open_tcp_stream(*server.address)
        second = await open_tcp_stream(*server.address)
        accepted: ByteStream | None = None
        try:
            self.assertEqual(await asyncio.wait_for(second.read(1), 1), b"")
            accepted = await asyncio.wait_for(server.accept(), 1)
            await first.write(b"accepted")
            self.assertEqual(await accepted.read(100), b"accepted")
        finally:
            if accepted is not None:
                await accepted.aclose()
            await first.aclose()
            await second.aclose()
            await server.aclose()

    async def test_tcp_close_wakes_read_and_serializes_raw_writes(self) -> None:
        server = TCPStreamServer()
        await server.start()
        client = await open_tcp_stream(*server.address)
        accepted = await asyncio.wait_for(server.accept(), 1)
        blocked_read = asyncio.create_task(client.read(1))
        try:
            await self.assert_task_blocked(blocked_read)
            await asyncio.gather(accepted.write(b"a"), accepted.write(b"b"))
            received = await asyncio.wait_for(blocked_read, 1)
            while len(received) < 2:
                received += await client.read(2 - len(received))
            self.assertIn(received, (b"ab", b"ba"))
            second_read = asyncio.create_task(client.read(1))
            await self.assert_task_blocked(second_read)
            await client.aclose()
            self.assertEqual(await asyncio.wait_for(second_read, 1), b"")
        finally:
            await cancel_task(blocked_read)
            await accepted.aclose()
            await client.aclose()
            await server.aclose()

    async def test_server_close_wakes_all_accepts_and_preserves_accepted_streams(
        self,
    ) -> None:
        server = TCPStreamServer()
        await server.start()
        address = server.address
        first_waiter = asyncio.create_task(server.accept())
        second_waiter = asyncio.create_task(server.accept())
        client: ByteStream | None = None
        accepted: ByteStream | None = None
        try:
            await self.assert_task_blocked(first_waiter)
            await self.assert_task_blocked(second_waiter)
            client = await open_tcp_stream(*address)
            done, pending = await asyncio.wait(
                {first_waiter, second_waiter},
                timeout=1,
                return_when=asyncio.FIRST_COMPLETED,
            )
            self.assertEqual(len(done), 1)
            accepted = next(iter(done)).result()
            remaining = next(iter(pending))
            await server.aclose()
            with self.assertRaises(StreamClosedError):
                await remaining
            await client.write(b"still-open")
            self.assertEqual(await accepted.read(100), b"still-open")
            with self.assertRaises(OSError):
                await open_tcp_stream(*address)
        finally:
            await cancel_task(first_waiter)
            await cancel_task(second_waiter)
            if accepted is not None:
                await accepted.aclose()
            if client is not None:
                await client.aclose()
            await server.aclose()


class UnixStreamTest(unittest.IsolatedAsyncioTestCase):
    async def assert_task_blocked(self, task: asyncio.Task[Any]) -> None:
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(task), 0.01)

    async def test_unix_connections_are_independent_and_half_close(self) -> None:
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "starpc.sock"
            accepted: asyncio.Queue[TCPByteStream] = asyncio.Queue()

            def on_connection(
                reader: asyncio.StreamReader, writer: asyncio.StreamWriter
            ) -> None:
                accepted.put_nowait(TCPByteStream(reader, writer))

            server = await asyncio.start_unix_server(on_connection, path)
            try:
                for value in (b"one", b"two"):
                    client = await open_unix_stream(str(path))
                    peer = await asyncio.wait_for(accepted.get(), 1)
                    try:
                        await client.write(value)
                        await client.write_eof()
                        self.assertEqual(await peer.read(100), value)
                        self.assertEqual(await peer.read(1), b"")
                        await peer.write(value.upper())
                        await peer.write_eof()
                        self.assertEqual(await client.read(100), value.upper())
                        self.assertEqual(await client.read(1), b"")
                    finally:
                        await peer.aclose()
                        await client.aclose()
            finally:
                server.close()
                await server.wait_closed()

    async def test_unix_close_wakes_read_and_missing_path_fails(self) -> None:
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "starpc.sock"
            accepted: asyncio.Queue[TCPByteStream] = asyncio.Queue()

            def on_connection(
                reader: asyncio.StreamReader, writer: asyncio.StreamWriter
            ) -> None:
                accepted.put_nowait(TCPByteStream(reader, writer))

            server = await asyncio.start_unix_server(on_connection, path)
            client = await open_unix_stream(str(path))
            peer = await asyncio.wait_for(accepted.get(), 1)
            blocked_read = asyncio.create_task(client.read(1))
            try:
                await self.assert_task_blocked(blocked_read)
                await client.aclose()
                self.assertEqual(await asyncio.wait_for(blocked_read, 1), b"")
            finally:
                await cancel_task(blocked_read)
                await peer.aclose()
                await client.aclose()
                server.close()
                await server.wait_closed()

            path.unlink()
            with self.assertRaises(OSError):
                await open_unix_stream(str(path))


if __name__ == "__main__":
    unittest.main()
