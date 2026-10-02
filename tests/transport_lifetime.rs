#![cfg(all(feature = "websocket", feature = "yamux"))]

use async_trait::async_trait;
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use starpc::client::OpenStream;
use starpc::error::Result;
use starpc::invoker::Invoker;
use starpc::stream::{Context, Stream};
use starpc::websocket::{websocket_byte_stream, WEBSOCKET_MESSAGE_BUFFER};
use starpc::{Client, Server, SrpcClient, YamuxStreamOpener};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::protocol::Role, tungstenite::Message, WebSocketStream};

struct PendingService(mpsc::UnboundedSender<Context>);

#[async_trait]
impl Invoker for PendingService {
    async fn invoke_method(
        &self,
        _service: &str,
        _method: &str,
        stream: Box<dyn Stream>,
    ) -> (bool, Result<()>) {
        self.0.send(stream.context().clone()).unwrap();
        stream.context().cancelled().await;
        (true, Ok(()))
    }
}

#[tokio::test]
async fn last_yamux_opener_drop_releases_idle_transport() {
    let (transport, mut peer) = tokio::io::duplex(1024);
    let opener = YamuxStreamOpener::client(transport);
    let last = opener.clone();
    drop(opener);
    drop(last);

    let mut input = Vec::new();
    peer.read_to_end(&mut input).await.unwrap();
}

#[tokio::test]
async fn concurrent_yamux_close_joins_and_rejects_later_calls() {
    let (transport, mut peer) = tokio::io::duplex(1024);
    let opener = YamuxStreamOpener::client(transport);
    tokio::join!(opener.close(), opener.close());

    let mut input = Vec::new();
    peer.read_to_end(&mut input).await.unwrap();
    assert!(opener.open_stream().await.is_err());
}

#[tokio::test]
async fn dropping_yamux_server_cancels_every_accepted_call() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (entered, mut calls) = mpsc::unbounded_channel();
    let server = Server::new(PendingService(entered));
    let owner = tokio::spawn(async move { server.handle_yamux(server_io).await });
    let opener = YamuxStreamOpener::client(client_io);
    let client = Arc::new(SrpcClient::new(opener.clone()));

    // Observe two actual incoming calls before removing their connection owner.
    let mut clients = tokio::task::JoinSet::new();
    for _ in 0..2 {
        let client = client.clone();
        clients.spawn(async move { client.exec_call::<(), ()>("pending", "wait", &()).await });
    }
    let first = calls.recv().await.unwrap();
    let second = calls.recv().await.unwrap();
    owner.abort();
    assert!(owner.await.unwrap_err().is_cancelled());

    first.cancelled().await;
    second.cancelled().await;
    while let Some(result) = clients.join_next().await {
        assert!(result.unwrap().is_err());
    }
    opener.close().await;
}

#[tokio::test]
async fn closing_yamux_client_cancels_accepted_server_call() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (entered, mut calls) = mpsc::unbounded_channel();
    let server = Server::new(PendingService(entered));
    let owner = tokio::spawn(async move { server.handle_yamux(server_io).await });
    let opener = YamuxStreamOpener::client(client_io);
    let client = SrpcClient::new(opener.clone());
    let call =
        tokio::spawn(async move { client.exec_call::<(), ()>("pending", "wait", &()).await });

    let context = calls.recv().await.unwrap();
    opener.close().await;
    context.cancelled().await;
    assert!(call.await.unwrap().is_err());
    let _ = owner.await.unwrap();
}

#[tokio::test]
async fn dropping_idle_websocket_bytes_releases_socket_immediately() {
    let (transport, mut peer) = tokio::io::duplex(1024);
    let socket = WebSocketStream::from_raw_socket(transport, Role::Client, None).await;
    drop(websocket_byte_stream(socket));

    let mut byte = [0];
    assert_eq!(peer.read(&mut byte).await.unwrap(), 0);
}

#[tokio::test]
async fn websocket_bytes_preserve_messages_controls_and_backpressure() {
    let (left, right) = tokio::io::duplex(64);
    let client = WebSocketStream::from_raw_socket(left, Role::Client, None).await;
    let mut peer = WebSocketStream::from_raw_socket(right, Role::Server, None).await;
    let mut bytes = websocket_byte_stream(client);
    let payload = vec![42; WEBSOCKET_MESSAGE_BUFFER * 2 + 7];

    // A small transport forces writes to await socket backpressure across chunks.
    let write = async {
        bytes.write_all(&payload).await.unwrap();
        bytes.flush().await.unwrap();
    };
    let receive = async {
        let mut result = Vec::new();
        while result.len() < payload.len() {
            let Message::Binary(chunk) = peer.next().await.unwrap().unwrap() else {
                panic!("expected binary payload");
            };
            assert!(chunk.len() <= WEBSOCKET_MESSAGE_BUFFER);
            result.extend_from_slice(&chunk);
        }
        assert_eq!(result, payload);
    };
    tokio::join!(write, receive);

    // Empty, text and ping frames contribute no bytes; small reads retain tails.
    let send = async {
        peer.send(Message::Text("ignored".into())).await.unwrap();
        peer.send(Message::Binary(Bytes::new())).await.unwrap();
        peer.send(Message::Ping(Bytes::from_static(b"ping")))
            .await
            .unwrap();
        peer.send(Message::Binary(Bytes::from_static(b"abc")))
            .await
            .unwrap();
        peer.send(Message::Binary(Bytes::from_static(b"def")))
            .await
            .unwrap();
        peer.close(None).await.unwrap();
        loop {
            match peer.next().await.unwrap().unwrap() {
                Message::Pong(data) => assert_eq!(data.as_ref(), b"ping"),
                Message::Close(_) => break,
                other => panic!("unexpected control response: {other:?}"),
            }
        }
    };
    let read = async {
        let mut actual = Vec::new();
        let mut chunk = [0; 2];
        loop {
            let count = bytes.read(&mut chunk).await.unwrap();
            if count == 0 {
                break;
            }
            actual.extend_from_slice(&chunk[..count]);
        }
        assert_eq!(actual, b"abcdef");
    };
    tokio::join!(send, read);
}
