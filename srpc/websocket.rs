//! Owned WebSocket byte transport for StarPC.

use bytes::{Buf, Bytes};
use futures::{Sink, Stream};
use std::io;
use std::pin::Pin;
use std::task::{ready, Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_tungstenite::{tungstenite, tungstenite::Message, WebSocketStream};

/// Maximum byte chunk sent in one WebSocket message.
pub const WEBSOCKET_MESSAGE_BUFFER: usize = 16 * 1024;

/// Adapts binary WebSocket messages to byte I/O without background tasks.
/// Incoming binary messages form one byte stream. Text and control messages
/// carry no application bytes; a close message ends input. Dropping this
/// capability drops its socket, including when input is idle.
pub fn websocket_byte_stream<S>(socket: WebSocketStream<S>) -> WebSocketByteStream<S> {
    WebSocketByteStream {
        socket,
        buffered: Bytes::new(),
        input: Input::Open,
    }
}

/// Byte I/O that owns its WebSocket and the unread part of one incoming message.
pub struct WebSocketByteStream<S> {
    socket: WebSocketStream<S>,
    buffered: Bytes,
    input: Input,
}

enum Input {
    Open,
    Closing,
    Ended,
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for WebSocketByteStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        // Retain each message until all its bytes have reached the reader.
        loop {
            if !this.buffered.is_empty() {
                let count = output.remaining().min(this.buffered.len());
                output.put_slice(&this.buffered[..count]);
                this.buffered.advance(count);
                return Poll::Ready(Ok(()));
            }
            match this.input {
                Input::Closing => {
                    // Flush Tungstenite's close acknowledgment before reporting EOF.
                    ready!(Pin::new(&mut this.socket).poll_flush(cx)).map_err(socket_error)?;
                    this.input = Input::Ended;
                    return Poll::Ready(Ok(()));
                }
                Input::Ended => return Poll::Ready(Ok(())),
                Input::Open => {}
            }

            // Tungstenite owns WebSocket control handling and pending control writes.
            match ready!(Pin::new(&mut this.socket).poll_next(cx)) {
                Some(Ok(Message::Binary(data))) => this.buffered = data,
                Some(Ok(Message::Close(_))) => this.input = Input::Closing,
                None => this.input = Input::Ended,
                Some(Ok(_)) => {}
                Some(Err(error)) => return Poll::Ready(Err(socket_error(error))),
            }
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for WebSocketByteStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        if input.is_empty() {
            return Poll::Ready(Ok(0));
        }

        // Respect socket backpressure before accepting another bounded message.
        let socket = &mut self.get_mut().socket;
        ready!(Pin::new(&mut *socket).poll_ready(cx)).map_err(socket_error)?;
        let count = input.len().min(WEBSOCKET_MESSAGE_BUFFER);
        Pin::new(socket)
            .start_send(Message::Binary(Bytes::copy_from_slice(&input[..count])))
            .map_err(socket_error)?;
        Poll::Ready(Ok(count))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket)
            .poll_flush(cx)
            .map_err(socket_error)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket)
            .poll_close(cx)
            .map_err(socket_error)
    }
}

fn socket_error(error: tungstenite::Error) -> io::Error {
    match error {
        tungstenite::Error::Io(error) => error,
        other => io::Error::other(other),
    }
}
