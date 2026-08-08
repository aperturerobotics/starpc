from __future__ import annotations

import asyncio
import json
import struct
import unittest
from pathlib import Path
from typing import Any, cast

from srpc import rpcproto_pb2
from starpc.codec import (
    MAX_MESSAGE_SIZE,
    AsyncPacketWriter,
    InvalidFrameError,
    InvalidPacketError,
    MalformedPacketError,
    PacketDecoder,
    TruncatedFrameError,
    WriteCountError,
    ZeroProgressError,
    encode_packet,
    validate_packet,
)


def vector_data() -> dict[str, Any]:
    path = Path(__file__).parents[2] / "testdata/packet-codec-vectors.json"
    return cast(dict[str, Any], json.loads(path.read_text()))


def packet_start(
    service: str = "svc", method: str = "method", **kwargs: Any
) -> rpcproto_pb2.Packet:
    return rpcproto_pb2.Packet(
        call_start=rpcproto_pb2.CallStart(
            rpc_service=service, rpc_method=method, **kwargs
        )
    )


def frame(packet: rpcproto_pb2.Packet) -> bytes:
    body = packet.SerializeToString(deterministic=True)
    return struct.pack("<I", len(body)) + body


class CodecVectorTest(unittest.TestCase):
    def test_official_vectors_and_presence(self) -> None:
        for case in vector_data()["cases"]:
            if not case.get("packet_hex"):
                continue
            packet = rpcproto_pb2.Packet.FromString(bytes.fromhex(case["packet_hex"]))
            self.assertEqual(
                packet.SerializeToString(deterministic=True).hex(), case["packet_hex"]
            )
            self.assertEqual(frame(packet).hex(), case["frame_hex"])
        self.assertEqual(packet_start().call_start.data, b"")
        present = packet_start(data=b"", data_is_zero=True).call_start
        self.assertEqual(present.data, b"")
        self.assertTrue(present.data_is_zero)

    def test_invalid_fixture_categories(self) -> None:
        for case in vector_data()["cases"]:
            expected = case.get("expect_error")
            if expected == "invalid_length" or expected == "oversized_frame":
                with self.assertRaises(InvalidFrameError):
                    PacketDecoder().feed(bytes.fromhex(case["frame_hex"]))
            elif expected == "malformed_packet":
                with self.assertRaises(MalformedPacketError):
                    PacketDecoder().feed(bytes.fromhex(case["frame_hex"]))
            elif expected == "truncated_frame":
                decoder = PacketDecoder()
                decoder.feed(bytes.fromhex(case["frame_hex"]))
                with self.assertRaises(TruncatedFrameError):
                    decoder.finish()
            elif expected == "empty_packet":
                with self.assertRaises(InvalidPacketError):
                    validate_packet(rpcproto_pb2.Packet())
            elif expected == "empty_service_id":
                with self.assertRaises(InvalidPacketError):
                    validate_packet(packet_start("", "method"))
            elif expected == "empty_method_id":
                with self.assertRaises(InvalidPacketError):
                    validate_packet(packet_start("svc", ""))

    def test_valid_frames_at_every_split_and_coalesced(self) -> None:
        frames = [
            bytes.fromhex(case["frame_hex"])
            for case in vector_data()["cases"]
            if "packet_hex" in case and "frame_hex" in case
        ]
        for raw in frames:
            for split in range(len(raw) + 1):
                decoder = PacketDecoder()
                packets = decoder.feed(raw[:split]) + decoder.feed(raw[split:])
                self.assertEqual(len(packets), 1)
                decoder.finish()
        decoder = PacketDecoder()
        self.assertEqual(len(decoder.feed(b"".join(frames))), len(frames))
        decoder.finish()

    def test_exact_max_boundary_with_binary_search(self) -> None:
        packet = packet_start(data=b"")

        def size(payload_size: int) -> int:
            packet.call_start.data = b"x" * payload_size
            return packet.ByteSize()

        low, high = 0, MAX_MESSAGE_SIZE
        while low < high:
            mid = (low + high + 1) // 2
            if size(mid) <= MAX_MESSAGE_SIZE:
                low = mid
            else:
                high = mid - 1
        self.assertEqual(size(low), MAX_MESSAGE_SIZE)
        packet.call_start.data = b"x" * (low + 1)
        with self.assertRaises(InvalidFrameError):
            encode_packet(packet)

    def test_concurrent_short_writes_and_errors(self) -> None:
        class Writer:
            def __init__(
                self, width: int, error: Exception | None = None, over: bool = False
            ) -> None:
                self.width, self.error, self.over = width, error, over
                self.data = bytearray()

            async def write(self, data: bytes) -> int:
                await asyncio.sleep(0)
                if self.error is not None:
                    raise self.error
                if self.over:
                    return len(data) + 1
                count = min(self.width, len(data))
                self.data.extend(data[:count])
                return count

        async def run() -> None:
            packets = [
                packet_start("one", "method", data=b"one"),
                packet_start("two", "method", data=b"two"),
            ]
            for width in (1, 2, 3):
                writer = Writer(width)
                packet_writer = AsyncPacketWriter(writer)
                await asyncio.gather(
                    *(packet_writer.write(packet) for packet in packets)
                )
                expected = [
                    frame(packets[0]) + frame(packets[1]),
                    frame(packets[1]) + frame(packets[0]),
                ]
                self.assertIn(bytes(writer.data), expected)
            with self.assertRaises(OSError):
                await AsyncPacketWriter(Writer(2, OSError("boom"))).write(packets[0])
            with self.assertRaises(ZeroProgressError):
                await AsyncPacketWriter(Writer(0)).write(packets[0])
            with self.assertRaises(WriteCountError):
                await AsyncPacketWriter(Writer(1, over=True)).write(packets[0])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
