//! Client implementation for starpc.
//!
//! This module provides the client-side API for making RPC calls,
//! supporting unary, client streaming, server streaming, and
//! bidirectional streaming patterns.

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt as _;
use prost::Message;
use std::sync::Arc;

use crate::error::{Error, Result};
use crate::rpc::{ClientRpc, PacketWriter};
use crate::stream::{Context, Stream, StreamExt};
use crate::transport::create_packet_channel;

/// Owned incoming packets; dropping this stream releases its transport or nested call.
pub type PacketReceiver = futures::stream::BoxStream<'static, crate::proto::Packet>;

/// Trait for opening streams to a remote server.
///
/// Implementations of this trait provide the transport layer for RPC calls.
/// Each call to `open_stream` should return a new, independent stream.
#[async_trait]
pub trait OpenStream: Send + Sync {
    /// Opens a new stream and returns a packet writer and a receiver for incoming packets.
    async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)>;
}

/// Client trait for making RPC calls.
///
/// This trait defines the core client operations matching the Go Client interface.
#[async_trait]
pub trait Client: Send + Sync {
    /// Executes a unary RPC call.
    ///
    /// Sends the input message and waits for a single response.
    async fn exec_call<I, O>(&self, service: &str, method: &str, input: &I) -> Result<O>
    where
        I: Message + Send + Sync,
        O: Message + Default;

    /// Opens a new stream for a streaming RPC, sending `first_msg` as the
    /// initial data when present.
    async fn new_stream(
        &self,
        service: &str,
        method: &str,
        first_msg: Option<&[u8]>,
    ) -> Result<Box<dyn Stream>>;
}

/// Boxed Client trait object.
pub type BoxClient = Box<dyn Client>;

/// Standard starpc client implementation.
///
/// This is the primary client implementation that works with any transport
/// implementing the `OpenStream` trait.
pub struct SrpcClient<T: OpenStream> {
    /// The stream opener.
    opener: T,
}

impl<T: OpenStream> SrpcClient<T> {
    /// Creates a new client with the given stream opener.
    pub fn new(opener: T) -> Self {
        Self { opener }
    }
}

#[async_trait]
impl<T: OpenStream + 'static> Client for SrpcClient<T> {
    async fn exec_call<I, O>(&self, service: &str, method: &str, input: &I) -> Result<O>
    where
        I: Message + Send + Sync,
        O: Message + Default,
    {
        // Marshal the input.
        let input_data = input.encode_to_vec();

        // Open a stream.
        let (writer, mut receiver) = self.opener.open_stream().await?;

        // Create the client RPC.
        let ctx = Context::new();
        let rpc = Arc::new(ClientRpc::new(
            ctx.clone(),
            service.to_string(),
            method.to_string(),
            writer,
        ));

        // Cancellation and every early return release the directly owned incoming transport.
        let _cancel = ctx.cancel_token().drop_guard_ref();
        rpc.start(Some(Bytes::from(input_data))).await?;

        // Read packets alongside the unary response without a second task or lifetime.
        let read = async {
            while let Some(packet) = receiver.next().await {
                if rpc.handle_packet(packet).await.is_err() {
                    break;
                }
            }
            let _ = rpc.handle_stream_close(None).await;
        };
        let response = async {
            // A failed half-close means the call ended; msg_recv reports its outcome.
            let _ = rpc.close_send().await;
            let output: O = rpc.msg_recv().await?;

            // Process trailing completion before releasing the writer and receive capability.
            let _ = rpc.wait().await;
            let _ = rpc.close().await;
            Ok(output)
        };
        tokio::pin!(read, response);

        // Transport closure settles the same RPC that the response future is observing.
        tokio::select! {
            output = &mut response => output,
            () = &mut read => response.await,
        }
    }

    async fn new_stream(
        &self,
        service: &str,
        method: &str,
        first_msg: Option<&[u8]>,
    ) -> Result<Box<dyn Stream>> {
        // Open a stream.
        let (writer, mut receiver) = self.opener.open_stream().await?;

        // Create the client RPC.
        let ctx = Context::new();
        let rpc = Arc::new(ClientRpc::new(
            ctx.clone(),
            service.to_string(),
            method.to_string(),
            writer,
        ));

        // Start the RPC.
        let first_data = first_msg.map(|d| Bytes::from(d.to_vec()));
        rpc.start(first_data).await?;

        // Spawn a task to handle incoming packets.
        let rpc_clone = rpc.clone();
        let packet_handler = tokio::spawn(async move {
            while let Some(packet) = receiver.next().await {
                if rpc_clone.handle_packet(packet).await.is_err() {
                    break;
                }
            }
            let _ = rpc_clone.handle_stream_close(None).await;
        });

        // Return a stream wrapper that provides the Stream interface.
        Ok(Box::new(ClientStream {
            rpc,
            packet_handler: tokio::sync::Mutex::new(Some(packet_handler)),
        }))
    }
}

