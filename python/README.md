# StarPC Python packages

The root `starpc` distribution contains the transport-neutral asyncio runtime
and the Common-generated official `srpc` and `rpcstream` control messages. The
`python/plugin` workspace member is the separate `starpc-python-plugin` build
tool. It reads protoc requests and emits typed service modules; it does not
bundle the runtime that those modules import. Applications install `starpc` as
a runtime dependency and provision `starpc-python-plugin` only where they
generate code.

Regenerate every authoritative protobuf and service artifact through Common's
embedded WASM protoc and the project-owned plugin:

```sh
uv sync --all-packages
bun run gen
```

Do not use a system `protoc` or copy generated files from another checkout.
The repository command formats generated Python and existing-language outputs
and is deterministic across repeated runs.

## Nested RPC streams

Register a component with a bounded inner server, then expose its stream method:

```python
from starpc.client import Client
from starpc.rpcstream import (
    ComponentRegistry,
    build_rpc_stream_open_stream,
    handle_rpc_stream,
)
from starpc.server import Server

components = ComponentRegistry()
await components.register("worker", Server(registry))

def rpc_stream(requests):
    return handle_rpc_stream(requests, components)
```

A client opens the acknowledged component stream with the existing StarPC
client owner:

```python
open_stream = build_rpc_stream_open_stream("worker", caller)
client = Client(open_stream)
```

`caller` accepts and returns an async iterable of `RpcStreamPacket` messages;
`handle_rpc_stream` performs the `Init`/`Ack` handshake and proxies embedded
StarPC packets. Unregistering a component waits for active nested routes to
finish before its release callback runs.
