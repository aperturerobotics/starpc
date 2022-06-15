# Stream RPC

Protobuf service implementation supporting **client-to-server streaming** RPCs.

The [rpcproto](./srpc/rpcproto.proto) file contains the entire protocol.

Leverages the Stream multiplexing of the underlying transport; for example:
HTTP/2 or [libp2p-mplex] over a WebSocket.

[libp2p-mplex]: https://github.com/libp2p/js-libp2p-mplex

# Example

See the [protobuf-project] template on the "starpc" branch.

[protobuf-project]: https://github.com/aperturerobotics/protobuf-project

# Usage

**starpc** is a fully-featured client and server for Proto3 services in both
TypeScript and Go. Supports any AsyncIterable communication channel with an
included implementation for WebSockets.

## Go

A basic example can be found in the [e2e test]:

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

Also check out the [integration](./integration/integration.ts) test.

This repository uses protowrap, see the [Makefile](./Makefile).

```typescript
import { WebSocketConn } from '../srpc'
import { EchoerClientImpl } from '../echo/echo'

const ws = new WebSocket('ws://localhost:5000/demo')
const channel = new WebSocketConn(ws)
const client = channel.buildClient()
const demoServiceClient = new EchoerClientImpl(client)

const result = await demoServiceClient.Echo({
  body: "Hello world!"
})
console.log('output', result.body)

const clientRequestStream = new Observable<EchoMsg>(subscriber => {
  subscriber.next({body: 'Hello world from streaming request.'})
  subscriber.complete()
})

console.log('Calling EchoClientStream: client -> server...')
result = await demoServiceClient.EchoClientStream(clientRequestStream)
console.log('success: output', result.body)
```

`WebSocketConn` uses [js-libp2p-mplex] to multiplex streams over the WebSocket.

[js-libp2p-mplex]: https://github.com/libp2p/js-libp2p-mplex

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

[GitHub issue]: https://github.com/aperturerobotics/bifrost/issues/new

... or feel free to reach out on [Matrix Chat] or [Discord].

[Discord]: https://discord.gg/KJutMESRsT
[Matrix Chat]: https://matrix.to/#/#aperturerobotics:matrix.org