/// Stream wrapper for client-side streaming.
struct ClientStream {
    rpc: Arc<ClientRpc>,
    /// Handle to the background packet handler task.
    /// Aborted when the stream is closed.
    packet_handler: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for ClientStream {
    fn drop(&mut self) {
        self.rpc.context().cancel();
        if let Some(handler) = self.packet_handler.get_mut().take() {
            handler.abort();
        }
    }
}

#[async_trait]
impl Stream for ClientStream {
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
        let _ = self.rpc.close().await;
        // Abort the background packet handler to ensure cleanup.
        let mut handler = self.packet_handler.lock().await;
        if let Some(handle) = handler.as_mut() {
            handle.abort();
            let _ = handle.await;
        }
        handler.take();
        Ok(())
    }
}

/// Transport-based stream openers.
///
/// This module provides `OpenStream` implementations for common transport types.
pub mod transport {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncRead, AsyncWrite};

    /// A simple stream opener over a single connection.
    ///
    /// This opener consumes a single transport connection on the first call
    /// to `open_stream`. Subsequent calls will fail with `StreamClosed`.
    ///
    /// For multiplexed connections (multiple concurrent streams), use yamux
    /// or similar multiplexing protocols.
    ///
    /// # Example
    ///
    /// ```ignore
    /// use tokio::net::TcpStream;
    /// use starpc::client::transport::SingleStreamOpener;
    ///
    /// let stream = TcpStream::connect("127.0.0.1:8080").await?;
    /// let opener = SingleStreamOpener::new(stream);
    /// let client = SrpcClient::new(opener);
    /// ```
    pub struct SingleStreamOpener<T> {
        inner: Mutex<Option<T>>,
    }

    impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> SingleStreamOpener<T> {
        /// Creates a new single stream opener.
        pub fn new(transport: T) -> Self {
            Self {
                inner: Mutex::new(Some(transport)),
            }
        }
    }

    #[async_trait]
    impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> OpenStream for SingleStreamOpener<T> {
        async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)> {
            let transport = self
                .inner
                .lock()
                .unwrap()
                .take()
                .ok_or(Error::StreamClosed)?;

            let (read_half, write_half) = tokio::io::split(transport);
            Ok(create_packet_channel(read_half, write_half))
        }
    }

    /// Re-export TransportPacketWriter for direct use.
    pub use crate::transport::TransportPacketWriter;

    /// Re-export YamuxStreamOpener for multiplexed transports.
    #[cfg(feature = "yamux")]
    pub use crate::yamux::YamuxStreamOpener;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    struct MockWriter {
        closed: AtomicBool,
    }

    impl MockWriter {
        fn new() -> Self {
            Self {
                closed: AtomicBool::new(false),
            }
        }
    }

    #[async_trait]
    impl PacketWriter for MockWriter {
        async fn write_packet(&self, _packet: crate::proto::Packet) -> Result<()> {
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    struct MockOpener {
        writer: Arc<MockWriter>,
        receiver: Mutex<Option<PacketReceiver>>,
    }

    impl MockOpener {
        fn new() -> (Self, tokio::sync::mpsc::Sender<crate::proto::Packet>) {
            let (tx, rx) = tokio::sync::mpsc::channel(32);
            (
                Self {
                    writer: Arc::new(MockWriter::new()),
                    receiver: Mutex::new(Some(Box::pin(futures::stream::unfold(
                        rx,
                        |mut receiver| async move {
                            receiver.recv().await.map(|packet| (packet, receiver))
                        },
                    )))),
                },
                tx,
            )
        }
    }

    #[async_trait]
    impl OpenStream for MockOpener {
        async fn open_stream(&self) -> Result<(Arc<dyn PacketWriter>, PacketReceiver)> {
            let rx = self
                .receiver
                .lock()
                .unwrap()
                .take()
                .ok_or(Error::StreamClosed)?;
            Ok((self.writer.clone(), rx))
        }
    }

    #[tokio::test]
    async fn test_client_new_stream() {
        let (opener, _tx) = MockOpener::new();
        let client = SrpcClient::new(opener);

        let stream = client
            .new_stream("test.Service", "TestMethod", Some(b"hello"))
            .await
            .unwrap();

        assert!(!stream.context().is_cancelled());
        let context = stream.context().clone();
        drop(stream);
        assert!(context.is_cancelled());
    }

    #[tokio::test]
    async fn test_single_stream_opener_only_once() {
        use tokio::io::duplex;

        let (client_stream, _server_stream) = duplex(1024);
        let opener = transport::SingleStreamOpener::new(client_stream);

        // First open should succeed
        let result1 = opener.open_stream().await;
        assert!(result1.is_ok());

        // Second open should fail
        let result2 = opener.open_stream().await;
        assert!(matches!(result2, Err(Error::StreamClosed)));
    }

    #[tokio::test]
    async fn malformed_unary_response_releases_receiver() {
        #[derive(Clone, PartialEq, prost::Message)]
        struct Reply {
            #[prost(string, tag = "1")]
            text: String,
        }

        let (opener, sender) = MockOpener::new();
        let client = SrpcClient::new(opener);
        sender
            .send(crate::packet::new_call_data_full(
                Some(Bytes::from_static(&[0xff])),
                false,
                None,
            ))
            .await
            .unwrap();
        let result: Result<Reply> = client.exec_call("test", "call", &Reply::default()).await;
        assert!(result.is_err());
        tokio::time::timeout(std::time::Duration::from_secs(2), sender.closed())
            .await
            .expect("failed unary call retained its packet receiver");
    }
}
