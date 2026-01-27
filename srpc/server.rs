//! Server implementation for starpc.
//!
//! This module provides the server-side API for handling incoming RPC calls.
//! The server supports all streaming patterns: unary, client streaming,
//! server streaming, and bidirectional streaming.

use bytes::Bytes;
use futures::StreamExt;
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
    fn report_error(&self, err: Error) {
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

        // Wait for the first packet (CallStart).
        let first_packet = framed.next().await;
        let call_start = match first_packet {
            Some(Ok(packet)) => {
                // Validate the packet
                packet.validate()?;

                match packet.body {
                    Some(Body::CallStart(cs)) => cs,
                    _ => return Err(Error::ExpectedCallStart),
                }
            }
            Some(Err(e)) => return Err(e),
            None => return Err(Error::StreamClosed),
        };

        // Validate service and method IDs (already done by packet.validate(),
        // but double-check for clarity).
        if call_start.rpc_service.is_empty() {
            return Err(Error::EmptyServiceId);
        }
        if call_start.rpc_method.is_empty() {
            return Err(Error::EmptyMethodId);
        }

        let service_id = call_start.rpc_service.clone();
        let method_id = call_start.rpc_method.clone();

        // Create the server RPC.
        let ctx = Context::new();
        let rpc = Arc::new(ServerRpc::from_call_start(ctx, call_start, writer));

        // Spawn a task to read remaining packets.
        let rpc_clone = rpc.clone();
        let mut read_task = tokio::spawn(async move {
            while let Some(result) = framed.next().await {
                match result {
                    Ok(packet) => {
                        if rpc_clone.handle_packet(packet).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = rpc_clone.handle_stream_close(None).await;
        });

        // Invoke the method.
        let stream: Box<dyn Stream> = Box::new(ServerStream { rpc: rpc.clone() });
        let (found, result) = self
            .invoker
            .invoke_method(&service_id, &method_id, stream)
            .await;

        // Handle the result.
        if !found {
            // Send unimplemented error.
            let _ = rpc.send_error("method not implemented".to_string()).await;
        } else if let Err(e) = result {
            // Send error response.
            let _ = rpc.send_error(e.to_string()).await;
        } else {
            // Close send side on success.
            let _ = rpc.close_send().await;
        }

        // Explicitly close the RPC to release the writer/transport.
        // This ensures the connection doesn't remain open after the terminal response.
        let _ = rpc.close().await;

        // Wait for the read task to finish or timeout, then abort it.
        // This gives time for the client to receive our response.
        tokio::select! {
            _ = &mut read_task => {
                // Read task finished naturally
            }
            _ = tokio::time::sleep(self.config.shutdown_timeout) => {
                // Timeout - abort the read task
                read_task.abort();
            }
        }

        Ok(())
    }

    /// Accepts and handles connections in a loop.
    ///
    /// This is a convenience method that accepts connections from a listener
    /// and spawns a task to handle each one.
    ///
    /// Errors from individual connections are reported via the error handler
    /// (if configured) but don't stop the server.
    pub async fn serve<L, T>(&self, mut listener: L) -> Result<()>
    where
        L: futures::Stream<Item = std::io::Result<T>> + Unpin,
        T: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        while let Some(result) = listener.next().await {
            match result {
                Ok(stream) => {
                    let server = self.clone_for_spawn();
                    tokio::spawn(async move {
                        if let Err(e) = server.handle_stream(stream).await {
                            server.report_error(e);
                        }
                    });
                }
                Err(e) => {
                    self.report_error(Error::Io(e));
                }
            }
        }

        Ok(())
    }

    /// Creates a clone of the server for spawning tasks.
    fn clone_for_spawn(&self) -> Server<I> {
        Server {
            invoker: self.invoker.clone(),
            config: self.config.clone(),
            error_handler: self.error_handler.clone(),
        }
    }
}

/// Wrapper to provide Stream interface for ServerRpc.
struct ServerStream {
    rpc: Arc<ServerRpc>,
}

#[async_trait::async_trait]
impl Stream for ServerStream {
    fn context(&self) -> &Context {
        self.rpc.context()
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        self.rpc.send_bytes(data).await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        self.rpc.recv_bytes().await
    }

    async fn close_send(&self) -> Result<()> {
        self.rpc.close_send().await
    }

    async fn close(&self) -> Result<()> {
        self.rpc.close().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mux::Mux;
    use tokio::io::duplex;

    #[tokio::test]
    async fn test_server_config() {
        let mux = Mux::new();
        let server = Server::new(mux)
            .with_config(ServerConfig {
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
        let server = Server::new(mux)
            .with_error_handler(move |e| {
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
