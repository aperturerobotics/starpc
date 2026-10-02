//! Server implementation for starpc.
//!
//! This module provides the server-side API for handling incoming RPC calls.
//! The server supports all streaming patterns: unary, client streaming,
//! server streaming, and bidirectional streaming.

use futures::{stream::FuturesUnordered, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::codec::FramedRead;

use crate::codec::PacketCodec;
use crate::error::{Error, Result};
use crate::invoker::Invoker;
use crate::packet::Validate;
use crate::proto::packet::Body;
use crate::rpc::{PacketWriter, ServerRpc};
use crate::stream::{Context, Stream};
use crate::transport::TransportPacketWriter;

/// Default timeout for graceful shutdown after handler completes.
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(100);

/// Server configuration options.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// Timeout for graceful shutdown after handler completes.
    pub shutdown_timeout: Duration,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
        }
    }
}

/// Server for handling incoming RPC connections.
///
/// The Server routes incoming RPC calls to the appropriate handler
/// via the provided Invoker (typically a Mux).
///
/// # Example
///
/// ```ignore
/// use starpc::{Server, Mux};
///
/// let mux = Arc::new(Mux::new());
/// mux.register(Arc::new(MyServiceHandler))?;
///
/// let server = Server::new(mux);
/// server.handle_stream(tcp_stream).await?;
/// ```
pub struct Server<I: Invoker> {
    /// The invoker for routing RPC calls.
    pub invoker: Arc<I>,

    /// Server configuration.
    config: ServerConfig,

    /// Optional error handler for connection errors.
    /// If not set, errors are silently ignored.
    error_handler: Option<Arc<dyn Fn(Error) + Send + Sync>>,
}

impl<I: Invoker + 'static> Server<I> {
    /// Creates a new server with the given invoker.
    pub fn new(invoker: I) -> Self {
        Self {
            invoker: Arc::new(invoker),
            config: ServerConfig::default(),
            error_handler: None,
        }
    }

    /// Creates a new server with a shared invoker.
    pub fn with_arc(invoker: Arc<I>) -> Self {
        Self {
            invoker,
            config: ServerConfig::default(),
            error_handler: None,
        }
    }

    /// Sets the server configuration.
    pub fn with_config(mut self, config: ServerConfig) -> Self {
        self.config = config;
        self
    }

    /// Sets an error handler for connection errors.
    ///
    /// The handler is called when an error occurs during stream handling.
    /// This is useful for logging or metrics.
    pub fn with_error_handler<F>(mut self, handler: F) -> Self
    where
        F: Fn(Error) + Send + Sync + 'static,
    {
        self.error_handler = Some(Arc::new(handler));
        self
    }

    /// Reports an error through the error handler, if configured.
    pub(crate) fn report_error(&self, err: Error) {
        if let Some(ref handler) = self.error_handler {
            handler(err);
        }
    }

    /// Handles a single stream connection.
    ///
    /// This reads packets from the stream, routes the RPC call to the
    /// appropriate handler, and writes responses back.
    ///
    /// The method returns when the RPC completes or an error occurs.
    pub async fn handle_stream<T>(&self, transport: T) -> Result<()>
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (read_half, write_half) = tokio::io::split(transport);

        // Create the packet writer.
        let writer: Arc<dyn PacketWriter> = Arc::new(TransportPacketWriter::new(write_half));

        // Create framed reader.
        let mut framed = FramedRead::new(read_half, PacketCodec::new());

        // Wait for the first packet and take its CallStart body.
        let first_packet = framed.next().await;
        let Some(Ok(packet)) = first_packet else {
            // A decode error ends the stream; a closed transport has no error.
            return first_packet.map_or(Err(Error::StreamClosed), |res| res.map(|_| ()));
        };
        packet.validate()?;
        let Some(Body::CallStart(call_start)) = packet.body else {
            return Err(Error::ExpectedCallStart);
        };

        // Retain the call's transport context until this borrowing operation ends.
        let rpc = Arc::new(ServerRpc::from_call_start(
            Context::new(),
            call_start,
            writer,
        ));
        let _cancel = rpc.context().cancel_token().drop_guard_ref();

        // The packet reader is a sibling future, so dropping this call cannot detach transport work.
        let read = async {
            while let Some(result) = framed.next().await {
                match result {
                    Ok(packet) => {
                        if rpc.handle_packet(packet).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = rpc.handle_stream_close(None).await;
        };
        let invoke = serve_rpc(self.invoker.as_ref(), &rpc);
        tokio::pin!(read, invoke);

        // Remote closure cancels the same context that the active service receives.
        // After a reply, retain the existing bounded grace period for the peer's transport close.
        tokio::select! {
            () = &mut read => invoke.await,
            () = &mut invoke => {
                let _ = tokio::time::timeout(self.config.shutdown_timeout, read).await;
            }
        }

        Ok(())
    }

    /// handle_yamux handles a yamux connection by routing each accepted substream as a
    /// Starpc stream.
    #[cfg(feature = "yamux")]
    pub async fn handle_yamux<T>(&self, transport: T) -> Result<()>
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        self.handle_yamux_with_config(transport, yamux::Config::default())
            .await
    }

    /// handle_yamux_with_config handles a yamux connection with the provided yamux
    /// configuration.
    #[cfg(feature = "yamux")]
    pub async fn handle_yamux_with_config<T>(
        &self,
        transport: T,
        config: yamux::Config,
    ) -> Result<()>
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        crate::yamux::handle_server_connection(self, transport, config).await
    }

    /// handle_websocket_yamux handles a WebSocket connection carrying yamux substreams.
    #[cfg(all(feature = "websocket", feature = "yamux"))]
    pub async fn handle_websocket_yamux<T>(
        &self,
        socket: tokio_tungstenite::WebSocketStream<T>,
    ) -> Result<()>
    where
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        self.handle_yamux(crate::websocket::websocket_byte_stream(socket))
            .await
    }

    /// Accepts and handles connections concurrently, draining accepted calls when the listener ends.
    /// Dropping this future drops every active call and cancels its transport context.
    /// Individual connection failures reach the error handler without stopping other calls.
    pub async fn serve<L, T>(&self, mut listener: L) -> Result<()>
    where
        L: futures::Stream<Item = std::io::Result<T>> + Unpin,
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        // Concurrent call futures remain owned by this invocation, without detached tasks.
        let mut calls = FuturesUnordered::new();
        let mut accepting = true;
        loop {
            tokio::select! {
                connection = listener.next(), if accepting => {
                    match connection {
                        Some(Ok(stream)) => calls.push(async move {
                            if let Err(error) = self.handle_stream(stream).await {
                                self.report_error(error);
                            }
                        }),
                        Some(Err(error)) => self.report_error(Error::Io(error)),
                        None => accepting = false,
                    }
                }
                Some(()) = calls.next(), if !calls.is_empty() => {}
                else => return Ok(()),
            }
        }
    }
}

