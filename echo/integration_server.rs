//! Echo transport endpoint used by cross-language integration checks.

#[allow(dead_code)]
mod gen;

use std::sync::Arc;

use async_trait::async_trait;
use starpc::{rpcstream, Error, Mux, Result, Server, Stream, StreamExt};
use tokio::net::TcpListener;

use gen::{EchoMsg, EchoerHandler, EchoerServer};

/// Implements each echo call shape through the supplied transport stream.
struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    async fn echo(&self, _context: &starpc::Context, request: EchoMsg) -> Result<EchoMsg> {
        Ok(EchoMsg { body: request.body })
    }

    async fn echo_server_stream(&self, request: EchoMsg, stream: Box<dyn Stream>) -> Result<()> {
        for _ in 0..5 {
            let response = EchoMsg {
                body: request.body.clone(),
            };
            stream.msg_send(&response).await?;
        }
        Ok(())
    }

    async fn echo_client_stream(&self, stream: &dyn Stream) -> Result<EchoMsg> {
        stream.msg_recv().await
    }

    async fn echo_bidi_stream(&self, stream: Box<dyn Stream>) -> Result<()> {
        // Send initial message (matches Go server behavior).
        stream
            .msg_send(&EchoMsg {
                body: "hello from server".to_string(),
            })
            .await?;
        loop {
            match stream.msg_recv::<EchoMsg>().await {
                Ok(msg) => {
                    stream.msg_send(&msg).await?;
                }
                Err(Error::StreamClosed) => break,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    async fn rpc_stream(&self, _stream: Box<dyn Stream>) -> Result<()> {
        Err(Error::Unimplemented)
    }

    async fn do_nothing(&self, _context: &starpc::Context, _request: ()) -> Result<()> {
        Ok(())
    }
}

/// Publishes a bound address and keeps accepted connections under the server owner.
#[tokio::main]
async fn main() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    println!("LISTENING {}", addr);

    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl)))?;

    // The server owns concurrent calls and their cancellation for this listener's lifetime.
    let incoming = futures::stream::unfold(listener, |listener| async move {
        Some((listener.accept().await.map(|(stream, _)| stream), listener))
    });
    Server::with_arc(mux).serve(Box::pin(incoming)).await
}
