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

/// Receiver for incoming packets from a transport.
pub type PacketReceiver = tokio::sync::mpsc::Receiver<Packet>;

/// Sender for incoming packets to be processed.
pub type PacketSender = tokio::sync::mpsc::Sender<Packet>;

/// Default channel buffer size for packet channels.
pub const DEFAULT_CHANNEL_BUFFER: usize = 32;

/// Spawns a task that reads packets from a transport and sends them through a channel.
///
/// This is a common pattern used by both client and server to handle incoming packets.
/// The task will run until the transport is closed or an error occurs.
///
/// # Arguments
/// * `reader` - The async reader to read packets from
/// * `sender` - The channel sender to forward packets to
///
/// # Returns
/// A `JoinHandle` for the spawned task.
pub fn spawn_packet_reader<R>(
    reader: R,
    sender: PacketSender,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut framed = FramedRead::new(reader, PacketCodec::new());
        while let Some(result) = framed.next().await {
            match result {
                Ok(packet) => {
                    if sender.send(packet).await.is_err() {
                        // Receiver dropped, stop reading
                        break;
                    }
                }
                Err(_) => {
                    // Read error, stop reading
                    break;
                }
            }
        }
    })
}

/// Creates a packet writer and receiver from a split transport.
///
/// This is a convenience function that:
/// 1. Creates a `TransportPacketWriter` from the write half
/// 2. Spawns a packet reader task for the read half
/// 3. Returns the writer and receiver channel
///
/// # Arguments
/// * `read_half` - The read half of the transport
/// * `write_half` - The write half of the transport
///
/// # Returns
/// A tuple of (packet writer, packet receiver).
pub fn create_packet_channel<R, W>(
    read_half: R,
    write_half: W,
) -> (Arc<dyn PacketWriter>, PacketReceiver)
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let writer: Arc<dyn PacketWriter> = Arc::new(TransportPacketWriter::new(write_half));
    let (tx, rx) = tokio::sync::mpsc::channel(DEFAULT_CHANNEL_BUFFER);
    spawn_packet_reader(read_half, tx);
    (writer, rx)
}

/// Encodes optional data for protobuf messages.
///
/// Handles the `data_is_zero` flag convention used in starpc:
/// - `None` -> empty data, `data_is_zero = false`
/// - `Some(empty)` -> empty data, `data_is_zero = true`
/// - `Some(data)` -> data bytes, `data_is_zero = false`
///
/// # Returns
/// A tuple of (data bytes, data_is_zero flag).
pub fn encode_optional_data(data: Option<Bytes>) -> (Vec<u8>, bool) {
    match data {
        Some(d) if d.is_empty() => (vec![], true),
        Some(d) => (d.to_vec(), false),
        None => (vec![], false),
    }
}

/// Decodes optional data from protobuf messages.
///
/// Inverse of `encode_optional_data`.
///
/// # Returns
/// `Some(Bytes)` if data was present (including empty data with `data_is_zero`),
/// `None` if no data was included.
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
