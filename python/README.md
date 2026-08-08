# StarPC Python package seed

The root `starpc` distribution packages the handwritten runtime namespace and
the Common-generated official `srpc` and `rpcstream` control messages. The
`python/plugin` workspace member is a separate `starpc-python-plugin`
distribution and is not bundled into the runtime.

Regenerate the authoritative Python artifacts from the configured Common
WASM generator with the repository command:

```sh
bun run gen
```

Do not copy generated files from another checkout or use system `protoc`.
The plugin remains an explicit not-implemented handshake stub in this seed;
codec, asyncio calls, and service generation are later work.
