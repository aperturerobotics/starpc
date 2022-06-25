# Stream RPC

**starpc** implements [Proto3 services] (server & client) in both TypeScript and Go.

[Proto3 services]: https://developers.google.com/protocol-buffers/docs/proto3#services

Supports **client-to-server streaming** RPCs in the web browser, currently not
supported by any of the major RPC libraries.

The [rpcproto](./srpc/rpcproto.proto) file describes the protocol.

Can use any Stream multiplexer: defaults to [libp2p-mplex] over a WebSocket.

[libp2p-mplex]: https://github.com/libp2p/js-libp2p-mplex

[rpcstream] supports sub-streams for per-component sub-services.

[rpcstream]: ./rpcstream

# Usage

Starting with the [protobuf-project] repository on the "starpc" branch.

Use "git add" to add your new .proto files, then `yarn gen` to generate the
TypeScript and Go code for them.

# Examples

See the [protobuf-project] template on the "starpc" branch.

The demo/boilerplate project implements the Echo example below.

[protobuf-project]: https://github.com/aperturerobotics/protobuf-project/tree/starpc

This repository uses protowrap, see the [Makefile](./Makefile).

## Protobuf

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

## Go

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

## TypeScript

See the ts-proto README to generate the TypeScript for your protobufs.

For an example of Go <-> TypeScript interop, see the [integration] test. For an
example of TypeScript <-> TypeScript interop, see the [e2e] test.

[e2e]: ./e2e/e2e.ts
[integration]: ./integration/integration.ts

Supports any AsyncIterable communication channel. `DuplexConn`,
`MessagePortConn`, and `WebSocketConn` use [js-libp2p-mplex] to multiplex
streams, but any multiplexer can be used.

[js-libp2p-mplex]: https://github.com/libp2p/js-libp2p-mplex

This example demonstrates both the server and client:

```typescript
import { pipe } from 'it-pipe'
import { createHandler, createMux, Server, Client, Conn } from 'srpc'
import { EchoerDefinition, EchoerServer, runClientTest } from 'srpc/echo'

const mux = createMux()
const echoer = new EchoerServer()
mux.register(createHandler(EchoerDefinition, echoer))
const server = new Server(mux)

const clientConn = new Conn()
const serverConn = new Conn(server)
pipe(clientConn, serverConn, clientConn)
const client = new Client(clientConn.buildOpenStreamFunc())

console.log('Calling Echo: unary call...')
let result = await demoServiceClient.Echo({
  body: 'Hello world!',
})
console.log('success: output', result.body)

const clientRequestStream = new Observable<EchoMsg>(subscriber => {
  subscriber.next({body: 'Hello world from streaming request.'})
  subscriber.complete()
})

console.log('Calling EchoClientStream: client -> server...')
result = await demoServiceClient.EchoClientStream(clientRequestStream)
console.log('success: output', result.body)
```

## WebSocket

One way to integrate Go and TypeScript is over a WebSocket:

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

# Attribution

`protoc-gen-go-starpc` is a heavily modified version of `protoc-gen-go-drpc`.

Be sure to check out [drpc] as well: it's compatible with grpc, twirp, and more.

[drpc]: https://github.com/storj/drpc

Uses [vtprotobuf] to generate Protobuf marshal / unmarshal code.

[vtprotobuf]: https://github.com/planetscale/vtprotobuf

# Support

Starpc is built & supported by Aperture Robotics, LLC.

Community contributions and discussion are welcomed!

Please open a [GitHub issue] with any questions / issues.

[GitHub issue]: https://github.com/aperturerobotics/starpc/issues/new

... or feel free to reach out on [Matrix Chat] or [Discord].

[Discord]: https://discord.gg/KJutMESRsT
[Matrix Chat]: https://matrix.to/#/#aperturerobotics:matrix.org
