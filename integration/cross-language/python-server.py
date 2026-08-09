from __future__ import annotations

# The checkout supplies generated message packages outside the installed wheel.
import asyncio
import sys
from collections.abc import AsyncIterator
from pathlib import Path

from google.protobuf import empty_pb2

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from echo import echo_pb2
from echo.echo_srpc import register_echoer
from rpcstream import rpcstream_pb2
from starpc.server import Server, ServiceRegistry
from starpc.stream import TCPStreamServer


class Implementation:
    async def echo(self, request: echo_pb2.EchoMsg) -> echo_pb2.EchoMsg:
        return echo_pb2.EchoMsg(body=request.body)

    async def echo_server_stream(
        self, request: echo_pb2.EchoMsg
    ) -> AsyncIterator[echo_pb2.EchoMsg]:
        for _ in range(5):
            yield echo_pb2.EchoMsg(body=request.body)
            await asyncio.sleep(0.2)

    async def echo_client_stream(
        self, requests: AsyncIterator[echo_pb2.EchoMsg]
    ) -> echo_pb2.EchoMsg:
        async for request in requests:
            return request
        return echo_pb2.EchoMsg()

    async def echo_bidi_stream(
        self, requests: AsyncIterator[echo_pb2.EchoMsg]
    ) -> AsyncIterator[echo_pb2.EchoMsg]:
        yield echo_pb2.EchoMsg(body="hello from server")
        async for request in requests:
            yield request

    async def rpc_stream(
        self, requests: AsyncIterator[rpcstream_pb2.RpcStreamPacket]
    ) -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
        if False:
            yield rpcstream_pb2.RpcStreamPacket()
        raise NotImplementedError("nested RPC streams are not implemented")

    async def do_nothing(self, request: empty_pb2.Empty) -> empty_pb2.Empty:
        return request


async def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    registry = ServiceRegistry()
    register_echoer(registry, Implementation())
    server = TCPStreamServer()
    await server.start("127.0.0.1", port)
    host, bound_port = server.address
    print(f"LISTENING {host}:{bound_port}", flush=True)
    rpc_server = Server(registry)
    tasks: set[asyncio.Task[None]] = set()

    def observe_task(task: asyncio.Task[None]) -> None:
        tasks.discard(task)
        if not task.cancelled():
            task.exception()

    try:
        while True:
            stream = await server.accept()
            task = asyncio.create_task(rpc_server.serve(stream))
            tasks.add(task)
            task.add_done_callback(observe_task)
    finally:
        await server.aclose()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
