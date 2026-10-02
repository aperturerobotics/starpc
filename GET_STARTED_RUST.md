# Getting Started with starpc in Rust

This guide walks you through building your first starpc service in Rust, covering server and client implementation with all streaming patterns.

## Prerequisites

- **Rust** 1.75+
- **Cargo**
- No separate `protoc` or Go installation is required for Rust code generation.

The `starpc` crate's `build` feature wires a bundled `protoc` into `prost-build`.

## Installation

These examples target the repository's current Rust API. Keep the runtime and build dependency on the same revision. Add them to your `Cargo.toml`:

```toml
[dependencies]
starpc = { git = "https://github.com/aperturerobotics/starpc" }
prost = "0.14"
async-trait = "0.1"
futures = "0.3"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "io-util", "time"] }

[build-dependencies]
starpc = { git = "https://github.com/aperturerobotics/starpc", features = ["build"] }
prost-build = "0.14"
```

## Project Setup

A typical starpc Rust project structure:

```
my-project/
├── proto/
│   └── echo.proto          # Your service definitions
├── src/
│   ├── gen/
│   │   └── mod.rs          # Include generated Rust code
│   ├── main.rs             # Application entry point
│   └── lib.rs              # Optional library
├── build.rs                # Code generation script
└── Cargo.toml
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

Create a `build.rs` file in your project root:

```rust
use std::io::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let proto_path = manifest_dir.join("proto/echo.proto");

    println!("cargo:rerun-if-changed={}", proto_path.display());

    starpc::build::configure()
        .compile_protos(&[proto_path], &[manifest_dir.join("proto")])?;

    Ok(())
}
```

Include the generated code in your project:

```rust
// src/gen/mod.rs
include!(concat!(env!("OUT_DIR"), "/echo.rs"));
```

Generated types include:
- `EchoMsg` - Message type
- `EchoerServer` - Server trait to implement
- `EchoerClient` - Client trait
- `EchoerClientImpl` - Client implementation
- `EchoerHandler` - Handler for registration

## Implementing a Server

Unary methods receive the incoming `&starpc::Context`; pass `context.cancel_token()` to cancellation-aware work. Streaming methods obtain the same context through `stream.context()`. Dropping a call cancels its context and releases its transport.

Create a struct that implements the generated server trait:

```rust
use async_trait::async_trait;
use starpc::{Error, Result, Stream, StreamExt};

mod gen;
use gen::{EchoMsg, EchoerServer};

/// Echo server implementation.
struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    /// Unary RPC: receive request, return response
    async fn echo(&self, _context: &starpc::Context, request: EchoMsg) -> Result<EchoMsg> {
        println!("Server: received echo request: {:?}", request.body);
        Ok(EchoMsg { body: request.body })
    }

    /// Server streaming: receive request, send multiple responses
    async fn echo_server_stream(
        &self,
        request: EchoMsg,
        stream: Box<dyn Stream>,
    ) -> Result<()> {
        println!("Server: received server stream request: {:?}", request.body);

        for i in 0..5 {
            let response = EchoMsg {
                body: format!("{} - {}", request.body, i),
            };
            stream.msg_send(&response).await?;
        }

        Ok(())
    }

    /// Client streaming: receive stream of requests, return single response
    async fn echo_client_stream(&self, stream: &dyn Stream) -> Result<EchoMsg> {
        println!("Server: starting client stream");

        let mut messages = Vec::new();

        loop {
            match stream.msg_recv::<EchoMsg>().await {
                Ok(msg) => {
                    println!("Server: received message: {:?}", msg.body);
                    messages.push(msg.body);
                }
                Err(Error::StreamClosed) => break,
                Err(e) => return Err(e),
            }
        }

        Ok(EchoMsg {
            body: messages.join(", "),
        })
    }

    /// Bidirectional streaming: echo each message back
    async fn echo_bidi_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
        println!("Server: starting bidi stream");

        loop {
            match stream.msg_recv::<EchoMsg>().await {
                Ok(msg) => {
                    println!("Server: echoing message: {:?}", msg.body);
                    stream.msg_send(&msg).await?;
                }
                Err(Error::StreamClosed) => break,
                Err(e) => return Err(e),
            }
        }

        Ok(())
    }
}
```

### Setting Up the Server

```rust
use std::sync::Arc;
use starpc::{Mux, Server};
use tokio::net::TcpListener;

use gen::EchoerHandler;

async fn run_server(addr: &str) -> Result<()> {
    let listener = TcpListener::bind(addr).await?;
    println!("Server listening on {}", addr);

    // Create the mux and register the handler
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl)))?;

    // The server owns concurrent calls and drains them when the listener ends.
    let incoming = futures::stream::unfold(listener, |listener| async move {
        Some((listener.accept().await.map(|(stream, _)| stream), listener))
    });
    Server::with_arc(mux)
        .with_error_handler(|error| eprintln!("Server error: {error}"))
        .serve(Box::pin(incoming))
        .await
}
```

## Implementing a Client

```rust
use starpc::SrpcClient;
use tokio::net::TcpStream;

