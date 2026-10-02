//! Transport utilities for starpc.
//!
//! This module provides common transport-related functionality including
//! packet writers and stream reading helpers.

use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures::StreamExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio_util::codec::{Encoder, FramedRead};

use crate::client::PacketReceiver;
use crate::codec::PacketCodec;
use crate::error::{Error, Result};
use crate::proto::Packet;
use crate::rpc::PacketWriter;

/// A packet writer over an async write transport.
///
/// This is the canonical implementation of `PacketWriter` for any transport
/// that implements `AsyncWrite`. It handles length-prefix framing and
/// thread-safe access to the underlying writer.
pub struct TransportPacketWriter<W> {
    writer: Mutex<W>,
    closed: AtomicBool,
}

impl<W: AsyncWrite + Send + Unpin> TransportPacketWriter<W> {
    /// Creates a new transport packet writer.
    pub fn new(writer: W) -> Self {
        Self {
            writer: Mutex::new(writer),
            closed: AtomicBool::new(false),
        }
    }

    /// Returns true if the writer has been closed.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl<W: AsyncWrite + Send + Unpin + 'static> PacketWriter for TransportPacketWriter<W> {
    async fn write_packet(&self, packet: Packet) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::StreamClosed);
        }

        let mut buf = BytesMut::new();
        let mut codec = PacketCodec::new();
        codec.encode(packet, &mut buf)?;

        let mut writer = self.writer.lock().await;
        writer.write_all(&buf).await?;
        writer.flush().await?;

        Ok(())
    }

    async fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        let mut writer = self.writer.lock().await;
        writer.shutdown().await?;
        Ok(())
    }
}

/// Default bounded request capacity for multiplexed transport admission.
#[cfg(feature = "yamux")]
pub(crate) const DEFAULT_CHANNEL_BUFFER: usize = 32;

/// Creates a packet writer and an owned incoming packet stream from a split transport.
/// The receiver reads on demand; dropping it immediately releases the read half.
/// No background task or additional packet queue is created.
pub fn create_packet_channel<R, W>(
    read_half: R,
    write_half: W,
) -> (Arc<dyn PacketWriter>, PacketReceiver)
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    // Framing belongs to the returned receive capability for its complete lifetime.
    let reader = FramedRead::new(read_half, PacketCodec::new());
    let packets = futures::stream::unfold(reader, |mut reader| async move {
        match reader.next().await {
            Some(Ok(packet)) => Some((packet, reader)),
            _ => None,
        }
    });

    // The peer-facing writer retains its own half of this same transport.
    let writer: Arc<dyn PacketWriter> = Arc::new(TransportPacketWriter::new(write_half));
    (writer, Box::pin(packets))
}

/// Encodes optional data for protobuf messages.
///
/// Handles the `data_is_zero` flag convention used in starpc:
/// - `None` -> empty data, `data_is_zero = false`
/// - `Some(empty)` -> empty data, `data_is_zero = true`
/// - `Some(data)` -> data bytes, `data_is_zero = false`
pub fn encode_optional_data(data: Option<Bytes>) -> (Vec<u8>, bool) {
    match data {
        Some(d) if d.is_empty() => (vec![], true),
        Some(d) => (d.to_vec(), false),
        None => (vec![], false),
    }
}

/// Decodes optional data from protobuf messages, inverting
/// `encode_optional_data`: `Some(Bytes)` when data was present, including
/// empty data with `data_is_zero` set.
pub fn decode_optional_data(data: Vec<u8>, data_is_zero: bool) -> Option<Bytes> {
    if !data.is_empty() || data_is_zero {
        Some(Bytes::from(data))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_optional_data_none() {
        let (data, is_zero) = encode_optional_data(None);
        assert!(data.is_empty());
        assert!(!is_zero);
    }

    #[test]
    fn test_encode_optional_data_empty() {
        let (data, is_zero) = encode_optional_data(Some(Bytes::new()));
        assert!(data.is_empty());
        assert!(is_zero);
    }

    #[test]
    fn test_encode_optional_data_with_content() {
        let (data, is_zero) = encode_optional_data(Some(Bytes::from(vec![1, 2, 3])));
        assert_eq!(data, vec![1, 2, 3]);
        assert!(!is_zero);
    }

    #[test]
    fn test_decode_optional_data_none() {
        let result = decode_optional_data(vec![], false);
        assert!(result.is_none());
    }

    #[test]
    fn test_decode_optional_data_empty() {
        let result = decode_optional_data(vec![], true);
        assert_eq!(result, Some(Bytes::new()));
    }

    #[test]
    fn test_decode_optional_data_with_content() {
        let result = decode_optional_data(vec![1, 2, 3], false);
        assert_eq!(result, Some(Bytes::from(vec![1, 2, 3])));
    }
}
