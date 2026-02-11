#[allow(dead_code)]
mod gen;

use std::sync::Arc;

use async_trait::async_trait;
use starpc::client::{OpenStream, PacketReceiver, SrpcClient};
use starpc::rpc::PacketWriter;
use starpc::transport::create_packet_channel;
use starpc::{Error, Result};
// Use Error::Remote for test assertion errors since there's no Error::Remote.
use tokio::net::TcpStream;

use gen::{EchoMsg, EchoerClient, EchoerClientImpl};

const BODY_TXT: &str = "hello world via starpc cross-language e2e test";

/// Opens a new TCP connection per RPC call.
struct TcpStreamOpener {
    addr: String,
}

impl TcpStreamOpener {
    fn new(addr: String) -> Self {
        Self { addr }
    }
}

#[async_trait]
impl OpenStream for TcpStreamOpener {
    async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)> {
        let stream = TcpStream::connect(&self.addr).await?;
        let (read, write) = tokio::io::split(stream);
        Ok(create_packet_channel(read, write))
    }
}

#[tokio::main]
async fn main() {
    let addr = std::env::args()
        .nth(1)
        .expect("usage: integration-client <addr>");

    let opener = TcpStreamOpener::new(addr);
    let client = SrpcClient::new(opener);
    let echo = EchoerClientImpl::new(client);

    if let Err(e) = test_unary(&echo).await {
        eprintln!("unary test failed: {}", e);
        std::process::exit(1);
    }

    if let Err(e) = test_server_stream(&echo).await {
        eprintln!("server stream test failed: {}", e);
        std::process::exit(1);
    }

    if let Err(e) = test_client_stream(&echo).await {
        eprintln!("client stream test failed: {}", e);
        std::process::exit(1);
    }

    if let Err(e) = test_bidi_stream(&echo).await {
        eprintln!("bidi stream test failed: {}", e);
        std::process::exit(1);
    }

    println!("All tests passed.");
}

async fn test_unary(echo: &dyn EchoerClient) -> Result<()> {
    println!("Testing Unary RPC...");
    let req = EchoMsg {
        body: BODY_TXT.to_string(),
    };
    let resp = echo.echo(&req).await?;
    if resp.body != BODY_TXT {
        return Err(Error::Remote(format!(
            "expected {:?} got {:?}",
            BODY_TXT, resp.body
        )));
    }
    println!("  PASSED");
    Ok(())
}

async fn test_server_stream(echo: &dyn EchoerClient) -> Result<()> {
    println!("Testing ServerStream RPC...");
    let req = EchoMsg {
        body: BODY_TXT.to_string(),
    };
    let stream = echo.echo_server_stream(&req).await?;
    let mut received = 0;
    loop {
        match stream.recv().await {
            Ok(msg) => {
                if msg.body != BODY_TXT {
                    return Err(Error::Remote(format!(
                        "expected {:?} got {:?}",
                        BODY_TXT, msg.body
                    )));
                }
                received += 1;
            }
            Err(Error::StreamClosed) => break,
            Err(e) => return Err(e),
        }
    }
    if received != 5 {
        return Err(Error::Remote(format!(
            "expected 5 messages, got {}",
            received
        )));
    }
    println!("  PASSED");
    Ok(())
}

async fn test_client_stream(echo: &dyn EchoerClient) -> Result<()> {
    println!("Testing ClientStream RPC...");
    let stream = echo.echo_client_stream().await?;
    stream
        .send(&EchoMsg {
            body: BODY_TXT.to_string(),
        })
        .await?;
    let resp = stream.close_and_recv().await?;
    if resp.body != BODY_TXT {
        return Err(Error::Remote(format!(
            "expected {:?} got {:?}",
            BODY_TXT, resp.body
        )));
    }
    println!("  PASSED");
    Ok(())
}

async fn test_bidi_stream(echo: &dyn EchoerClient) -> Result<()> {
    println!("Testing BidiStream RPC...");
    let stream = echo.echo_bidi_stream().await?;

    // Receive initial message from server.
    let msg = stream.recv().await?;
    if msg.body != "hello from server" {
        return Err(Error::Remote(format!(
            "expected {:?} got {:?}",
            "hello from server", msg.body
        )));
    }

    // Send a message and expect echo.
    stream
        .send(&EchoMsg {
            body: BODY_TXT.to_string(),
        })
        .await?;
    let resp = stream.recv().await?;
    if resp.body != BODY_TXT {
        return Err(Error::Remote(format!(
            "expected {:?} got {:?}",
            BODY_TXT, resp.body
        )));
    }

    stream.close().await?;
    println!("  PASSED");
    Ok(())
}
