from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable

from starpc.call import (
    Call,
    CallCancelledError,
    CallCompletedError,
    CallError,
    ClosedBeforeCompletionError,
    RemoteCallError,
)
from starpc.stream import ByteStream

Handler = Callable[[Call], Awaitable[None]]


class ServiceRegistry:
    def __init__(self) -> None:
        self._handlers: dict[tuple[str, str], Handler] = {}

    def register(self, service: str, method: str, handler: Handler) -> None:
        if not service or not method:
            raise ValueError("service and method are required")
        key = (service, method)
        if key in self._handlers:
            raise ValueError("service and method are already registered")
        self._handlers[key] = handler

    def _resolve(self, service: str, method: str) -> Handler | None:
        return self._handlers.get((service, method))


class Server:
    def __init__(self, registry: ServiceRegistry, inbound_capacity: int = 1) -> None:
        if inbound_capacity <= 0:
            raise ValueError("inbound_capacity must be positive")
        self._registry = registry
        self._inbound_capacity = inbound_capacity

    async def serve(self, stream: ByteStream) -> None:
        call: Call | None = None
        handler_task: asyncio.Task[None] | None = None
        abort_task: asyncio.Task[None] | None = None
        try:
            call = await Call.accept(stream, self._inbound_capacity)
            handler = self._registry._resolve(call.service, call.method)
            if handler is None:
                await call.finish(error=f"unknown method: {call.service}.{call.method}")
            else:

                async def invoke_handler() -> None:
                    await handler(call)

                handler_task = asyncio.create_task(invoke_handler())
                abort_task = asyncio.create_task(call.wait_aborted())
                done, _ = await asyncio.wait(
                    (handler_task, abort_task),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if abort_task in done:
                    with contextlib.suppress(CallError):
                        await abort_task
                    if not handler_task.done():
                        handler_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, CallError):
                        await handler_task
                    return
                abort_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await abort_task
                try:
                    await handler_task
                except asyncio.CancelledError:
                    raise
                except CallError:
                    return
                except Exception as exc:  # noqa: BLE001
                    with contextlib.suppress(CallCompletedError):
                        await call.finish(error=str(exc))
                else:
                    await call.finish()
            with contextlib.suppress(
                CallCancelledError, RemoteCallError, ClosedBeforeCompletionError
            ):
                await call.wait_closed()
        finally:
            if abort_task is not None and not abort_task.done():
                abort_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await abort_task
            if handler_task is not None and not handler_task.done():
                handler_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, CallError):
                    await handler_task
            if call is not None:
                await call.aclose()
            else:
                await stream.aclose()


__all__ = ["Handler", "Server", "ServiceRegistry"]
