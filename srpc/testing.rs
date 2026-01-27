//! Testing utilities for starpc.
//!
//! This module provides in-memory transports and helpers for testing
//! starpc services without actual network connections.

use async_trait::async_trait;
use std::sync::Arc;
use tokio::io::{duplex, DuplexStream};
use tokio::sync::Mutex;

use crate::client::{OpenStream, PacketReceiver};
use crate::error::{Error, Result};
use crate::rpc::PacketWriter;
use crate::transport::create_packet_channel;

/// Creates a pair of connected in-memory streams.
///
/// Returns (client_stream, server_stream) that can be used for testing
/// client-server communication.
///
/// # Arguments
/// * `buffer_size` - Size of the internal buffer for each direction
///
/// # Example
///
/// ```ignore
/// let (client_stream, server_stream) = create_pipe(64 * 1024);
///
/// // Use client_stream with a client
/// // Use server_stream with a server
/// ```
pub fn create_pipe(buffer_size: usize) -> (DuplexStream, DuplexStream) {
    duplex(buffer_size)
}

/// Creates a pair of connected in-memory streams with default buffer size.
pub fn create_pipe_default() -> (DuplexStream, DuplexStream) {
    create_pipe(64 * 1024)
}

/// In-memory stream opener for testing.
///
/// This opener can hold multiple streams and returns them one at a time
/// on each call to `open_stream`.
///
/// # Example
///
/// ```ignore
/// let (client_stream, server_stream) = create_pipe_default();
///
/// let opener = InMemoryOpener::new(vec![client_stream]);
/// let client = SrpcClient::new(opener);
///
/// // The client will use client_stream for its RPC
/// ```
pub struct InMemoryOpener {
    streams: Arc<Mutex<Vec<DuplexStream>>>,
}

impl InMemoryOpener {
    /// Creates a new in-memory opener with the given streams.
    ///
    /// Streams are consumed in LIFO order (last added is used first).
    pub fn new(streams: Vec<DuplexStream>) -> Self {
        Self {
            streams: Arc::new(Mutex::new(streams)),
        }
    }

    /// Creates a new in-memory opener with a single stream.
    pub fn single(stream: DuplexStream) -> Self {
        Self::new(vec![stream])
    }

    /// Adds a stream to the opener.
    pub async fn add_stream(&self, stream: DuplexStream) {
        self.streams.lock().await.push(stream);
    }
}

#[async_trait]
impl OpenStream for InMemoryOpener {
    async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)> {
        let mut streams = self.streams.lock().await;
        let stream = streams.pop().ok_or(Error::StreamClosed)?;

        let (read_half, write_half) = tokio::io::split(stream);
        Ok(create_packet_channel(read_half, write_half))
    }
}

/// Single-use in-memory opener.
///
/// A simpler version of `InMemoryOpener` that holds exactly one stream.
pub struct SingleInMemoryOpener {
    stream: Mutex<Option<DuplexStream>>,
}

impl SingleInMemoryOpener {
    /// Creates a new single in-memory opener.
    pub fn new(stream: DuplexStream) -> Self {
        Self {
            stream: Mutex::new(Some(stream)),
        }
    }
}

#[async_trait]
impl OpenStream for SingleInMemoryOpener {
    async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)> {
        let stream = self
            .stream
            .lock()
            .await
            .take()
            .ok_or(Error::StreamClosed)?;

        let (read_half, write_half) = tokio::io::split(stream);
        Ok(create_packet_channel(read_half, write_half))
    }
}

