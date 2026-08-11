from __future__ import annotations

# The checkout supplies generated message packages outside the installed wheel.
import asyncio
import sys
from collections.abc import AsyncIterator
from pathlib import Path

from google.protobuf import empty_pb2

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from echo import echo_pb2
from echo.echo_srpc import EchoerClient
from starpc.call import CallCancelledError, RemoteCallError
from starpc.client import Client
from starpc.stream import open_tcp_stream


async def main() -> None:
    args = sys.argv[1:]
    nested = args[:1] in (["--nested"], ["--nested-release"])
    strict_nested = args[:1] == ["--nested-release"]
    if nested:
        args = args[1:]
    if len(args) != 1 or ":" not in args[0]:
        raise ValueError("usage: python-client.py [--nested] host:port")
    host, port_text = args[0].rsplit(":", 1)
    port = int(port_text)
    raw_client = Client(lambda: open_tcp_stream(host, port))
    client = EchoerClient(raw_client)
    body = "hello world via python"
    response = await client.echo(echo_pb2.EchoMsg(body=body))
    if response.body != body:
        raise RuntimeError(f"unexpected unary response: {response.body!r}")
    empty_response = await client.echo(echo_pb2.EchoMsg())
    if empty_response.body:
        raise RuntimeError(f"unexpected empty unary response: {empty_response.body!r}")
    received = [
        message
        async for message in client.echo_server_stream(echo_pb2.EchoMsg(body=body))
    ]
    if len(received) != 5 or any(message.body != body for message in received):
        raise RuntimeError("unexpected server-stream response")
    client_stream = await client.echo_client_stream(_one_request(body))
    if client_stream.body != body:
        raise RuntimeError("unexpected client-stream response")
    bidi = client.echo_bidi_stream(_one_request(body))
    initial = await bidi.__anext__()
    if initial.body != "hello from server":
        raise RuntimeError("unexpected bidi initial response")
    echoed = await bidi.__anext__()
    if echoed.body != body:
        raise RuntimeError("unexpected bidi echo")
    try:
        await bidi.__anext__()
    except StopAsyncIteration:
        pass
    else:
        raise RuntimeError("bidi stream did not terminate")
    empty = await client.do_nothing(empty_pb2.Empty())
    if empty.ByteSize() != 0:
        raise RuntimeError("unexpected DoNothing response")

    unknown = await raw_client.open_call("missing.Service", "Missing")
    try:
        await unknown.finish()
        try:
            await unknown.receive()
        except RemoteCallError:
            pass
        else:
            raise RuntimeError("unknown method did not return a remote error")
    finally:
        await unknown.aclose()

    cancelled = await raw_client.open_call("echo.Echoer", "EchoBidiStream")
    await cancelled.cancel()
    try:
        await cancelled.wait_closed()
    except CallCancelledError:
        pass
    await cancelled.aclose()
    if nested:
        await run_nested_test(client, strict_nested)
    print("All tests passed.")


async def run_nested_test(client: EchoerClient, strict: bool = False) -> None:
    from starpc.rpcstream import (
        RpcStreamRemoteError,
        build_rpc_stream_open_stream,
    )

    nested_client = Client(build_rpc_stream_open_stream("test", client.rpc_stream))
    nested_echo = EchoerClient(nested_client)
    body = "hello world via nested python"
    response = await nested_echo.echo(echo_pb2.EchoMsg(body=body))
    if response.body != body:
        raise RuntimeError(f"unexpected nested unary response: {response.body!r}")

    if strict:
        try:
            await nested_echo.echo(echo_pb2.EchoMsg(body="__nested_error__"))
        except RemoteCallError:
            pass
        else:
            raise RuntimeError("terminal nested error unexpectedly succeeded")

    if strict:
        missing = Client(build_rpc_stream_open_stream("missing", client.rpc_stream))
        try:
            await missing.open_call("echo.Echoer", "Echo")
        except RpcStreamRemoteError:
            pass
        else:
            raise RuntimeError("unknown component unexpectedly succeeded")

    terminal = await nested_client.open_call("missing.Service", "Missing")
    try:
        await terminal.receive()
    except RemoteCallError:
        pass
    else:
        raise RuntimeError("unknown nested method unexpectedly succeeded")
    finally:
        await terminal.aclose()

    cancelled = await nested_client.open_call("echo.Echoer", "EchoBidiStream")
    await cancelled.send(
        echo_pb2.EchoMsg(body="nested later data").SerializeToString(deterministic=True)
    )
    await cancelled.cancel()
    try:
        await cancelled.wait_closed()
    except CallCancelledError:
        pass
    await cancelled.aclose()


async def _one_request(body: str) -> AsyncIterator[echo_pb2.EchoMsg]:
    yield echo_pb2.EchoMsg(body=body)


if __name__ == "__main__":
    asyncio.run(main())
