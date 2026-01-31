# Getting Started with starpc in TypeScript

This guide walks you through building your first starpc service in TypeScript, covering server and client implementation with all streaming patterns.

## Prerequisites

- **Node.js** v18+ (or Bun/Deno)
- **npm**, **yarn**, **pnpm**, or **bun**
- **Go** 1.21+ (for code generation)

No separate protoc installation is required - the code generator uses an embedded WebAssembly version of protoc via [go-protoc-wasi].

## Installation

The easiest way to get started is with the template project:

```bash
# Clone the template project
git clone -b starpc https://github.com/aperturerobotics/protobuf-project
cd protobuf-project

# Install dependencies (pick one)
npm install
yarn install
pnpm install
bun install
```

Or add starpc to an existing project:

```bash
npm install starpc @aptre/protobuf-es-lite
```

## Project Setup

A typical starpc TypeScript project structure:

```
my-project/
├── echo/
│   ├── echo.proto        # Your service definitions
│   ├── echo.pb.ts        # Generated message types
│   ├── echo_srpc.pb.ts   # Generated service interfaces
│   ├── server.ts         # Server implementation
│   └── client.ts         # Client implementation
├── package.json
└── tsconfig.json
```

## Defining Proto Services

Create your service definition in a `.proto` file:

```protobuf
syntax = "proto3";
package echo;

// Echoer service returns the given message.
service Echoer {
  // Unary RPC - single request, single response
  rpc Echo(EchoMsg) returns (EchoMsg);

  // Server streaming - single request, stream of responses
  rpc EchoServerStream(EchoMsg) returns (stream EchoMsg);

  // Client streaming - stream of requests, single response
  rpc EchoClientStream(stream EchoMsg) returns (EchoMsg);

  // Bidirectional streaming - stream both ways
  rpc EchoBidiStream(stream EchoMsg) returns (stream EchoMsg);
}

message EchoMsg {
  string body = 1;
}
```

## Generating Code

The template project uses `protoc-gen-es-starpc` to generate TypeScript code:

```bash
# Generate TypeScript code
bun run gen
```

This generates two files per proto:
- `*.pb.ts` - Message types (e.g., `EchoMsg`)
- `*_srpc.pb.ts` - Service interfaces and client (`EchoerDefinition`, `Echoer`, `EchoerClient`)

## Implementing a Server

Create a class that implements the generated service interface:

```typescript
import { Message } from '@aptre/protobuf-es-lite'
import { EchoMsg } from './echo.pb.js'
import { Echoer } from './echo_srpc.pb.js'
import { MessageStream, messagePushable, writeToPushable } from 'starpc'
import first from 'it-first'

export class EchoerServer implements Echoer {
  // Unary RPC: receive request, return response
  async Echo(request: EchoMsg): Promise<Message<EchoMsg>> {
    return request
  }

  // Server streaming: receive request, yield multiple responses
  async *EchoServerStream(request: EchoMsg): MessageStream<EchoMsg> {
    for (let i = 0; i < 5; i++) {
      yield request
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // Client streaming: receive stream of requests, return single response
  async EchoClientStream(
    request: MessageStream<EchoMsg>
  ): Promise<Message<EchoMsg>> {
    const message = await first(request)
    if (!message) {
      throw new Error('received no messages')
    }
    return message
  }

  // Bidirectional streaming: receive stream, return stream
  EchoBidiStream(request: MessageStream<EchoMsg>): MessageStream<EchoMsg> {
    const result = messagePushable<EchoMsg>()
    result.push({ body: 'hello from server' })
    writeToPushable(request, result)
    return result
  }
}
```

### Setting Up the Server

```typescript
import { createMux, createHandler, Server, StreamConn } from 'starpc'
import { EchoerDefinition } from './echo_srpc.pb.js'
import { EchoerServer } from './server.js'

// Create the mux and register handlers
const mux = createMux()
const echoer = new EchoerServer()
mux.register(createHandler(EchoerDefinition, echoer))

// Create the server
const server = new Server(mux.lookupMethod)
```

## Implementing a Client

### WebSocket Connection (Browser/Node.js)

```typescript
import { WebSocketConn } from 'starpc'
import { EchoerClient } from './echo_srpc.pb.js'

// Connect to a WebSocket server
const ws = new WebSocket('ws://localhost:8080/api')
const conn = new WebSocketConn(ws)
const client = conn.buildClient()
const echoer = new EchoerClient(client)

// Make a unary call
const result = await echoer.Echo({ body: 'Hello world!' })
console.log('result:', result.body)
```

### In-Memory Connection (Testing)

