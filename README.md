# starpc

[![npm](https://img.shields.io/npm/v/starpc?style=flat-square)](https://www.npmjs.com/package/starpc)
[![crates.io](https://img.shields.io/crates/v/starpc.svg?style=flat-square)](https://crates.io/crates/starpc)
[![Build status](https://img.shields.io/github/actions/workflow/status/aperturerobotics/starpc/tests.yml?style=flat-square&branch=master)](https://github.com/aperturerobotics/starpc/actions)
[![GoDoc Widget]][GoDoc] [![Go Report Card Widget]][Go Report Card]

> Streaming Protobuf RPC with bidirectional streaming over any multiplexed transport.

[GoDoc]: https://godoc.org/github.com/aperturerobotics/starpc
[GoDoc Widget]: https://godoc.org/github.com/aperturerobotics/starpc?status.svg
[Go Report Card Widget]: https://goreportcard.com/badge/github.com/aperturerobotics/starpc
[Go Report Card]: https://goreportcard.com/report/github.com/aperturerobotics/starpc

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Examples](#examples)
  - [Protobuf Definition](#protobuf)
  - [Go Implementation](#go)
  - [TypeScript Implementation](#typescript)
  - [Rust Implementation](#rust)
- [Debugging](#debugging)
- [Development Setup](#development-setup)
- [Support](#support)

## Features

- Full [Proto3 services] support for TypeScript, Go, and Rust
- Bidirectional streaming in browsers via WebSocket or WebRTC
- Built on libp2p streams with [@chainsafe/libp2p-yamux]
- Efficient multiplexing of RPCs over single connections
- Zero-reflection Go via [protobuf-go-lite]
- Lightweight TypeScript via [protobuf-es-lite]
- Async Rust via [prost] and [tokio]
- Sub-stream support via [rpcstream]

[Proto3 services]: https://developers.google.com/protocol-buffers/docs/proto3#services
[@chainsafe/libp2p-yamux]: https://github.com/ChainSafe/js-libp2p-yamux
[protobuf-go-lite]: https://github.com/aperturerobotics/protobuf-go-lite
[protobuf-es-lite]: https://github.com/aperturerobotics/protobuf-es-lite
[prost]: https://github.com/tokio-rs/prost
[tokio]: https://github.com/tokio-rs/tokio
[rpcstream]: ./rpcstream

## Installation

```bash
# Clone the template project
git clone -b starpc https://github.com/aperturerobotics/protobuf-project
cd protobuf-project

# Install dependencies
npm install
yarn install
pnpm install
bun install

# Generate TypeScript and Go code
bun run gen
```

## Quick Start

1. Start with the [protobuf-project] template repository (starpc branch)
2. Add your .proto files to the project
3. Run `bun run gen` to generate TypeScript and Go code
4. Implement your services using the examples below

[protobuf-project]: https://github.com/aperturerobotics/protobuf-project/tree/starpc

### Protobuf

The following examples use the [echo](./echo/echo.proto) protobuf sample.

```protobuf
syntax = "proto3";
package echo;

// Echoer service returns the given message.
service Echoer {
  // Echo returns the given message.
  rpc Echo(EchoMsg) returns (EchoMsg);
  // EchoServerStream is an example of a server -> client one-way stream.
  rpc EchoServerStream(EchoMsg) returns (stream EchoMsg);
  // EchoClientStream is an example of client->server one-way stream.
  rpc EchoClientStream(stream EchoMsg) returns (EchoMsg);
  // EchoBidiStream is an example of a two-way stream.
  rpc EchoBidiStream(stream EchoMsg) returns (stream EchoMsg);
}

// EchoMsg is the message body for Echo.
message EchoMsg {
  string body = 1;
}
```

### Go

This example demonstrates both the server and client:

```go
// construct the server
echoServer := &echo.EchoServer{}
mux := srpc.NewMux()
if err := echo.SRPCRegisterEchoer(mux, echoServer); err != nil {
	t.Fatal(err.Error())
}
server := srpc.NewServer(mux)

// create an in-memory connection to the server
openStream := srpc.NewServerPipe(server)

// construct the client
client := srpc.NewClient(openStream)

// construct the client rpc interface
clientEcho := echo.NewSRPCEchoerClient(client)
ctx := context.Background()
bodyTxt := "hello world"
out, err := clientEcho.Echo(ctx, &echo.EchoMsg{
	Body: bodyTxt,
})
if err != nil {
	t.Fatal(err.Error())
}
if out.GetBody() != bodyTxt {
	t.Fatalf("expected %q got %q", bodyTxt, out.GetBody())
}
```

### TypeScript

For Go <-> TypeScript interop, see the [integration] test.
For TypeScript <-> TypeScript, see the [e2e] test.

[e2e]: ./e2e/e2e.ts
[integration]: ./integration/integration.ts

### Rust

Add the dependencies to your `Cargo.toml`:

```toml
[dependencies]
starpc = "0.1"
prost = "0.13"
tokio = { version = "1", features = ["rt", "macros"] }

[build-dependencies]
starpc-build = "0.1"
prost-build = "0.13"
```

Create a `build.rs` to generate code from your proto files:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    starpc_build::configure()
        .compile_protos(&["proto/echo.proto"], &["proto"])?;
    Ok(())
}
```

Implement and use your service:

```rust
use starpc::{Client, Mux, Server, SrpcClient};
use std::sync::Arc;

// Include generated code
mod proto {
    include!(concat!(env!("OUT_DIR"), "/echo.rs"));
}

use proto::*;

// Implement the server trait
struct EchoServer;

#[starpc::async_trait]
impl EchoerServer for EchoServer {
    async fn echo(&self, request: EchoMsg) -> starpc::Result<EchoMsg> {
        Ok(request) // Echo back the message
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create server
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServer)))?;
    let server = Server::with_arc(mux);

    // Create an in-memory connection for demonstration
    let (client_stream, server_stream) = tokio::io::duplex(64 * 1024);

    // Spawn server handler
    tokio::spawn(async move {
        let _ = server.handle_stream(server_stream).await;
    });

    // Create client
    let opener = starpc::client::transport::SingleStreamOpener::new(client_stream);
    let client = SrpcClient::new(opener);
    let echoer = EchoerClientImpl::new(client);

    // Make RPC call
    let response = echoer.echo(&EchoMsg { body: "Hello!".into() }).await?;
    println!("Response: {}", response.body);

    Ok(())
}
```

See the [echo example](./echo/main.rs) for a complete working example.

#### WebSocket Example

Connect to a WebSocket server:

```typescript
import { WebSocketConn } from 'starpc'
import { EchoerClient } from './echo/index.js'

const ws = new WebSocket('ws://localhost:8080/api')
const conn = new WebSocketConn(ws)
const client = conn.buildClient()
const echoer = new EchoerClient(client)

const result = await echoer.Echo({ body: 'Hello world!' })
console.log('result:', result.body)
```

#### In-Memory Example

Server and client with an in-memory pipe:

```typescript
import { pipe } from 'it-pipe'
import { createHandler, createMux, Server, StreamConn } from 'starpc'
import { EchoerDefinition, EchoerServer } from './echo/index.js'

// Create server with registered handlers
const mux = createMux()
const echoer = new EchoerServer()
mux.register(createHandler(EchoerDefinition, echoer))
const server = new Server(mux.lookupMethod)

// Create client and server connections, pipe together
const clientConn = new StreamConn()
const serverConn = new StreamConn(server)
pipe(clientConn, serverConn, clientConn)

// Build client and make RPC calls
const client = clientConn.buildClient()
const echoerClient = new EchoerClient(client)

// Unary call
const result = await echoerClient.Echo({ body: 'Hello world!' })
console.log('result:', result.body)

// Client streaming
import { pushable } from 'it-pushable'
const stream = pushable({ objectMode: true })
stream.push({ body: 'Message 1' })
stream.push({ body: 'Message 2' })
stream.end()
const response = await echoerClient.EchoClientStream(stream)
console.log('response:', response.body)

// Server streaming
for await (const msg of echoerClient.EchoServerStream({ body: 'Hello' })) {
  console.log('server msg:', msg.body)
}
```

## Debugging

Enable debug logging in TypeScript using the `DEBUG` environment variable:

```bash
# Enable all starpc logs
DEBUG=starpc:* node app.js

# Enable specific component logs
DEBUG=starpc:stream-conn node app.js
```

## Attribution

`protoc-gen-go-starpc` is a heavily modified version of `protoc-gen-go-drpc`.
Check out [drpc] as well - it's compatible with grpc, twirp, and more.

[drpc]: https://github.com/storj/drpc

Uses [vtprotobuf] to generate Protobuf marshal/unmarshal code for Go.

[vtprotobuf]: https://github.com/planetscale/vtprotobuf

`protoc-gen-es-starpc` is a modified version of `protoc-gen-connect-es`.
Uses [protobuf-es-lite] (fork of [protobuf-es]) for TypeScript.

[protobuf-es]: https://github.com/bufbuild/protobuf-es

## Development Setup

### MacOS

Install required packages:

```bash
brew install bash make coreutils gnu-sed findutils protobuf
brew link --overwrite protobuf
```

Add to your shell rc file (.bashrc, .zshrc):

```bash
export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/gnu-sed/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/findutils/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/make/libexec/gnubin:$PATH"
```

## Support

- [GitHub Issues][issues]
- [Discord][discord]
- [Matrix][matrix]

[issues]: https://github.com/aperturerobotics/starpc/issues/new
[discord]: https://discord.gg/KJutMESRsT
[matrix]: https://matrix.to/#/#aperturerobotics:matrix.org
