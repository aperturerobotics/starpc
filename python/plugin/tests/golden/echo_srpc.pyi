from collections.abc import AsyncIterable, AsyncIterator
from typing import Protocol

from acme import common_pb2 as _acme_common_pb2
from acme import echo_pb2 as _acme_echo_pb2

from starpc.client import Client
from starpc.server import ServiceRegistry
from starpc.service import ServiceDescriptor

ECHO_SERVICE: ServiceDescriptor

class EchoClient:
    def __init__(self, client: Client, service: str | None = None) -> None: ...
    async def unary(
        self, request: _acme_echo_pb2.Request
    ) -> _acme_echo_pb2.Response: ...
    def server_stream(
        self, request: _acme_echo_pb2.Request
    ) -> AsyncIterator[_acme_echo_pb2.Response]: ...
    async def client_stream(
        self, requests: AsyncIterable[_acme_echo_pb2.Request]
    ) -> _acme_echo_pb2.Response: ...
    def bidi(
        self, requests: AsyncIterable[_acme_common_pb2.Shared]
    ) -> AsyncIterator[_acme_common_pb2.Shared]: ...

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
) -> None: ...
