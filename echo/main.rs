//! Echo service example demonstrating starpc usage.
//!
//! This example shows how to implement both client and server for a simple
//! echo service that supports unary, server streaming, client streaming,
//! and bidirectional streaming RPCs.

mod gen;

use std::sync::Arc;

use async_trait::async_trait;
use starpc::{Error, Mux, Result, Server, Stream, StreamExt};
use tokio::net::{TcpListener, TcpStream};

use gen::{EchoMsg, EchoerClient, EchoerClientImpl, EchoerHandler, EchoerServer};

/// Echo server implementation.
struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    async fn echo(&self, request: EchoMsg) -> Result<EchoMsg> {
        println!("Server: received echo request: {:?}", request.body);
        Ok(EchoMsg {
            body: request.body,
        })
    }

    async fn echo_server_stream(
        &self,
        request: EchoMsg,
        stream: Box<dyn Stream>,
    ) -> Result<()> {
        println!(
            "Server: received server stream request: {:?}",
            request.body
        );

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
        let response = EchoMsg {
            body: messages.join(", "),
        };

        Ok(response)
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
}

#[tokio::main]
async fn main() -> Result<()> {
    let addr = "127.0.0.1:8080";

    // Spawn the server.
    let server_handle = tokio::spawn(run_server(addr.to_string()));

    // Wait for the server to start.
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Run the client.
    run_client(addr).await?;

    // Stop the server.
    server_handle.abort();

    println!("Example completed successfully!");
    Ok(())
}

async fn run_server(addr: String) -> Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    println!("Server listening on {}", addr);

    // Create the mux and register our handler.
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl)))?;

    // Accept connections.
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
