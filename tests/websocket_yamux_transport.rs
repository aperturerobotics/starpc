#![cfg(all(feature = "websocket", feature = "yamux"))]

use async_trait::async_trait;
use prost::Message;
use std::sync::Arc;
use tokio::net::TcpListener;

use starpc::client::transport::YamuxStreamOpener;
use starpc::error::{Error, Result};
use starpc::handler::Handler;
use starpc::invoker::Invoker;
use starpc::mux::Mux;
use starpc::server::Server;
use starpc::stream::{Stream, StreamExt};
use starpc::{Client, SrpcClient};

#[derive(Clone, PartialEq, Message)]
struct EchoMsg {
    #[prost(string, tag = "1")]
    body: String,
}

struct EchoServer;

#[async_trait]
impl Invoker for EchoServer {
    async fn invoke_method(
        &self,
        _service_id: &str,
        method_id: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        match method_id {
            "Echo" => {
                let msg: EchoMsg = match stream.msg_recv().await {
                    Ok(msg) => msg,
                    Err(err) => return (true, Err(err)),
                };
                (true, stream.msg_send(&msg).await)
            }
            _ => (false, Err(Error::Unimplemented)),
        }
    }
}

impl Handler for EchoServer {
    fn service_id(&self) -> &'static str {
        "echo.Echoer"
    }

    fn method_ids(&self) -> &'static [&'static str] {
        &["Echo"]
    }
}

fn echo_server() -> Server<Mux> {
    let mux = Arc::new(Mux::new());
    mux.register(Arc::new(EchoServer)).unwrap();
    Server::with_arc(mux)
}

#[tokio::test]
async fn yamux_opener_executes_multiple_calls_over_one_connection() {
    let (client_io, server_io) = tokio::io::duplex(256 * 1024);

    let server = echo_server();
    let server_task = tokio::spawn(async move {
        let _ = server.handle_yamux(server_io).await;
    });

    let client = SrpcClient::new(YamuxStreamOpener::client(client_io));
    for body in ["first yamux call", "second yamux call"] {
        let request = EchoMsg {
            body: body.to_string(),
        };
        let response: EchoMsg = client
            .exec_call("echo.Echoer", "Echo", &request)
            .await
            .unwrap();
        assert_eq!(response.body, body);
    }

    server_task.abort();
}

#[tokio::test]
async fn websocket_yamux_executes_unary_call() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = echo_server();
    let server_task = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let _ = server.handle_websocket_yamux(socket).await;
    });

    let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    let client = SrpcClient::new(YamuxStreamOpener::client_websocket(socket));

    let request = EchoMsg {
        body: "websocket yamux call".to_string(),
    };
    let response: EchoMsg = client
        .exec_call("echo.Echoer", "Echo", &request)
        .await
        .unwrap();
    assert_eq!(response.body, request.body);

    server_task.abort();
}
