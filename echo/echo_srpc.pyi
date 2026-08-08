from collections.abc import AsyncIterable, AsyncIterator
from typing import Protocol

from google.protobuf import empty_pb2 as _google_protobuf_empty_pb2

from echo import (
    echo_pb2 as _github_com_aperturerobotics_starpc_echo_echo_pb2,
)
from rpcstream import (
    rpcstream_pb2 as _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2,
)
from starpc.client import Client
from starpc.server import ServiceRegistry
from starpc.service import ServiceDescriptor

ECHOER_SERVICE: ServiceDescriptor

class EchoerClient:
    def __init__(self, client: Client, service: str | None = None) -> None: ...
    async def echo(
        self, request: _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
    ) -> _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg: ...
    def echo_server_stream(
        self, request: _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
    ) -> AsyncIterator[_github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg]: ...
    async def echo_client_stream(
        self,
        requests: AsyncIterable[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ],
    ) -> _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg: ...
    def echo_bidi_stream(
        self,
        requests: AsyncIterable[
            _github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg
        ],
    ) -> AsyncIterator[_github_com_aperturerobotics_starpc_echo_echo_pb2.EchoMsg]: ...
    def rpc_stream(
        self,
        requests: AsyncIterable[
            _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket
        ],
    ) -> AsyncIterator[
        _github_com_aperturerobotics_starpc_rpcstream_rpcstream_pb2.RpcStreamPacket
    ]: ...
    async def do_nothing(
        self, request: _google_protobuf_empty_pb2.Empty
    ) -> _google_protobuf_empty_pb2.Empty: ...

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
) -> None: ...