use gen::{EchoMsg, EchoerClient, EchoerClientImpl};

async fn run_client(addr: &str) -> Result<()> {
    println!("Client: connecting to {}", addr);

    // Connect to the server
    let stream = TcpStream::connect(addr).await?;

    // Create a client
    let opener = starpc::client::transport::SingleStreamOpener::new(stream);
    let client = SrpcClient::new(opener);
    let echo_client = EchoerClientImpl::new(client);

    // Make a unary call
    let request = EchoMsg {
        body: "Hello, World!".to_string(),
    };
    let response = echo_client.echo(&request).await?;
    println!("Client: received response: {:?}", response.body);

    Ok(())
}
```

## Running the Example

Here's a complete example with TCP transport:

```rust
mod gen;

use std::sync::Arc;

use async_trait::async_trait;
use starpc::{Error, Mux, Result, Server, SrpcClient, Stream, StreamExt};
use tokio::net::{TcpListener, TcpStream};

use gen::{EchoMsg, EchoerClient, EchoerClientImpl, EchoerHandler, EchoerServer};

struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    async fn echo(&self, _context: &starpc::Context, request: EchoMsg) -> Result<EchoMsg> {
        Ok(EchoMsg { body: request.body })
    }

    async fn echo_server_stream(&self, request: EchoMsg, stream: Box<dyn Stream>) -> Result<()> {
        for i in 0..5 {
            stream.msg_send(&EchoMsg {
                body: format!("{} - {}", request.body, i),
            }).await?;
        }
        Ok(())
    }

    async fn echo_client_stream(&self, stream: &dyn Stream) -> Result<EchoMsg> {
        let mut messages = Vec::new();
        loop {
            match stream.msg_recv::<EchoMsg>().await {
                Ok(msg) => messages.push(msg.body),
                Err(Error::StreamClosed) => break,
                Err(e) => return Err(e),
            }
        }
        Ok(EchoMsg { body: messages.join(", ") })
    }

    async fn echo_bidi_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
        loop {
            match stream.msg_recv::<EchoMsg>().await {
                Ok(msg) => stream.msg_send(&msg).await?,
                Err(Error::StreamClosed) => break,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // The bound listener establishes readiness before the client connects.
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl)))?;

    // Both sides stay owned by this invocation until the call completes.
    let server = async {
        let (stream, _) = listener.accept().await?;
        Server::with_arc(mux).handle_stream(stream).await
    };
    let client = async {
        let stream = TcpStream::connect(address).await?;
        let opener = starpc::client::transport::SingleStreamOpener::new(stream);
        let echo = EchoerClientImpl::new(SrpcClient::new(opener));
        let response = echo.echo(&EchoMsg { body: "Hello!".into() }).await?;
        println!("Response: {}", response.body);
        Ok::<_, starpc::Error>(())
    };
    tokio::try_join!(server, client)?;
    Ok(())
}
```

## Common Patterns

### Unary RPC

```rust
// Client
let response = echo_client.echo(&EchoMsg {
    body: "Hello".to_string(),
}).await?;
println!("Response: {}", response.body);

// Server
async fn echo(&self, _context: &starpc::Context, request: EchoMsg) -> Result<EchoMsg> {
    Ok(EchoMsg {
        body: format!("Echo: {}", request.body),
    })
}
```

### Server Streaming

```rust
// Client - receive stream of responses
// Note: Full streaming client API depends on transport

