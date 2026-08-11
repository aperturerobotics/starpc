from __future__ import annotations

import asyncio
import unittest

from starpc.call import Call
from starpc.server import Server, ServiceRegistry
from starpc.stream import memory_stream_pair


class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_serve_retrieves_finished_handler_task(self) -> None:
        client_stream, server_stream = memory_stream_pair(1024)
        handler_started = asyncio.Event()
        serve_task: asyncio.Task[None] | None = None
        loop = asyncio.get_running_loop()
        unhandled: list[dict[str, object]] = []
        previous_handler = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: unhandled.append(context))

        async def handler(_call: Call) -> None:
            handler_started.set()
            assert serve_task is not None
            loop.call_soon(serve_task.cancel)
            raise RuntimeError("handler failed")

        registry = ServiceRegistry()
        registry.register("test.Service", "Do", handler)
        server = Server(registry)
        client_call: Call | None = None
        try:
            client_call = await Call.open(client_stream, "test.Service", "Do")
            serve_task = asyncio.create_task(server.serve(server_stream))
            await asyncio.wait_for(handler_started.wait(), 1)
            with self.assertRaises(asyncio.CancelledError):
                await serve_task
            await asyncio.sleep(0)
            self.assertEqual(unhandled, [])
        finally:
            loop.set_exception_handler(previous_handler)
            if client_call is not None:
                await client_call.aclose()
            await client_stream.aclose()
            await server_stream.aclose()


if __name__ == "__main__":
    unittest.main()
