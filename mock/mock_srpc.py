from __future__ import annotations

from typing import Protocol

from mock import (
    mock_pb2 as _github_com_aperturerobotics_starpc_mock_mock_pb2,
)
from starpc.call import Call, CallProtocolError
from starpc.client import Client
from starpc.server import ServiceRegistry
from starpc.service import MethodDescriptor, ServiceDescriptor

MOCK_SERVICE = ServiceDescriptor(
    "e2e.mock.Mock",
    (
        MethodDescriptor(
            "MockRequest",
            _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg,
            _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg,
            False,
            False,
        ),
    ),
)


class MockClient:
    def __init__(self, client: Client, service: str | None = None) -> None:
        self._client = client
        self._service = service or "e2e.mock.Mock"

    async def mock_request(
        self, request: _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg
    ) -> _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg:
        call = await self._client.open_call(
            self._service, "MockRequest", request.SerializeToString(deterministic=True)
        )
        try:
            data = await call.receive()
            if data is None:
                raise CallProtocolError("missing unary response")
            response = _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg()
            response.ParseFromString(data)
            if await call.receive() is not None:
                raise CallProtocolError("extra unary response")
            return response
        finally:
            await call.aclose()


class MockServer(Protocol):
    async def mock_request(
        self, request: _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg
    ) -> _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg: ...


def register_mock(
    registry: ServiceRegistry,
    implementation: MockServer,
    service: str = "e2e.mock.Mock",
) -> None:
    async def mock_request_handler(call: Call) -> None:
        first = await call.receive()
        if first is None:
            raise CallProtocolError("missing initial request")
        request = _github_com_aperturerobotics_starpc_mock_mock_pb2.MockMsg()
        request.ParseFromString(first)
        response = await implementation.mock_request(request)
        await call.send(response.SerializeToString(deterministic=True))

    registry.register(service, "MockRequest", mock_request_handler)
