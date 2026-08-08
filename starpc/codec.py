from __future__ import annotations

import asyncio
import struct
from collections.abc import Awaitable
from typing import Protocol

from google.protobuf.message import DecodeError

from srpc import rpcproto_pb2

MAX_MESSAGE_SIZE = 10_000_000


class CodecError(Exception):
    """Base class for packet codec failures."""


class InvalidFrameError(CodecError):
    """The frame length is invalid."""


class MalformedPacketError(CodecError):
    """The frame body is not a protobuf packet."""


class InvalidPacketError(CodecError):
    """The packet protobuf violates the StarPC packet contract."""


class TruncatedFrameError(CodecError):
    """The stream ended before a complete frame arrived."""


class ZeroProgressError(CodecError):
    """The underlying writer returned zero or a negative count."""


class WriteCountError(CodecError):
    """The underlying writer returned more bytes than it received."""


class _AsyncWriter(Protocol):
    def write(self, data: bytes) -> Awaitable[int]: ...


def validate_packet(packet: rpcproto_pb2.Packet) -> None:
    body = packet.WhichOneof("body")
    if body is None:
        raise InvalidPacketError("packet body oneof is required")
    if body == "call_start":
        if not packet.call_start.rpc_service:
            raise InvalidPacketError("call service is required")
        if not packet.call_start.rpc_method:
            raise InvalidPacketError("call method is required")


def encode_packet(packet: rpcproto_pb2.Packet) -> bytes:
    validate_packet(packet)
    body = packet.SerializeToString(deterministic=True)
    if not body or len(body) > MAX_MESSAGE_SIZE:
        raise InvalidFrameError("packet size is outside the allowed range")
    return struct.pack("<I", len(body)) + body


class PacketDecoder:
    """Incrementally decode length-prefixed protobuf packets."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._expected: int | None = None

    def feed(self, data: bytes) -> list[rpcproto_pb2.Packet]:
        self._buffer.extend(data)
        packets: list[rpcproto_pb2.Packet] = []
        while True:
            if self._expected is None:
                if len(self._buffer) < 4:
                    return packets
                self._expected = struct.unpack_from("<I", self._buffer)[0]
                del self._buffer[:4]
                if self._expected == 0 or self._expected > MAX_MESSAGE_SIZE:
                    self._expected = None
                    raise InvalidFrameError("frame length is outside the allowed range")
            if len(self._buffer) < self._expected:
                return packets
            body = bytes(self._buffer[: self._expected])
            del self._buffer[: self._expected]
            self._expected = None
            try:
                packet = rpcproto_pb2.Packet.FromString(body)
            except DecodeError as exc:
                raise MalformedPacketError("malformed packet") from exc
            validate_packet(packet)
            packets.append(packet)

    def finish(self) -> None:
        if self._expected is not None or self._buffer:
            raise TruncatedFrameError("stream ended before a complete frame")


class AsyncPacketWriter:
    """Serialize concurrent packet writes onto one async byte writer."""

    def __init__(self, writer: _AsyncWriter) -> None:
        self._writer = writer
        self._lock = asyncio.Lock()

    async def write(self, packet: rpcproto_pb2.Packet) -> None:
        frame = encode_packet(packet)
        async with self._lock:
            offset = 0
            while offset < len(frame):
                remaining = len(frame) - offset
                written = await self._writer.write(frame[offset:])
                if written <= 0:
                    raise ZeroProgressError("writer made no progress")
                if written > remaining:
                    raise WriteCountError("writer exceeded supplied bytes")
                offset += written


__all__ = [
    "MAX_MESSAGE_SIZE",
    "AsyncPacketWriter",
    "CodecError",
    "InvalidFrameError",
    "InvalidPacketError",
    "MalformedPacketError",
    "PacketDecoder",
    "TruncatedFrameError",
    "WriteCountError",
    "ZeroProgressError",
    "encode_packet",
    "validate_packet",
]
