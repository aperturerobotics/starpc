from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from typing import Protocol

from google.protobuf import empty_pb2 as _google_protobuf_empty_pb2

from echo import (
    echo_pb2 as _github_com_aperturerobotics_starpc_echo_echo_pb2,
)
from rpcstream import (
    rpcstream_pb2 as _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2,
)
from starpc.call import Call, CallProtocolError
from starpc.client import Client
from starpc.server import ServiceRegistry
from starpc.service import MethodDescriptor, ServiceDescriptor, bidirectional_bytes

ECHOER_SERVICE = ServiceDescriptor(
    "echo.Echoer",
    (
        MethodDescriptor(
            "Echo",
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            False,
            False,
        ),
        MethodDescriptor(
            "EchoServerStream",
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            False,
            True,
        ),
        MethodDescriptor(
            "EchoClientStream",
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            True,
            False,
        ),
        MethodDescriptor(
            "EchoBidiStream",
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg,
            True,
            True,
        ),
        MethodDescriptor(
            "RpcStream",
            _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket,
            _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket,
            True,
            True,
        ),
        MethodDescriptor(
            "DoNothing",
            _google_protobuf_empty_pb2.Empty,
            _google_protobuf_empty_pb2.Empty,
            False,
            False,
        ),
    ),
)


class EchoerClient:
    def __init__(self, client: Client, service: str | None = None) -> None:
        self._client = client
        self._service = service or "echo.Echoer"

    async def echo(
        self, request: _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
    ) -> _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg:
        call = await self._client.open_call(
            self._service, "Echo", request.SerializeToString(deterministic=True)
        )
        try:
            data = await call.receive()
            if data is None:
                raise CallProtocolError("missing unary response")
            response = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
            response.ParseFromString(data)
            if await call.receive() is not None:
                raise CallProtocolError("extra unary response")
            return response
        finally:
            await call.aclose()

    async def echo_server_stream(
        self, request: _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
    ) -> AsyncIterator[_github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg]:
        call = await self._client.open_call(
            self._service,
            "EchoServerStream",
            request.SerializeToString(deterministic=True),
        )
        try:
            while True:
                data = await call.receive()
                if data is None:
                    return
                response = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
                response.ParseFromString(data)
                yield response
        finally:
            await call.aclose()

    async def echo_client_stream(
        self,
        requests: AsyncIterable[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ],
    ) -> _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg:
        call = await self._client.open_call(self._service, "EchoClientStream")
        try:
            async for request in requests:
                await call.send(request.SerializeToString(deterministic=True))
            await call.finish()
            data = await call.receive()
            if data is None:
                raise CallProtocolError("missing client-stream response")
            response = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
            response.ParseFromString(data)
            if await call.receive() is not None:
                raise CallProtocolError("extra client-stream response")
            return response
        finally:
            await call.aclose()

    async def echo_bidi_stream(
        self,
        requests: AsyncIterable[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ],
    ) -> AsyncIterator[_github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg]:
        call = await self._client.open_call(self._service, "EchoBidiStream")

        async def encoded() -> AsyncIterator[bytes]:
            async for request in requests:
                yield request.SerializeToString(deterministic=True)

        async for data in bidirectional_bytes(call, encoded()):
            response = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
            response.ParseFromString(data)
            yield response

    async def rpc_stream(
        self,
        requests: AsyncIterable[
            _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket
        ],
    ) -> AsyncIterator[
        _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket
    ]:
        call = await self._client.open_call(self._service, "RpcStream")

        async def encoded() -> AsyncIterator[bytes]:
            async for request in requests:
                yield request.SerializeToString(deterministic=True)

        async for data in bidirectional_bytes(call, encoded()):
            response = _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket()
            response.ParseFromString(data)
            yield response

    async def do_nothing(
        self, request: _google_protobuf_empty_pb2.Empty
    ) -> _google_protobuf_empty_pb2.Empty:
        call = await self._client.open_call(
            self._service, "DoNothing", request.SerializeToString(deterministic=True)
        )
        try:
            data = await call.receive()
            if data is None:
                raise CallProtocolError("missing unary response")
            response = _google_protobuf_empty_pb2.Empty()
            response.ParseFromString(data)
            if await call.receive() is not None:
                raise CallProtocolError("extra unary response")
            return response
        finally:
            await call.aclose()


class EchoerServer(Protocol):
    async def echo(
        self, request: _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
    ) -> _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg: ...
    def echo_server_stream(
        self, request: _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
    ) -> AsyncIterator[_github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg]: ...
    async def echo_client_stream(
        self,
        requests: AsyncIterator[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ],
    ) -> _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg: ...
    def echo_bidi_stream(
        self,
        requests: AsyncIterator[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ],
    ) -> AsyncIterator[_github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg]: ...
    def rpc_stream(
        self,
        requests: AsyncIterator[
            _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket
        ],
    ) -> AsyncIterator[
        _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket
    ]: ...
    async def do_nothing(
        self, request: _google_protobuf_empty_pb2.Empty
    ) -> _google_protobuf_empty_pb2.Empty: ...


def register_echoer(
    registry: ServiceRegistry,
    implementation: EchoerServer,
    service: str = "echo.Echoer",
) -> None:
    async def echo_handler(call: Call) -> None:
        first = await call.receive()
        if first is None:
            raise CallProtocolError("missing initial request")
        request = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
        request.ParseFromString(first)
        response = await implementation.echo(request)
        await call.send(response.SerializeToString(deterministic=True))

    registry.register(service, "Echo", echo_handler)

    async def echo_server_stream_handler(call: Call) -> None:
        first = await call.receive()
        if first is None:
            raise CallProtocolError("missing initial request")
        request = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
        request.ParseFromString(first)
        async for response in implementation.echo_server_stream(request):
            await call.send(response.SerializeToString(deterministic=True))

    registry.register(service, "EchoServerStream", echo_server_stream_handler)

    async def echo_client_stream_handler(call: Call) -> None:
        async def requests() -> AsyncIterator[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ]:
            while True:
                data = await call.receive()
                if data is None:
                    return
                request = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
                request.ParseFromString(data)
                yield request

        response = await implementation.echo_client_stream(requests())
        await call.send(response.SerializeToString(deterministic=True))

    registry.register(service, "EchoClientStream", echo_client_stream_handler)

    async def echo_bidi_stream_handler(call: Call) -> None:
        async def requests() -> AsyncIterator[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ]:
            while True:
                data = await call.receive()
                if data is None:
                    return
                request = _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg()
                request.ParseFromString(data)
                yield request

        async for response in implementation.echo_bidi_stream(requests()):
            await call.send(response.SerializeToString(deterministic=True))

    registry.register(service, "EchoBidiStream", echo_bidi_stream_handler)

    async def rpc_stream_handler(call: Call) -> None:
        async def requests() -> AsyncIterator[
            _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket
        ]:
            while True:
                data = await call.receive()
                if data is None:
                    return
                request = _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket()
                request.ParseFromString(data)
                yield request

        async for response in implementation.rpc_stream(requests()):
            await call.send(response.SerializeToString(deterministic=True))

    registry.register(service, "RpcStream", rpc_stream_handler)

    async def do_nothing_handler(call: Call) -> None:
        first = await call.receive()
        if first is None:
            raise CallProtocolError("missing initial request")
        request = _google_protobuf_empty_pb2.Empty()
        request.ParseFromString(first)
        response = await implementation.do_nothing(request)
        await call.send(response.SerializeToString(deterministic=True))

    registry.register(service, "DoNothing", do_nothing_handler)
