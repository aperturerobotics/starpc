# Stream RPC

[![GoDoc Widget]][GoDoc] [![Go Report Card Widget]][Go Report Card]

> Protobuf 3 RPC services over any stream multiplexer.

[GoDoc]: https://godoc.org/github.com/aperturerobotics/starpc
[GoDoc Widget]: https://godoc.org/github.com/aperturerobotics/starpc?status.svg
[Go Report Card Widget]: https://goreportcard.com/badge/github.com/aperturerobotics/starpc
[Go Report Card]: https://goreportcard.com/report/github.com/aperturerobotics/starpc

## Introduction

**starpc** implements [Proto3 services] (server & client) in both TypeScript and Go.

[Proto3 services]: https://developers.google.com/protocol-buffers/docs/proto3#services

Supports **client-to-server and bidirectional streaming** in the web browser.

[rpcproto.proto](./srpc/rpcproto.proto) contains the protocol definition.

[rpcstream] supports sub-streams for per-component sub-services.

[rpcstream]: ./rpcstream

The library leverages libp2p streams with `@chainsafe/libp2p-yamux` to
coordinate balancing many ongoing RPCs over a single connection.

## Usage

Start with the [protobuf-project] template repository on the "starpc" branch.

[protobuf-project]: https://github.com/aperturerobotics/protobuf-project/tree/starpc

Use "git add" to add your new .proto files, then `yarn gen` to generate the
TypeScript and Go code.

## Examples

The demo/boilerplate project implements the Echo example below.

This repository uses protowrap, see the [Makefile](./Makefile).

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
import { EchoerClientImpl } from 'srpc/echo'

const ws = new WebSocket('ws://localhost:5000/demo')
const channel = new WebSocketConn(ws)
const client = channel.buildClient()
const demoServiceClient = new EchoerClientImpl(client)

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
const server = new Server(mux.lookupMethodFunc)

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

Uses [vtprotobuf] to generate Protobuf marshal / unmarshal code.

[vtprotobuf]: https://github.com/planetscale/vtprotobuf

## Developing on MacOS

On MacOS, some homebrew packages are required for `yarn gen`:

```
brew install bash make coreutils gnu-sed findutils protobuf
brew link --overwrite protobuf
```

Add to your .bashrc or .zshrc:

```
export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/gnu-sed/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/findutils/libexec/gnubin:$PATH"
export PATH="/opt/homebrew/opt/make/libexec/gnubin:$PATH"
```

## Support

Please file a [GitHub issue] and/or [Join Discord] with any questions.

[GitHub issue]: https://github.com/aperturerobotics/starpc/issues/new

... or feel free to reach out on [Matrix Chat].

[Join Discord]: https://discord.gg/KJutMESRsT
[Matrix Chat]: https://matrix.to/#/#aperturerobotics:matrix.org
