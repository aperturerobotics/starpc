from __future__ import annotations

import asyncio
import contextlib
import unittest
from collections.abc import AsyncIterator
from typing import Any

from echo import echo_pb2
from echo.echo_srpc import ECHOER_SERVICE, EchoerClient, EchoerServer, register_echoer
from starpc.call import ClosedBeforeCompletionError
from starpc.client import Client
from starpc.server import Server, ServiceRegistry
from starpc.stream import ByteStream, memory_stream_pair

BODY = "hello world via starpc half-close test"


class OnceEchoServer:
    """Answers each call once and completes it."""

    async def echo(self, request: echo_pb2.EchoMsg) -> echo_pb2.EchoMsg:
        return request

    async def echo_server_stream(
        self, request: echo_pb2.EchoMsg
    ) -> AsyncIterator[echo_pb2.EchoMsg]:
        yield request

    async def echo_client_stream(
        self, requests: AsyncIterator[echo_pb2.EchoMsg]
    ) -> echo_pb2.EchoMsg:
        # Reply to the first message without waiting for the half-close.
        return await anext(requests)

    async def echo_bidi_stream(
        self, requests: AsyncIterator[echo_pb2.EchoMsg]
    ) -> AsyncIterator[echo_pb2.EchoMsg]:
        async for request in requests:
            yield request

    async def rpc_stream(self, requests: AsyncIterator[Any]) -> AsyncIterator[Any]:
        async for request in requests:
            yield request

    async def do_nothing(self, request: Any) -> Any:
        return request


class DrainedStream:
    """Sets drained when the client reads the end of the server's output."""

    def __init__(self, inner: ByteStream) -> None:
        self._inner = inner
        self.drained = asyncio.Event()

    async def read(self, max_bytes: int) -> bytes:
        data = await self._inner.read(max_bytes)
        if not data:
            self.drained.set()
        return data

    async def write(self, data: bytes) -> int:
        return await self._inner.write(data)

    async def write_eof(self) -> None:
        await self._inner.write_eof()

    async def aclose(self) -> None:
        await self._inner.aclose()


class LingeringCloseStream:
    """Closes the server's side after the client drained its output.

    The in-memory close discards unread data, so the server first ends its
    output and waits for the client to read it. Closed is set once the client's
    writes fail.
    """

    def __init__(self, inner: ByteStream, drained: asyncio.Event) -> None:
        self._inner = inner
        self._drained = drained
        self.closed = asyncio.Event()

    async def read(self, max_bytes: int) -> bytes:
        return await self._inner.read(max_bytes)

    async def write(self, data: bytes) -> int:
        return await self._inner.write(data)

    async def write_eof(self) -> None:
        await self._inner.write_eof()

    async def aclose(self) -> None:
        await self._inner.write_eof()
        await self._drained.wait()
        await self._inner.aclose()
        self.closed.set()


class DroppingStream:
    """Accepts CallStart, then drops the transport at the half-close."""

    def __init__(self) -> None:
        self.closed = False
        self._dropped = asyncio.Event()
        self._writes = 0

    async def read(self, max_bytes: int) -> bytes:
        del max_bytes
        await self._dropped.wait()
        raise ConnectionResetError("transport dropped")

    async def write(self, data: bytes) -> int:
        self._writes += 1
        if self._writes > 1:
            self._dropped.set()
            raise ConnectionResetError("transport dropped")
        return len(data)

    async def write_eof(self) -> None:
        raise AssertionError("a failed half-close must not end the output")

    async def aclose(self) -> None:
        self.closed = True


