//! Echo service example demonstrating starpc usage.
//!
//! This example shows how to implement both client and server for a simple
//! echo service that supports unary, server streaming, client streaming,
//! and bidirectional streaming RPCs.

// This example uses only part of the generated service surface.
#[allow(dead_code)]
mod gen;

use std::sync::Arc;

use async_trait::async_trait;
use starpc::{rpcstream, Error, Mux, Result, Server, Stream, StreamExt};
use tokio::net::{TcpListener, TcpStream};

use gen::{EchoMsg, EchoerClient, EchoerClientImpl, EchoerHandler, EchoerServer};

/// Echo server implementation.
struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    async fn echo(&self, _context: &starpc::Context, request: EchoMsg) -> Result<EchoMsg> {
        println!("Server: received echo request: {:?}", request.body);
        Ok(EchoMsg { body: request.body })
    }

    async fn echo_server_stream(&self, request: EchoMsg, stream: Box<dyn Stream>) -> Result<()> {
        println!("Server: received server stream request: {:?}", request.body);

        // Send multiple responses.
        for i in 0..5 {
            let response = EchoMsg {
                body: format!("{} - {}", request.body, i),
            };
            stream.msg_send(&response).await?;
        }

        Ok(())
    }

    async fn echo_client_stream(&self, stream: &dyn Stream) -> Result<EchoMsg> {
        println!("Server: starting client stream");

        let mut messages = Vec::new();

        // Receive all messages from the client.
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

        // Return combined response (the handler will send it automatically).
        Ok(EchoMsg {
            body: messages.join(", "),
        })
    }

    async fn echo_bidi_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
        println!("Server: starting bidi stream");

        // Echo each message back.
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

    async fn rpc_stream(&self, _stream: Box<dyn Stream>) -> Result<()> {
        // RPC stream is not implemented in this example.
        Err(Error::Unimplemented)
    }

    async fn do_nothing(&self, _context: &starpc::Context, _request: ()) -> Result<()> {
        Ok(())
    }
}

/// Binds the server before connecting and retains both operations until their call completes.
#[tokio::main]
async fn main() -> Result<()> {
    // Listener construction is the readiness capability used by the client.
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?.to_string();

    // Both futures remain owned here, so failure or cancellation releases the other side.
    tokio::try_join!(run_server(listener), run_client(&address))?;
    println!("Example completed successfully!");
    Ok(())
}

/// Serves the one connection used by this example through the ordinary server owner.
async fn run_server(listener: TcpListener) -> Result<()> {
    // Publish the handler before accepting the paired client's connection.
    println!("Server listening on {}", listener.local_addr()?);
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl)))?;

    // Return only after the actual call and its packet reader have finished.
    let (stream, peer_address) = listener.accept().await?;
    println!("Server: accepted connection from {}", peer_address);
    Server::with_arc(mux).handle_stream(stream).await
}

/// Runs a unary call over one connection and verifies its exact response.
async fn run_client(addr: &str) -> Result<()> {
    println!("\nClient: connecting to {}", addr);

    // Connect to the server.
    let stream = TcpStream::connect(addr).await?;

    // Create a client.
    let opener = starpc::client::transport::SingleStreamOpener::new(stream);
    let client = starpc::SrpcClient::new(opener);
    let echo_client = EchoerClientImpl::new(client);

    // Test unary RPC.
    println!("\n--- Unary RPC ---");
    let request = EchoMsg {
        body: "Hello, World!".to_string(),
    };
    let response = echo_client.echo(&request).await?;
    println!("Client: received response: {:?}", response.body);
    assert_eq!(response.body, request.body);

    // Note: Additional streaming tests would require multiple connections
    // since SingleStreamOpener only supports one stream at a time.
    // For a full implementation, you would use yamux or similar multiplexing.

    println!("\nClient: all tests passed!");
    Ok(())
}