/// Creates a connected client-server test setup.
///
/// Returns (client_opener, server_stream) where:
/// - `client_opener` can be used to create a `SrpcClient`
/// - `server_stream` can be passed to `Server::handle_stream`
///
/// # Example
///
/// ```ignore
/// let (opener, server_stream) = create_test_pair();
///
/// let client = SrpcClient::new(opener);
/// let server = Server::new(mux);
///
/// // Spawn server
/// tokio::spawn(async move {
///     server.handle_stream(server_stream).await
/// });
///
/// // Use client
/// let response = client.exec_call("svc", "method", &request).await?;
/// ```
pub fn create_test_pair() -> (SingleInMemoryOpener, DuplexStream) {
    let (client_stream, server_stream) = create_pipe_default();
    (SingleInMemoryOpener::new(client_stream), server_stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::Handler;
    use crate::invoker::Invoker;
    use crate::mux::Mux;
    use crate::server::Server;
    use crate::stream::Stream;
    use crate::{Client, SrpcClient};

    struct EchoHandler;

    #[async_trait]
    impl Invoker for EchoHandler {
        async fn invoke_method(
            &self,
            _service_id: &str,
            method_id: &str,
            stream: Box<dyn Stream>,
        ) -> (bool, Result<()>) {
            if method_id != "Echo" {
                return (false, Err(Error::Unimplemented));
            }

            // Read request.
            let request = match stream.recv_bytes().await {
                Ok(b) => b,
                Err(e) => return (true, Err(e)),
            };

            // Echo it back.
            if let Err(e) = stream.send_bytes(request).await {
                return (true, Err(e));
            }

            (true, Ok(()))
        }
    }

    impl Handler for EchoHandler {
        fn service_id(&self) -> &'static str {
            "test.Echo"
        }

        fn method_ids(&self) -> &'static [&'static str] {
            &["Echo"]
        }
    }

    #[tokio::test]
    async fn test_in_memory_echo() {
        // Create a pipe.
        let (client_stream, server_stream) = create_pipe_default();

        // Set up the server.
        let mux = Arc::new(Mux::new());
        mux.register(Arc::new(EchoHandler)).unwrap();
        let server = Server::with_arc(mux);

        // Spawn server handler.
        let server_handle = tokio::spawn(async move {
            let _ = server.handle_stream(server_stream).await;
        });

        // Create client.
        let opener = SingleInMemoryOpener::new(client_stream);
        let client = SrpcClient::new(opener);

        // Make the call.
        let stream = client
            .new_stream("test.Echo", "Echo", Some(b"hello"))
            .await
            .unwrap();

        // Close send side to indicate we're done sending.
        stream.close_send().await.unwrap();

        // Read response with a timeout to handle potential races.
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.recv_bytes(),
        )
        .await
        .expect("timeout")
        .expect("recv_bytes failed");
        assert_eq!(&response[..], b"hello");

        // Wait for server to complete.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), server_handle).await;
    }

    #[tokio::test]
    async fn test_create_test_pair() {
        let (opener, server_stream) = create_test_pair();

        // Set up the server.
        let mux = Arc::new(Mux::new());
        mux.register(Arc::new(EchoHandler)).unwrap();
        let server = Server::with_arc(mux);

        // Spawn server handler.
        let server_handle = tokio::spawn(async move {
            let _ = server.handle_stream(server_stream).await;
        });

        // Create client.
        let client = SrpcClient::new(opener);

        // Make the call using raw bytes.
        let stream = client
            .new_stream("test.Echo", "Echo", Some(b"test data"))
            .await
            .unwrap();

        stream.close_send().await.unwrap();

        let response = stream.recv_bytes().await.unwrap();
        assert_eq!(&response[..], b"test data");

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_multi_stream_opener() {
        let (stream1, _) = create_pipe_default();
        let (stream2, _) = create_pipe_default();

        let opener = InMemoryOpener::new(vec![stream1, stream2]);

        // Should succeed twice (LIFO order)
        let result1 = opener.open_stream().await;
        assert!(result1.is_ok());

        let result2 = opener.open_stream().await;
        assert!(result2.is_ok());

        // Third should fail
        let result3 = opener.open_stream().await;
        assert!(matches!(result3, Err(Error::StreamClosed)));
    }
}