class GeneratedEchoTest(unittest.IsolatedAsyncioTestCase):
    async def run_rpc(
        self, implementation: EchoerServer
    ) -> tuple[Client, list[asyncio.Task[None]], list[ByteStream]]:
        registry = ServiceRegistry()
        register_echoer(registry, implementation)
        self.assertEqual(
            [method.name for method in ECHOER_SERVICE.methods],
            [
                "Echo",
                "EchoServerStream",
                "EchoClientStream",
                "EchoBidiStream",
                "RpcStream",
                "DoNothing",
            ],
        )
        self.assertEqual(ECHOER_SERVICE.name, "echo.Echoer")
        streams: list[ByteStream] = []
        tasks: list[asyncio.Task[None]] = []

        async def opener() -> ByteStream:
            client_stream, server_stream = memory_stream_pair(4096)
            streams.extend((client_stream, server_stream))
            tasks.append(asyncio.create_task(Server(registry).serve(server_stream)))
            return client_stream

        return Client(opener), tasks, streams

    async def stop_rpc(
        self,
        tasks: list[asyncio.Task[None]],
        streams: list[ByteStream],
    ) -> None:
        for stream in streams:
            await stream.aclose()
        for task in tasks:
            if not task.done():
                task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def test_client_stream_completed_before_finish(self) -> None:
        registry = ServiceRegistry()
        register_echoer(registry, OnceEchoServer())
        client_stream, server_stream = memory_stream_pair(4096)
        drained = DrainedStream(client_stream)
        lingering = LingeringCloseStream(server_stream, drained.drained)
        server = asyncio.create_task(Server(registry).serve(lingering))

        async def opener() -> ByteStream:
            return drained

        # Send the one request and wait for the call to end.
        async def requests() -> AsyncIterator[echo_pb2.EchoMsg]:
            yield echo_pb2.EchoMsg(body=BODY)
            await lingering.closed.wait()

        # The half-close fails, but the reply is still readable.
        echo = EchoerClient(Client(opener))
        response = await echo.echo_client_stream(requests())
        self.assertEqual(response.body, BODY)
        await server

    async def test_client_stream_transport_failure_before_finish(self) -> None:
        stream = DroppingStream()

        async def opener() -> ByteStream:
            return stream

        # Receive reports that the call ended without a verdict.
        echo = EchoerClient(Client(opener))
        with self.assertRaises(ClosedBeforeCompletionError):
            await echo.echo_client_stream(_empty())
        self.assertTrue(stream.closed)

    async def test_unary_and_server_stream(self) -> None:
        class Implementation:
            async def echo(self, request: echo_pb2.EchoMsg) -> echo_pb2.EchoMsg:
                return echo_pb2.EchoMsg(body=request.body + "!")

            async def echo_server_stream(
                self, request: echo_pb2.EchoMsg
            ) -> AsyncIterator[echo_pb2.EchoMsg]:
                for suffix in ("-1", "-2"):
                    yield echo_pb2.EchoMsg(body=request.body + suffix)

            async def echo_client_stream(
                self, requests: AsyncIterator[echo_pb2.EchoMsg]
            ) -> echo_pb2.EchoMsg:
                return echo_pb2.EchoMsg()

            async def echo_bidi_stream(
                self, requests: AsyncIterator[echo_pb2.EchoMsg]
            ) -> AsyncIterator[echo_pb2.EchoMsg]:
                async for request in requests:
                    yield request

            async def rpc_stream(
                self, requests: AsyncIterator[Any]
            ) -> AsyncIterator[Any]:
                async for request in requests:
                    yield request

            async def do_nothing(self, request: Any) -> Any:
                return request

        client, tasks, streams = await self.run_rpc(Implementation())
        try:
            echo = EchoerClient(client)
            response = await echo.echo(echo_pb2.EchoMsg(body="x"))
            self.assertEqual(response.body, "x!")
            values = [
                message
                async for message in echo.echo_server_stream(echo_pb2.EchoMsg(body="x"))
            ]
            self.assertEqual([message.body for message in values], ["x-1", "x-2"])
        finally:
            await self.stop_rpc(tasks, streams)

    async def test_client_stream_zero_requests(self) -> None:
        class Implementation:
            async def echo(self, request: echo_pb2.EchoMsg) -> echo_pb2.EchoMsg:
                return request

            async def echo_server_stream(
                self, request: echo_pb2.EchoMsg
            ) -> AsyncIterator[echo_pb2.EchoMsg]:
                if False:
                    yield request

            async def echo_client_stream(
                self, requests: AsyncIterator[echo_pb2.EchoMsg]
            ) -> echo_pb2.EchoMsg:
                count = 0
                async for _ in requests:
                    count += 1
                return echo_pb2.EchoMsg(body=str(count))

            async def echo_bidi_stream(
                self, requests: AsyncIterator[echo_pb2.EchoMsg]
            ) -> AsyncIterator[echo_pb2.EchoMsg]:
                async for request in requests:
                    yield request

            async def rpc_stream(
                self, requests: AsyncIterator[Any]
            ) -> AsyncIterator[Any]:
                async for request in requests:
                    yield request

            async def do_nothing(self, request: Any) -> Any:
                return request

        client, tasks, streams = await self.run_rpc(Implementation())
        try:
            echo = EchoerClient(client)
            result = await echo.echo_client_stream(_empty())
            self.assertEqual(result.body, "0")
        finally:
            await self.stop_rpc(tasks, streams)

    async def test_bidi_interleaving(self) -> None:
        class Implementation:
            async def echo(self, request: echo_pb2.EchoMsg) -> echo_pb2.EchoMsg:
                return request

            async def echo_server_stream(
                self, request: echo_pb2.EchoMsg
            ) -> AsyncIterator[echo_pb2.EchoMsg]:
                if False:
                    yield request

            async def echo_client_stream(
                self, requests: AsyncIterator[echo_pb2.EchoMsg]
            ) -> echo_pb2.EchoMsg:
                return echo_pb2.EchoMsg()

            async def echo_bidi_stream(
                self, requests: AsyncIterator[echo_pb2.EchoMsg]
            ) -> AsyncIterator[echo_pb2.EchoMsg]:
                yield echo_pb2.EchoMsg(body="initial")
                async for request in requests:
                    yield echo_pb2.EchoMsg(body=request.body.upper())

            async def rpc_stream(
                self, requests: AsyncIterator[Any]
            ) -> AsyncIterator[Any]:
                async for request in requests:
                    yield request

            async def do_nothing(self, request: Any) -> Any:
                return request

        client, tasks, streams = await self.run_rpc(Implementation())
        try:
            echo = EchoerClient(client)
            stream = echo.echo_bidi_stream(_requests())
            self.assertEqual((await stream.__anext__()).body, "initial")
            self.assertEqual((await stream.__anext__()).body, "A")
            with self.assertRaises(StopAsyncIteration):
                await stream.__anext__()
        finally:
            await self.stop_rpc(tasks, streams)


async def _empty() -> AsyncIterator[echo_pb2.EchoMsg]:
    if False:
        yield echo_pb2.EchoMsg()


async def _requests() -> AsyncIterator[echo_pb2.EchoMsg]:
    yield echo_pb2.EchoMsg(body="a")


if __name__ == "__main__":
    unittest.main()
