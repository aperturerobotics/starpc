mod gen;

use std::sync::Arc;

use async_trait::async_trait;
use starpc::{Error, Mux, Result, Server, Stream, StreamExt};
use tokio::net::TcpListener;

use gen::{EchoMsg, EchoerHandler, EchoerServer, Empty};

struct EchoServerImpl;

#[async_trait]
impl EchoerServer for EchoServerImpl {
    async fn echo(&self, request: EchoMsg) -> Result<EchoMsg> {
        Ok(EchoMsg {
            body: request.body,
        })
    }

    async fn echo_server_stream(
        &self,
        request: EchoMsg,
        stream: Box<dyn Stream>,
    ) -> Result<()> {
        for _ in 0..5 {
            let response = EchoMsg {
                body: request.body.clone(),
            };
            stream.msg_send(&response).await?;
        }
        Ok(())
    }

    async fn echo_client_stream(&self, stream: &dyn Stream) -> Result<EchoMsg> {
        match stream.msg_recv::<EchoMsg>().await {
            Ok(msg) => Ok(msg),
            Err(e) => Err(e),
        }
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

    async fn do_nothing(&self, _request: Empty) -> Result<Empty> {
        Ok(Empty {})
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    println!("LISTENING {}", addr);

    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoerHandler::new(EchoServerImpl)))?;

    loop {
        let (stream, _) = listener.accept().await?;
        let server = Server::with_arc(mux.clone());
        tokio::spawn(async move {
            let _ = server.handle_stream(stream).await;
        });
    }
}