```typescript
import { pipe } from 'it-pipe'
import { createMux, createHandler, Server, StreamConn } from 'starpc'
import { EchoerDefinition, EchoerClient } from './echo_srpc.pb.js'
import { EchoerServer } from './server.js'

// Create server
const mux = createMux()
mux.register(createHandler(EchoerDefinition, new EchoerServer()))
const server = new Server(mux.lookupMethod)

// Create client and server connections, pipe together
const clientConn = new StreamConn()
const serverConn = new StreamConn(server)
pipe(clientConn, serverConn, clientConn)

// Build client
const client = clientConn.buildClient()
const echoer = new EchoerClient(client)
```

## Running the Example

Here's a complete example with in-memory transport:

```typescript
import { pipe } from 'it-pipe'
import { createMux, createHandler, Server, StreamConn } from 'starpc'
import { EchoerDefinition, EchoerClient } from './echo_srpc.pb.js'
import { EchoerServer } from './server.js'

async function main() {
  // Setup server
  const mux = createMux()
  mux.register(createHandler(EchoerDefinition, new EchoerServer()))
  const server = new Server(mux.lookupMethod)

  // Setup in-memory connection
  const clientConn = new StreamConn()
  const serverConn = new StreamConn(server)
  pipe(clientConn, serverConn, clientConn)

  // Create client
  const echoer = new EchoerClient(clientConn.buildClient())

  // Test unary call
  const result = await echoer.Echo({ body: 'Hello!' })
  console.log('Echo result:', result.body)
}

main().catch(console.error)
```

## Common Patterns

### Unary RPC

```typescript
// Client
const response = await echoer.Echo({ body: 'Hello' })

// Server
async Echo(request: EchoMsg): Promise<Message<EchoMsg>> {
  return { body: `Echo: ${request.body}` }
}
```

### Server Streaming

```typescript
// Client - iterate over responses
for await (const msg of echoer.EchoServerStream({ body: 'Hello' })) {
  console.log('received:', msg.body)
}

// Server - yield responses
async *EchoServerStream(request: EchoMsg): MessageStream<EchoMsg> {
  for (let i = 0; i < 5; i++) {
    yield { body: `Response ${i}` }
  }
}
```

### Client Streaming

```typescript
import { pushable } from 'it-pushable'

// Client - send multiple messages
const stream = pushable({ objectMode: true })
stream.push({ body: 'Message 1' })
stream.push({ body: 'Message 2' })
stream.end()
const response = await echoer.EchoClientStream(stream)

// Server - receive stream, return response
async EchoClientStream(request: MessageStream<EchoMsg>): Promise<Message<EchoMsg>> {
  const messages: string[] = []
  for await (const msg of request) {
    messages.push(msg.body)
  }
  return { body: messages.join(', ') }
}
```

### Bidirectional Streaming

```typescript
import { pushable } from 'it-pushable'

// Client - send and receive simultaneously
const requestStream = pushable({ objectMode: true })
const responseStream = echoer.EchoBidiStream(requestStream)

requestStream.push({ body: 'Hello' })
requestStream.push({ body: 'World' })
requestStream.end()

for await (const msg of responseStream) {
  console.log('received:', msg.body)
}

// Server - echo received messages
EchoBidiStream(request: MessageStream<EchoMsg>): MessageStream<EchoMsg> {
  const result = messagePushable<EchoMsg>()
  writeToPushable(request, result)
  return result
}
```

## Transport Options

starpc supports multiple transports:

| Transport | Use Case |
|-----------|----------|
| `WebSocketConn` | Browser to server, Node.js |
| `StreamConn` + `it-pipe` | In-memory, testing |
| `MessagePort` | Web Workers, iframes |
| libp2p streams | P2P applications |

## Testing

Use in-memory connections for unit tests:

```typescript
import { pipe } from 'it-pipe'
import { createMux, createHandler, Server, StreamConn } from 'starpc'

describe('EchoerServer', () => {
  it('echoes messages', async () => {
    const mux = createMux()
    mux.register(createHandler(EchoerDefinition, new EchoerServer()))
    const server = new Server(mux.lookupMethod)

    const clientConn = new StreamConn()
    const serverConn = new StreamConn(server)
    pipe(clientConn, serverConn, clientConn)

    const echoer = new EchoerClient(clientConn.buildClient())
    const result = await echoer.Echo({ body: 'test' })

    expect(result.body).toBe('test')
  })
})
```

## Debugging

Enable debug logging with the `DEBUG` environment variable:

```bash
# All starpc logs
DEBUG=starpc:* node app.js

# Specific components
DEBUG=starpc:stream-conn node app.js
```

## Next Steps

- [Echo example](./echo) - Complete working example
- [Integration tests](./integration) - Go/TypeScript interop examples
- [rpcstream](./rpcstream) - Nested RPC streams
- [README](./README.md) - Full documentation

[go-protoc-wasi]: https://github.com/aperturerobotics/go-protoc-wasi