// Server - send multiple responses
async fn echo_server_stream(
    &self,
    request: EchoMsg,
    stream: Box<dyn Stream>,
) -> Result<()> {
    for i in 0..5 {
        stream.msg_send(&EchoMsg {
            body: format!("Response {}", i),
        }).await?;
    }
    Ok(())
}
```

### Client Streaming

```rust
// Server - receive stream, return single response
async fn echo_client_stream(&self, stream: &dyn Stream) -> Result<EchoMsg> {
    let mut messages = Vec::new();

    loop {
        match stream.msg_recv::<EchoMsg>().await {
            Ok(msg) => messages.push(msg.body),
            Err(Error::StreamClosed) => break,
            Err(e) => return Err(e),
        }
    }

    Ok(EchoMsg {
        body: messages.join(", "),
    })
}
```

### Bidirectional Streaming

```rust
// Server - echo each message
async fn echo_bidi_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
    loop {
        match stream.msg_recv::<EchoMsg>().await {
            Ok(msg) => stream.msg_send(&msg).await?,
            Err(Error::StreamClosed) => break,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
```

## Stream Methods

The `Stream` trait provides these methods:

| Method | Description |
|--------|-------------|
| `msg_send(&msg)` | Send a protobuf message |
| `msg_recv::<T>()` | Receive a typed protobuf message |

Error handling:
- `Error::StreamClosed` - Stream has been closed (normal termination)
- Other errors indicate failures

## Testing

Use in-memory duplex streams for unit tests:

```rust
#[tokio::test]
async fn test_echo() {
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl))).unwrap();

    // Create in-memory duplex
    let (client_stream, server_stream) = tokio::io::duplex(64 * 1024);

    // Spawn server
    let server = Server::with_arc(mux);
    let server = tokio::spawn(async move {
        server.handle_stream(server_stream).await
    });

    // Create client
    let opener = starpc::client::transport::SingleStreamOpener::new(client_stream);
    let client = SrpcClient::new(opener);
    let echo_client = EchoerClientImpl::new(client);

    // Test
    let response = echo_client.echo(&EchoMsg {
        body: "test".to_string(),
    }).await.unwrap();

    assert_eq!(response.body, "test");
    server.await.unwrap().unwrap();
}
```

## Transport Options

Custom `OpenStream` implementations return a writer and `PacketReceiver`, an owned asynchronous packet stream. `create_packet_channel` supplies framing over split byte transports without starting a packet pump. A streaming client owns its dispatcher and joins it on explicit close; a unary call drives reception in its own future.

starpc Rust supports:

| Transport | Use Case |
|-----------|----------|
| `TcpStream` | Network connections |
| `tokio::io::duplex` | In-memory testing |
| `SingleStreamOpener` | Single-stream client transport |
| `YamuxStreamOpener` | Multiplexed client transport with the `yamux` feature |
| `websocket_byte_stream` | Binary WebSocket byte transport with the `websocket` feature |

For multiplexed connections, enable the `yamux` feature and use
`YamuxStreamOpener`. For browser-compatible WebSocket endpoints, enable
`websocket-yamux`; servers can pass a `tokio_tungstenite::WebSocketStream` to
`Server::handle_websocket_yamux`, and clients can use
`YamuxStreamOpener::client_websocket`.

Yamux opener clones share one connection driver. Keep an opener clone when you
need to call `close().await` and wait for the shared connection to stop. Dropping
the last opener cancels its driver. The server owns all accepted calls within
`handle_yamux`; ending or dropping that future cancels those calls. The WebSocket
byte adapter owns its socket directly and creates no background tasks.

Protocols with their own nested-stream handshake can call
`rpcstream::handle_rpc_data_stream` after accepting a route. On the client,
`rpcstream::rpc_data_transport` exposes an accepted stream as the standard
packet writer and receiver. Both reuse the nested RPC data path without sending
another init or acknowledgment.

`ClientInvoker::new(client)` forwards incoming methods through an existing
client. It preserves empty messages, half-close behavior and the remote terminal
result. Both forwarding directions belong to the incoming invocation, so caller
cancellation also ends a remote call that is waiting after input half-close.

### TypeScript WebSocket Interop

TypeScript `WebSocketConn` speaks Starpc packets inside yamux streams inside
binary WebSocket messages. A Rust server must accept the WebSocket upgrade and
then call `Server::handle_websocket_yamux`; do not pass a browser WebSocket
connection to `Server::handle_stream`, which expects one raw Starpc packet
stream.

Enable the Rust transport features and add `tokio-tungstenite` for the HTTP
upgrade:

```toml
[dependencies]
starpc = { git = "https://github.com/aperturerobotics/starpc", features = ["websocket-yamux"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "io-util", "time"] }
tokio-tungstenite = "0.30"
```

Accept WebSocket connections on the Rust side and route each yamux substream to
the registered Starpc handlers:

```rust
use std::sync::Arc;

use starpc::{Mux, Server};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;

use gen::EchoerHandler;

async fn run_websocket_server(
    addr: &str,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = TcpListener::bind(addr).await?;

    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl)))?;

    // Keep accepted WebSocket operations within this server future's lifetime.
    let server = Server::with_arc(mux);
    let incoming = futures::stream::unfold(listener, |listener| async move {
        Some((listener.accept().await.map(|(stream, _)| stream), listener))
    });
    futures::StreamExt::for_each_concurrent(incoming, None, |tcp| {
        let server = &server;
        async move {
            let result = async {
                let socket = accept_async(tcp?).await?;
                server.handle_websocket_yamux(socket).await?;
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
            }.await;
            if let Err(error) = result {
                eprintln!("Starpc WebSocket error: {error}");
            }
        }
    }).await;
    Ok(())
}
```

Then connect with the TypeScript WebSocket transport in outbound/client mode:

```typescript
import { WebSocketConn } from 'starpc'
import { EchoerClient } from './echo_srpc.pb.js'

const ws = new WebSocket('ws://127.0.0.1:8080')
const conn = new WebSocketConn(ws, 'outbound')
const client = conn.buildClient()
const echoer = new EchoerClient(client)

const result = await echoer.Echo({ body: 'hello from TypeScript' })
console.log(result.body)
```

The resulting transport stack is:

```text
TypeScript WebSocketConn
  -> WebSocket binary messages
  -> yamux connection
  -> one Starpc packet stream per RPC
  -> Rust Server::handle_stream
```

## Next Steps

- [Echo example](./echo/main.rs) - Complete working example
- [starpc crate docs](https://docs.rs/starpc) - API documentation
- [README](./README.md) - Full documentation
