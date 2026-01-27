# Getting Started with starpc in Rust

This guide walks you through building your first starpc service in Rust, covering server and client implementation with all streaming patterns.

## Prerequisites

- **Rust** 1.75+
- **Cargo**
- **protoc** - Protocol Buffers compiler ([installation guide](https://grpc.io/docs/protoc-installation/))

## Installation

Add the dependencies to your `Cargo.toml`:

```toml
[dependencies]
starpc = "0.1"
prost = "0.13"
async-trait = "0.1"
tokio = { version = "1", features = ["rt", "macros", "net", "io-util", "time"] }

[build-dependencies]
starpc-build = "0.1"
prost-build = "0.13"
```

## Project Setup

A typical starpc Rust project structure:

```
my-project/
├── proto/
│   └── echo.proto          # Your service definitions
├── src/
│   ├── gen/
│   │   └── mod.rs          # Include generated code
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

    starpc_build::configure()
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

Create a struct that implements the generated server trait:

```rust
use async_trait::async_trait;
use starpc::{Error, Result, Stream};

mod gen;
use gen::{EchoMsg, EchoerServer};

/// Echo server implementation.
struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    /// Unary RPC: receive request, return response
    async fn echo(&self, request: EchoMsg) -> Result<EchoMsg> {
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

    // Accept connections
    loop {
        let (stream, peer_addr) = listener.accept().await?;
        println!("Server: accepted connection from {}", peer_addr);

        let server = Server::with_arc(mux.clone());
        tokio::spawn(async move {
            if let Err(e) = server.handle_stream(stream).await {
                eprintln!("Server error: {}", e);
            }
        });
    }
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
use starpc::{Error, Mux, Result, Server, SrpcClient, Stream};
use tokio::net::{TcpListener, TcpStream};

use gen::{EchoMsg, EchoerClient, EchoerClientImpl, EchoerHandler, EchoerServer};

struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    async fn echo(&self, request: EchoMsg) -> Result<EchoMsg> {
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
    let addr = "127.0.0.1:8080";

    // Spawn server
    let server_handle = tokio::spawn(async move {
        let listener = TcpListener::bind(addr).await.unwrap();
        let mux = Arc::new(Mux::new());
        mux.register(Arc::new(EchoerHandler::new(EchoServerImpl))).unwrap();

        let (stream, _) = listener.accept().await.unwrap();
        let server = Server::with_arc(mux);
        server.handle_stream(stream).await.unwrap();
    });

    // Wait for server to start
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Run client
    let stream = TcpStream::connect(addr).await?;
    let opener = starpc::client::transport::SingleStreamOpener::new(stream);
    let client = SrpcClient::new(opener);
    let echo_client = EchoerClientImpl::new(client);

    let response = echo_client.echo(&EchoMsg {
        body: "Hello!".to_string(),
    }).await?;
    println!("Response: {}", response.body);

    server_handle.abort();
    println!("Example completed!");
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
async fn echo(&self, request: EchoMsg) -> Result<EchoMsg> {
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
    tokio::spawn(async move {
        let _ = server.handle_stream(server_stream).await;
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
}
```

## Transport Options

starpc Rust supports:

| Transport | Use Case |
|-----------|----------|
| `TcpStream` | Network connections |
| `tokio::io::duplex` | In-memory testing |
| `SingleStreamOpener` | Single-stream client transport |

For multiplexed connections (multiple concurrent streams), consider using yamux or similar.

## Next Steps

- [Echo example](./echo/main.rs) - Complete working example
- [starpc crate docs](https://docs.rs/starpc) - API documentation
- [README](./README.md) - Full documentation
