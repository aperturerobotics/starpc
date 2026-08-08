from typing import Protocol

from mock import (
    mock_pb2 as _github_com_aperturerobotics_starpc_mock_mock_pb2,
)
from starpc.client import Client
from starpc.server import ServiceRegistry
from starpc.service import ServiceDescriptor

MOCK_SERVICE: ServiceDescriptor

class MockClient:
    def __init__(self, client: Client, service: str | None = None) -> None: ...
    async def mock_request(
        self, request: _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg
    ) -> _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg: ...

class MockServer(Protocol):
    async def mock_request(
        self, request: _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg
    ) -> _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg: ...

def register_mock(
    registry: ServiceRegistry,
    implementation: MockServer,
    service: str = "e2e.mock.Mock",
) -> None: ...
