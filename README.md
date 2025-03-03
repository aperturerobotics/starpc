# Stream RPC (starpc)

[![GoDoc Widget]][GoDoc] [![Go Report Card Widget]][Go Report Card]

> A high-performance Protobuf 3 RPC framework supporting bidirectional streaming over any multiplexer.

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
- [Development Setup](#development-setup)
- [Support](#support)

## Features

- Full [Proto3 services] implementation for both TypeScript and Go
- Bidirectional streaming support in web browsers
- Built on libp2p streams with `@chainsafe/libp2p-yamux`
- Efficient RPC multiplexing over single connections
- Zero-reflection Go code via [protobuf-go-lite]
- TypeScript interfaces via [protobuf-es-lite]
- Sub-streams support through [rpcstream]

[Proto3 services]: https://developers.google.com/protocol-buffers/docs/proto3#services
[protobuf-go-lite]: https://github.com/aperturerobotics/protobuf-go-lite
[protobuf-es-lite]: https://github.com/aperturerobotics/protobuf-es-lite
[rpcstream]: ./rpcstream

## Installation

```bash
# Clone the template project
git clone -b starpc https://github.com/aperturerobotics/protobuf-project
cd protobuf-project

# Install dependencies
yarn install

# Generate TypeScript and Go code
yarn gen
```

## Quick Start

1. Start with the [protobuf-project] template repository (starpc branch)
2. Add your .proto files to the project
3. Run `yarn gen` to generate TypeScript and Go code
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

[e2e test]: ./e2e/e2e_test.go

### TypeScript

See the ts-proto README to generate the TypeScript for your protobufs.

For an example of Go <-> TypeScript interop, see the [integration] test. For an
example of TypeScript <-> TypeScript interop, see the [e2e] test.

[e2e]: ./e2e/e2e.ts
[integration]: ./integration/integration.ts

Supports any AsyncIterable communication channel.

#### WebSocket Example

This examples demonstrates connecting to a WebSocket server:

```typescript
import { WebSocketConn } from 'srpc'
import { EchoerClient } from 'srpc/echo'

const ws = new WebSocket('ws://localhost:1347/demo')
const channel = new WebSocketConn(ws)
const client = channel.buildClient()
const demoServiceClient = new EchoerClient(client)

const result = await demoServiceClient.Echo({
  body: "Hello world!"
})
console.log('output', result.body)
```

#### In-memory Demo with TypeScript Server and Client

This example demonstrates both the server and client with an in-memory pipe:

```typescript
import { pipe } from 'it-pipe'
import { createHandler, createMux, Server, Client, Conn } from 'srpc'
import { EchoerDefinition, EchoerServer, runClientTest } from 'srpc/echo'
import { pushable } from 'it-pushable'

// Create the server and register the handlers.
const mux = createMux()
const echoer = new EchoerServer()
mux.register(createHandler(EchoerDefinition, echoer))
const server = new Server(mux.lookupMethod)

// Create the client connection to the server with an in-memory pipe.
const clientConn = new Conn()
const serverConn = new Conn(server)
pipe(clientConn, serverConn, clientConn)
const client = new Client(clientConn.buildOpenStreamFunc())

// Examples of different types of RPC calls:

// One-shot request/response (unary):
console.log('Calling Echo: unary call...')
let result = await demoServiceClient.Echo({
  body: 'Hello world!',
})
console.log('success: output', result.body)

// Streaming from client->server with a single server response:
const clientRequestStream = pushable<EchoMsg>({objectMode: true})
clientRequestStream.push({body: 'Hello world from streaming request.'})
clientRequestStream.end()
console.log('Calling EchoClientStream: client -> server...')
result = await demoServiceClient.EchoClientStream(clientRequestStream)
console.log('success: output', result.body)

// Streaming from server -> client with a single client message.
console.log('Calling EchoServerStream: server -> client...')
const serverStream = demoServiceClient.EchoServerStream({
  body: 'Hello world from server to client streaming request.',
})
for await (const msg of serverStream) {
  console.log('server: output', msg.body)
}
```

## Attribution

`protoc-gen-go-starpc` is a heavily modified version of `protoc-gen-go-drpc`.

Be sure to check out [drpc] as well: it's compatible with grpc, twirp, and more.

[drpc]: https://github.com/storj/drpc

Uses [vtprotobuf] to generate Go Protobuf marshal / unmarshal code.

[vtprotobuf]: https://github.com/planetscale/vtprotobuf

Uses [protobuf-es-lite] (fork of [protobuf-es]) to generate TypeScript Protobuf marshal / unmarshal code.

[protobuf-es]: https://github.com/bufbuild/protobuf-es
[protobuf-es-lite]: https://github.com/aperturerobotics/protobuf-es-lite

`protoc-gen-es-starpc` is a heavily modified version of `protoc-gen-connect-es`.

## Development Setup

### MacOS Requirements

1. Install required packages:
```bash
brew install bash make coreutils gnu-sed findutils protobuf
brew link --overwrite protobuf
```

2. Add to your .bashrc or .zshrc:
```bash
export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/gnu-sed/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/findutils/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/make/libexec/gnubin:$PATH"
```

## Attribution

- `protoc-gen-go-starpc`: Modified version of `protoc-gen-go-drpc`
- `protoc-gen-es-starpc`: Modified version of `protoc-gen-connect-es`
- Uses [vtprotobuf] for Go Protobuf marshaling
- Uses [protobuf-es-lite] for TypeScript Protobuf interfaces

[vtprotobuf]: https://github.com/planetscale/vtprotobuf

## Support

Need help? We're here:

- [File a GitHub Issue][GitHub issue]
- [Join our Discord][Join Discord]
- [Matrix Chat][Matrix Chat]

[GitHub issue]: https://github.com/aperturerobotics/starpc/issues/new
[Join Discord]: https://discord.gg/KJutMESRsT
[Matrix Chat]: https://matrix.to/#/#aperturerobotics:matrix.org
