//! RpcStreamWriter - PacketWriter implementation for RpcStream.

use async_trait::async_trait;
use prost::Message;

use crate::error::Result;
use crate::proto::Packet;
use crate::rpc::PacketWriter;

use super::rpcstream::RpcStream;
use super::RpcStreamPacket;

/// RpcStreamWriter wraps an RpcStream and implements PacketWriter.
///
/// This allows using an RpcStream as the transport for nested RPC calls,
/// converting Packet messages to RpcStreamPacket::Data messages.
pub struct RpcStreamWriter<S> {
    /// The underlying RpcStream.
    pub(crate) inner: S,
}

impl<S> RpcStreamWriter<S> {
    /// Creates a new RpcStreamWriter.
    pub fn new(stream: S) -> Self {
        Self { inner: stream }
    }

    /// Returns a reference to the inner stream.
    pub fn inner(&self) -> &S {
        &self.inner
    }
}

#[async_trait]
impl<S: RpcStream + Send + Sync> PacketWriter for RpcStreamWriter<S> {
    async fn write_packet(&self, packet: Packet) -> Result<()> {
        let data = packet.encode_to_vec();
        let rpc_packet = RpcStreamPacket::new_data(data);
        self.inner.send_packet(&rpc_packet).await
    }

    async fn close(&self) -> Result<()> {
        self.inner.close_send().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpcstream::rpc_stream_packet;
    use crate::stream::{Context, Stream};
    use bytes::Bytes;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Mutex;

    struct MockRpcStream {
        ctx: Context,
        packets: Mutex<VecDeque<RpcStreamPacket>>,
        closed: AtomicBool,
    }

    impl MockRpcStream {
        fn new() -> Self {
            Self {
                ctx: Context::new(),
                packets: Mutex::new(VecDeque::new()),
                closed: AtomicBool::new(false),
            }
        }

        async fn get_packets(&self) -> Vec<RpcStreamPacket> {
            self.packets.lock().await.iter().cloned().collect()
        }
    }

    #[async_trait]
    impl Stream for MockRpcStream {
        fn context(&self) -> &Context {
            &self.ctx
        }

        async fn send_bytes(&self, _data: Bytes) -> Result<()> {
            Ok(())
        }

        async fn recv_bytes(&self) -> Result<Bytes> {
            Err(crate::Error::StreamClosed)
        }

        async fn close_send(&self) -> Result<()> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[async_trait]
    impl RpcStream for MockRpcStream {
        async fn send_packet(&self, packet: &RpcStreamPacket) -> Result<()> {
            self.packets.lock().await.push_back(packet.clone());
            Ok(())
        }

        async fn recv_packet(&self) -> Result<RpcStreamPacket> {
            Err(crate::Error::StreamClosed)
        }
    }

    #[tokio::test]
    async fn test_rpc_stream_writer_write_packet() {
        use std::sync::Arc;
        let stream = Arc::new(MockRpcStream::new());
        let writer = RpcStreamWriter::new(stream.clone());

        let packet = crate::packet::new_call_start(
            "test.Service".to_string(),
            "TestMethod".to_string(),
            Some(Bytes::from(vec![1, 2, 3])),
        );

        writer.write_packet(packet).await.unwrap();

        let packets = stream.get_packets().await;
        assert_eq!(packets.len(), 1);

        match &packets[0].body {
            Some(rpc_stream_packet::Body::Data(data)) => {
                // Verify we can decode the inner packet
                let inner = Packet::decode(&data[..]).unwrap();
                assert!(inner.body.is_some());
            }
            _ => panic!("Expected Data packet"),
        }
    }

    #[tokio::test]
    async fn test_rpc_stream_writer_close() {
        use std::sync::Arc;
        let stream = Arc::new(MockRpcStream::new());
        let writer = RpcStreamWriter::new(stream.clone());

        writer.close().await.unwrap();
        assert!(stream.closed.load(Ordering::SeqCst));
    }
}
