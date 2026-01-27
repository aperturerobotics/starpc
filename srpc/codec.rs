//! Length-prefixed packet codec for starpc wire format.
//!
//! Wire format: 4-byte little-endian u32 length prefix + protobuf-encoded packet.

use bytes::{Buf, BufMut, BytesMut};
use prost::Message;
use tokio_util::codec::{Decoder, Encoder};

use crate::error::{Error, Result};
use crate::proto::Packet;

/// Maximum message size (10MB, same as Go implementation).
pub const MAX_MESSAGE_SIZE: usize = 10_000_000;

/// Length of the size prefix in bytes.
const SIZE_PREFIX_LEN: usize = 4;

/// Codec for encoding and decoding starpc packets with length-prefix framing.
#[derive(Debug, Default, Clone)]
pub struct PacketCodec;

impl PacketCodec {
    /// Creates a new packet codec.
    pub fn new() -> Self {
        Self
    }
}

impl Decoder for PacketCodec {
    type Item = Packet;
    type Error = Error;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>> {
        // Need at least the size prefix.
        if src.len() < SIZE_PREFIX_LEN {
            return Ok(None);
        }

        // Read the length prefix (little-endian u32).
        let mut size_bytes = [0u8; SIZE_PREFIX_LEN];
        size_bytes.copy_from_slice(&src[..SIZE_PREFIX_LEN]);
        let msg_size = u32::from_le_bytes(size_bytes) as usize;

        // Validate message size.
        if msg_size == 0 {
            return Err(Error::MessageSizeZero);
        }
        if msg_size > MAX_MESSAGE_SIZE {
            return Err(Error::MessageTooLarge(msg_size, MAX_MESSAGE_SIZE));
        }

        // Check if we have the complete message.
        let total_size = SIZE_PREFIX_LEN + msg_size;
        if src.len() < total_size {
            // Reserve capacity for the remaining data.
            src.reserve(total_size - src.len());
            return Ok(None);
        }

        // Consume the length prefix.
        src.advance(SIZE_PREFIX_LEN);

        // Decode the packet.
        let packet_bytes = src.split_to(msg_size);
        let packet = Packet::decode(&packet_bytes[..])?;

        Ok(Some(packet))
    }
}

impl Encoder<Packet> for PacketCodec {
    type Error = Error;

    fn encode(&mut self, item: Packet, dst: &mut BytesMut) -> Result<()> {
        // Calculate the encoded size.
        let msg_size = item.encoded_len();

        // Validate message size.
        if msg_size > MAX_MESSAGE_SIZE {
            return Err(Error::MessageTooLarge(msg_size, MAX_MESSAGE_SIZE));
        }

        // Reserve space for the length prefix and message.
        dst.reserve(SIZE_PREFIX_LEN + msg_size);

        // Write the length prefix (little-endian u32).
        dst.put_u32_le(msg_size as u32);

        // Encode the packet directly into the buffer.
        item.encode(dst)?;

        Ok(())
    }
}

/// Encode a packet to bytes with length prefix.
pub fn encode_packet(packet: &Packet) -> Result<Vec<u8>> {
    let msg_size = packet.encoded_len();
    if msg_size > MAX_MESSAGE_SIZE {
        return Err(Error::MessageTooLarge(msg_size, MAX_MESSAGE_SIZE));
    }

    let mut buf = Vec::with_capacity(SIZE_PREFIX_LEN + msg_size);
    buf.extend_from_slice(&(msg_size as u32).to_le_bytes());
    packet.encode(&mut buf)?;

    Ok(buf)
}

/// Decode a packet from bytes (without length prefix).
pub fn decode_packet(bytes: &[u8]) -> Result<Packet> {
    Ok(Packet::decode(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{packet::Body, CallData, CallStart};

    #[test]
    fn test_codec_roundtrip_call_start() {
        let mut codec = PacketCodec::new();
        let mut buf = BytesMut::new();

        let packet = Packet {
            body: Some(Body::CallStart(CallStart {
                rpc_service: "test.Service".into(),
                rpc_method: "TestMethod".into(),
                data: vec![1, 2, 3],
                data_is_zero: false,
            })),
        };

        codec.encode(packet.clone(), &mut buf).unwrap();

        let decoded = codec.decode(&mut buf).unwrap().unwrap();
        assert_eq!(decoded, packet);
    }

    #[test]
    fn test_codec_roundtrip_call_data() {
        let mut codec = PacketCodec::new();
        let mut buf = BytesMut::new();

        let packet = Packet {
            body: Some(Body::CallData(CallData {
                data: vec![4, 5, 6],
                data_is_zero: false,
                complete: true,
                error: String::new(),
            })),
        };

        codec.encode(packet.clone(), &mut buf).unwrap();

        let decoded = codec.decode(&mut buf).unwrap().unwrap();
        assert_eq!(decoded, packet);
    }

    #[test]
    fn test_codec_roundtrip_call_cancel() {
        let mut codec = PacketCodec::new();
        let mut buf = BytesMut::new();

        let packet = Packet {
            body: Some(Body::CallCancel(true)),
        };

        codec.encode(packet.clone(), &mut buf).unwrap();

        let decoded = codec.decode(&mut buf).unwrap().unwrap();
        assert_eq!(decoded, packet);
    }

    #[test]
    fn test_codec_partial_read() {
        let mut codec = PacketCodec::new();
        let mut buf = BytesMut::new();

        let packet = Packet {
            body: Some(Body::CallData(CallData {
                data: vec![1, 2, 3, 4, 5],
                data_is_zero: false,
                complete: false,
                error: String::new(),
            })),
        };

        // Encode the packet.
        codec.encode(packet.clone(), &mut buf).unwrap();

        // Split the buffer to simulate partial read.
        let full_buf = buf.clone();
        buf.truncate(3); // Only the first 3 bytes.

        // Should return None (need more data).
        assert!(codec.decode(&mut buf).unwrap().is_none());

        // Add the rest of the data.
        buf.extend_from_slice(&full_buf[3..]);

        // Now it should decode.
        let decoded = codec.decode(&mut buf).unwrap().unwrap();
        assert_eq!(decoded, packet);
    }

    #[test]
    fn test_codec_message_too_large() {
        let mut codec = PacketCodec::new();
        let mut buf = BytesMut::new();

        // Create a message that exceeds the maximum size.
        let packet = Packet {
            body: Some(Body::CallData(CallData {
                data: vec![0u8; MAX_MESSAGE_SIZE + 1],
                data_is_zero: false,
                complete: false,
                error: String::new(),
            })),
        };

        let result = codec.encode(packet, &mut buf);
        assert!(matches!(result, Err(Error::MessageTooLarge(_, _))));
    }
}
