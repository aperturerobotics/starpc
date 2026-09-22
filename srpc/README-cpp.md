# Starpc C++

Starpc provides generated C++ clients and handlers for unary and streaming
protobuf RPCs. It uses the same packets as the Go, TypeScript, Rust, and Python
implementations. C++20 and the protobuf runtime matching the generated headers
are required.

## Build

```sh
go mod vendor
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure --timeout 60
```

A parent project can use `add_subdirectory(path/to/starpc)` and link
`starpc::starpc`. An existing `protobuf::libprotobuf` target is reused, including
its include paths and compile definitions. Otherwise, set
`STARPC_USE_SYSTEM_PROTOBUF=ON` to find an installed protobuf package, or vendor
Go dependencies before configuring. Tests and examples default to off when
Starpc is a subdirectory. The library includes the nested RPC messages even
when examples are disabled.

Generate service bindings with `protoc-gen-starpc-cpp`. The generated streaming
wrappers expose `Send`, `Recv`, `Close`, `CloseSend`, and `StopToken` as applicable.
See `echo/echo.proto` and its generated bindings for each RPC shape.

## Connect a transport

One Starpc call uses one ordered, bidirectional packet stream. A streaming RPC
can carry successive commands and events over a single process connection.
Independent concurrent calls require separate streams from the transport.

A C++ server lends an `Invoker` and `PacketWriter` to `ServerRPC`, then feeds
received packets to `HandlePacketData`. Call `HandleStreamClose` when input ends,
including errors. Serialize those input callbacks. Destruction cancels the call
and joins its handler before the borrowed objects can be released.

For a client, supply an `OpenStreamFunc` to `NewClient`. Its returned writer must
keep receive callbacks alive until destruction. `Close` must interrupt blocked
transport reads and writes without waiting for those callbacks; destruction must
join any receive thread. This permits a callback to close its own transport.

Packet writers serialize their writes and allow `Close` concurrently with a
write. Close is idempotent. A byte-stream transport uses a four-byte unsigned
little-endian length followed by the serialized `srpc.Packet`, matching Go's
`PacketReadWriter`. Reject empty frames and frames larger than 10,000,000 bytes
before allocating their bodies. The process-pipe integration test demonstrates
this framing with a Go client and a C++ child process.

## Cancellation and completion

`CloseSend` ends outgoing messages while allowing incoming replies. Explicit
remote completion becomes EOF after queued messages are read. A disconnected
transport without completion returns `ClosedBeforeCompletion`. Remote errors
return `RemoteError`; `CommonRPC::RemoteErrorMessage` retains the peer's text.

Handlers performing work outside `Recv` must observe their stream's `StopToken`.
Destroying a server waits for its handler to return; it cannot forcibly terminate
application code that ignores cancellation. Dropping a client stream closes its
transport and releases its receive thread. Nested RPCs release their service
only after the nested handler returns.

An unread C++ call is limited to 4 MiB or 1,024 queued messages, including empty
messages. Exceeding either bound ends the call with `ResourceExhausted`.
