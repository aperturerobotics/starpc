from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from typing import Protocol

from acme import common_pb2 as _acme_common_pb2
from acme import echo_pb2 as _acme_echo_pb2

from starpc.call import Call, CallProtocolError
from starpc.client import Client
from starpc.server import ServiceRegistry
from starpc.service import MethodDescriptor, ServiceDescriptor, bidirectional_bytes

ECHO_SERVICE = ServiceDescriptor(
    "acme.Echo",
    (
        MethodDescriptor(
            "Unary", _acme_echo_pb2.Request, _acme_echo_pb2.Response, False, False
        ),
        MethodDescriptor(
            "ServerStream", _acme_echo_pb2.Request, _acme_echo_pb2.Response, False, True
        ),
        MethodDescriptor(
            "ClientStream", _acme_echo_pb2.Request, _acme_echo_pb2.Response, True, False
        ),
        MethodDescriptor(
            "Bidi", _acme_common_pb2.Shared, _acme_common_pb2.Shared, True, True
        ),
    ),
)


class EchoClient:
    def __init__(self, client: Client, service: str | None = None) -> None:
        self._client = client
        self._service = service or "acme.Echo"

    async def unary(self, request: _acme_echo_pb2.Request) -> _acme_echo_pb2.Response:
        call = await self._client.open_call(
            self._service, "Unary", request.SerializeToString(deterministic=True)
        )
        try:
            await call.finish()
            data = await call.receive()
            if data is None:
                raise CallProtocolError("missing unary response")
            response = _acme_echo_pb2.Response()
            response.ParseFromString(data)
            if await call.receive() is not None:
                raise CallProtocolError("extra unary response")
            return response
        finally:
            await call.aclose()

    async def server_stream(
        self, request: _acme_echo_pb2.Request
    ) -> AsyncIterator[_acme_echo_pb2.Response]:
        call = await self._client.open_call(
            self._service, "ServerStream", request.SerializeToString(deterministic=True)
        )
        try:
            await call.finish()
            while True:
                data = await call.receive()
                if data is None:
                    return
                response = _acme_echo_pb2.Response()
                response.ParseFromString(data)
                yield response
        finally:
            await call.aclose()

    async def client_stream(
        self, requests: AsyncIterable[_acme_echo_pb2.Request]
    ) -> _acme_echo_pb2.Response:
        call = await self._client.open_call(self._service, "ClientStream")
        try:
            async for request in requests:
                await call.send(request.SerializeToString(deterministic=True))
            await call.finish()
            data = await call.receive()
            if data is None:
                raise CallProtocolError("missing client-stream response")
            response = _acme_echo_pb2.Response()
            response.ParseFromString(data)
            if await call.receive() is not None:
                raise CallProtocolError("extra client-stream response")
            return response
        finally:
            await call.aclose()

    async def bidi(
        self, requests: AsyncIterable[_acme_common_pb2.Shared]
    ) -> AsyncIterator[_acme_common_pb2.Shared]:
        call = await self._client.open_call(self._service, "Bidi")

        async def encoded() -> AsyncIterator[bytes]:
            async for request in requests:
                yield request.SerializeToString(deterministic=True)

        async for data in bidirectional_bytes(call, encoded()):
            response = _acme_common_pb2.Shared()
            response.ParseFromString(data)
            yield response


class EchoServer(Protocol):
    async def unary(
        self, request: _acme_echo_pb2.Request
    ) -> _acme_echo_pb2.Response: ...
    def server_stream(
        self, request: _acme_echo_pb2.Request
    ) -> AsyncIterator[_acme_echo_pb2.Response]: ...
    async def client_stream(
        self, requests: AsyncIterator[_acme_echo_pb2.Request]
    ) -> _acme_echo_pb2.Response: ...
    def bidi(
        self, requests: AsyncIterator[_acme_common_pb2.Shared]
    ) -> AsyncIterator[_acme_common_pb2.Shared]: ...


def register_echo(
    registry: ServiceRegistry, implementation: EchoServer, service: str = "acme.Echo"
) -> None:
    async def unary_handler(call: Call) -> None:
        first = await call.receive()
        if first is None:
            raise CallProtocolError("missing initial request")
        extra = await call.receive()
        if extra is not None:
            raise CallProtocolError("extra initial request")
        request = _acme_echo_pb2.Request()
        request.ParseFromString(first)
        response = await implementation.unary(request)
        await call.send(response.SerializeToString(deterministic=True))
        await call.finish()

    registry.register(service, "Unary", unary_handler)

    async def server_stream_handler(call: Call) -> None:
        first = await call.receive()
        if first is None:
            raise CallProtocolError("missing initial request")
        extra = await call.receive()
        if extra is not None:
            raise CallProtocolError("extra initial request")
        request = _acme_echo_pb2.Request()
        request.ParseFromString(first)
        async for response in implementation.server_stream(request):
            await call.send(response.SerializeToString(deterministic=True))
        await call.finish()

    registry.register(service, "ServerStream", server_stream_handler)

    async def client_stream_handler(call: Call) -> None:
        async def requests() -> AsyncIterator[_acme_echo_pb2.Request]:
            while True:
                data = await call.receive()
                if data is None:
                    return
                request = _acme_echo_pb2.Request()
                request.ParseFromString(data)
                yield request

        response = await implementation.client_stream(requests())
        await call.send(response.SerializeToString(deterministic=True))
        await call.finish()

    registry.register(service, "ClientStream", client_stream_handler)

    async def bidi_handler(call: Call) -> None:
        async def requests() -> AsyncIterator[_acme_common_pb2.Shared]:
            while True:
                data = await call.receive()
                if data is None:
                    return
                request = _acme_common_pb2.Shared()
                request.ParseFromString(data)
                yield request

        async for response in implementation.bidi(requests()):
            await call.send(response.SerializeToString(deterministic=True))
        await call.finish()

    registry.register(service, "Bidi", bidi_handler)