/// Invokes the method a server RPC names and settles the call with the outcome.
///
/// An unknown method or a handler error reaches the peer as an error, and a
/// handler that returns cleanly closes the send side. The RPC is closed last,
/// which releases its writer.
pub(crate) async fn serve_rpc<I: Invoker + ?Sized>(invoker: &I, rpc: &Arc<ServerRpc>) {
    // Invoke the method with the RPC as its stream.
    let (found, result) = invoker
        .invoke_method(rpc.service(), rpc.method(), Box::new(rpc.clone()))
        .await;

    // Report the outcome to the peer; a failed write leaves nothing to settle.
    let _ = if !found {
        rpc.send_error("method not implemented".to_string()).await
    } else if let Err(err) = result {
        rpc.send_error(err.to_string()).await
    } else {
        rpc.close_send().await
    };

    // Close the RPC so the connection does not stay open after the terminal response.
    let _ = rpc.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mux::Mux;
    use tokio::io::duplex;

    #[tokio::test]
    async fn test_server_config() {
        let mux = Mux::new();
        let server = Server::new(mux).with_config(ServerConfig {
            shutdown_timeout: Duration::from_secs(1),
        });

        assert_eq!(server.config.shutdown_timeout, Duration::from_secs(1));
    }

    #[tokio::test]
    async fn test_server_with_error_handler() {
        use std::sync::Mutex;

        let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let errors_clone = errors.clone();

        let mux = Mux::new();
        let server = Server::new(mux).with_error_handler(move |e| {
            errors_clone.lock().unwrap().push(e.to_string());
        });

        // Report an error
        server.report_error(Error::StreamClosed);

        let logged = errors.lock().unwrap();
        assert_eq!(logged.len(), 1);
        assert_eq!(logged[0], "stream closed");
    }

    #[tokio::test]
    async fn test_server_missing_call_start() {
        let mux = Mux::new();
        let server = Server::with_arc(Arc::new(mux));

        let (client_stream, server_stream) = duplex(1024);

        // Close immediately without sending CallStart
        drop(client_stream);

        let result = server.handle_stream(server_stream).await;
        assert!(matches!(result, Err(Error::StreamClosed)));
    }
}
