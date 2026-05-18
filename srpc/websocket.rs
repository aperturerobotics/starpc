//! WebSocket transport adapters for starpc.

use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

/// WEBSOCKET_BYTE_STREAM_BUFFER is the duplex buffer used by WebSocket byte adapters.
pub const WEBSOCKET_BYTE_STREAM_BUFFER: usize = 64 * 1024;

/// WEBSOCKET_MESSAGE_BUFFER is the maximum byte chunk sent in one WebSocket message.
pub const WEBSOCKET_MESSAGE_BUFFER: usize = 16 * 1024;

/// websocket_byte_stream adapts a binary WebSocket stream to Tokio byte I/O.
///
/// The adapter treats incoming binary WebSocket messages as consecutive bytes
/// and writes outbound byte chunks as binary WebSocket messages. Control and
/// text messages are ignored except that close terminates the byte stream.
pub fn websocket_byte_stream<S>(socket: WebSocketStream<S>) -> DuplexStream
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (mut socket_writer, mut socket_reader) = socket.split();
    let (stream, peer) = tokio::io::duplex(WEBSOCKET_BYTE_STREAM_BUFFER);
    let (mut peer_reader, mut peer_writer) = tokio::io::split(peer);

    tokio::spawn(async move {
        while let Some(result) = socket_reader.next().await {
            match result {
                Ok(message) if message.is_binary() => {
                    let data = message.into_data();
                    if peer_writer.write_all(data.as_ref()).await.is_err() {
                        break;
                    }
                    if peer_writer.flush().await.is_err() {
                        break;
                    }
                }
                Ok(message) if message.is_close() => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = peer_writer.shutdown().await;
    });

    tokio::spawn(async move {
        let mut buf = vec![0; WEBSOCKET_MESSAGE_BUFFER];
        loop {
            match peer_reader.read(&mut buf).await {
                Ok(0) => {
                    let _ = socket_writer.close().await;
                    break;
                }
                Ok(n) => {
                    let message = Message::Binary(Bytes::copy_from_slice(&buf[..n]));
                    if socket_writer.send(message).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = socket_writer.close().await;
                    break;
                }
            }
        }
    });

    stream
}
