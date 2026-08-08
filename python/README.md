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
