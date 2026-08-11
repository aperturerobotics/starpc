from __future__ import annotations

# The checkout supplies generated message packages outside the installed wheel.
import asyncio
import signal
import sys
from collections.abc import AsyncIterator
from pathlib import Path

from google.protobuf import empty_pb2

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from echo import echo_pb2
from echo.echo_srpc import register_echoer
from rpcstream import rpcstream_pb2
from starpc.rpcstream import ComponentRegistry, handle_rpc_stream
from starpc.server import Server, ServiceRegistry
from starpc.stream import TCPStreamServer


class Implementation:
    def __init__(self, components: ComponentRegistry) -> None:
        self._components = components
        self._release_task: asyncio.Task[None] | None = None
        self._release_complete = asyncio.Event()

    async def _release_component(self) -> None:
        try:
            await self._components.unregister("release")
        finally:
            self._release_complete.set()

    async def wait_for_release(self) -> None:
        task = self._release_task
        if task is not None:
            await task

    async def echo(self, request: echo_pb2.EchoMsg) -> echo_pb2.EchoMsg:
        if request.body == "__nested_error__":
            raise RuntimeError("nested terminal error")
        if request.body == "__nested_release__":
            if self._release_task is None:
                self._release_task = asyncio.create_task(self._release_component())
            await asyncio.Future()
        if request.body == "__nested_release_status__":
            await self._release_complete.wait()
            await self.wait_for_release()
            return echo_pb2.EchoMsg(body="released")
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

    def rpc_stream(
        self, requests: AsyncIterator[rpcstream_pb2.RpcStreamPacket]
    ) -> AsyncIterator[rpcstream_pb2.RpcStreamPacket]:
        return handle_rpc_stream(requests, self._components)

    async def do_nothing(self, request: empty_pb2.Empty) -> empty_pb2.Empty:
        return request


async def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    registry = ServiceRegistry()
    components = ComponentRegistry()
    await components.register("test", Server(registry))
    await components.register("release", Server(registry))
    implementation = Implementation(components)
    register_echoer(registry, implementation)
    server = TCPStreamServer()
    await server.start("127.0.0.1", port)
    host, bound_port = server.address
    print(f"LISTENING {host}:{bound_port}", flush=True)
    rpc_server = Server(registry)
    tasks: set[asyncio.Task[None]] = set()
    errors: list[BaseException] = []
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopping.set)

    def observe_task(task: asyncio.Task[None]) -> None:
        tasks.discard(task)
        if not task.cancelled() and (error := task.exception()) is not None:
            errors.append(error)

    try:
        while not stopping.is_set():
            accepting = asyncio.create_task(server.accept())
            stopped = asyncio.create_task(stopping.wait())
            done, _ = await asyncio.wait(
                {accepting, stopped}, return_when=asyncio.FIRST_COMPLETED
            )
            if stopped in done:
                accepting.cancel()
                await asyncio.gather(accepting, return_exceptions=True)
                break
            stopped.cancel()
            await asyncio.gather(stopped, return_exceptions=True)
            stream = accepting.result()
            task = asyncio.create_task(rpc_server.serve(stream))
            tasks.add(task)
            task.add_done_callback(observe_task)
    finally:
        await server.aclose()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await implementation.wait_for_release()
        await components.unregister("test")
        await components.unregister("release")
        if errors:
            raise ExceptionGroup("cross-language server tasks failed", errors)
        if components._components or components._retired:
            raise RuntimeError("nested component cleanup is incomplete")
        print("NESTED_CLEAN", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
