//! Protocol buffer types for rpcstream.
//!
//! These types are defined manually to match the rpcstream.proto definitions.
//! They will be generated via protoc-gen-prost in a future update.

use bytes::{Buf, BufMut, Bytes};
use prost::{DecodeError, Message};

/// RpcStreamPacket is a packet encapsulating data for a RPC stream.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct RpcStreamPacket {
    /// Body of the packet.
    pub body: Option<RpcStreamPacketBody>,
}

/// Body variants for RpcStreamPacket.
#[derive(Clone, PartialEq, Debug)]
pub enum RpcStreamPacketBody {
    /// Init is the first packet in the stream, sent by the initiator.
    Init(RpcStreamInit),
    /// Ack is sent in response to Init, by the server.
    Ack(RpcAck),
    /// Data is the encapsulated data packet.
    Data(Bytes),
}

/// RpcStreamInit is the first message in a RPC stream.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct RpcStreamInit {
    /// ComponentId is the identifier of the component making the request.
    pub component_id: String,
}

/// RpcAck is the acknowledgment message in a RPC stream.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct RpcAck {
    /// Error indicates there was some error setting up the stream.
    pub error: String,
}

// Manual Message implementation for RpcStreamInit
impl Message for RpcStreamInit {
    fn encode_raw(&self, buf: &mut impl BufMut)
    where
        Self: Sized,
    {
        if !self.component_id.is_empty() {
            prost::encoding::string::encode(1, &self.component_id, buf);
        }
    }

    fn merge_field(
        &mut self,
        tag: u32,
        wire_type: prost::encoding::WireType,
        buf: &mut impl Buf,
        ctx: prost::encoding::DecodeContext,
    ) -> Result<(), DecodeError>
    where
        Self: Sized,
    {
        match tag {
            1 => prost::encoding::string::merge(wire_type, &mut self.component_id, buf, ctx),
            _ => prost::encoding::skip_field(wire_type, tag, buf, ctx),
        }
    }

    fn encoded_len(&self) -> usize {
        let mut len = 0;
        if !self.component_id.is_empty() {
            len += prost::encoding::string::encoded_len(1, &self.component_id);
        }
        len
    }

    fn clear(&mut self) {
        self.component_id.clear();
    }
}

// Manual Message implementation for RpcAck
impl Message for RpcAck {
    fn encode_raw(&self, buf: &mut impl BufMut)
    where
        Self: Sized,
    {
        if !self.error.is_empty() {
            prost::encoding::string::encode(1, &self.error, buf);
        }
    }

    fn merge_field(
        &mut self,
        tag: u32,
        wire_type: prost::encoding::WireType,
        buf: &mut impl Buf,
        ctx: prost::encoding::DecodeContext,
    ) -> Result<(), DecodeError>
    where
        Self: Sized,
    {
        match tag {
            1 => prost::encoding::string::merge(wire_type, &mut self.error, buf, ctx),
            _ => prost::encoding::skip_field(wire_type, tag, buf, ctx),
        }
    }

    fn encoded_len(&self) -> usize {
        let mut len = 0;
        if !self.error.is_empty() {
            len += prost::encoding::string::encoded_len(1, &self.error);
        }
        len
    }

    fn clear(&mut self) {
        self.error.clear();
    }
}

// Manual Message implementation for RpcStreamPacket
impl Message for RpcStreamPacket {
    fn encode_raw(&self, buf: &mut impl BufMut)
    where
        Self: Sized,
    {
        match &self.body {
            Some(RpcStreamPacketBody::Init(init)) => {
                // Tag 1, wire type 2 (length-delimited)
                prost::encoding::message::encode(1, init, buf);
            }
            Some(RpcStreamPacketBody::Ack(ack)) => {
                // Tag 2, wire type 2 (length-delimited)
                prost::encoding::message::encode(2, ack, buf);
            }
            Some(RpcStreamPacketBody::Data(data)) => {
                // Tag 3, wire type 2 (length-delimited)
                prost::encoding::bytes::encode(3, data, buf);
            }
            None => {}
        }
    }

    fn merge_field(
        &mut self,
        tag: u32,
        wire_type: prost::encoding::WireType,
        buf: &mut impl Buf,
        ctx: prost::encoding::DecodeContext,
    ) -> Result<(), DecodeError>
    where
        Self: Sized,
    {
        match tag {
            1 => {
                let mut init = RpcStreamInit::default();
                prost::encoding::message::merge(wire_type, &mut init, buf, ctx)?;
                self.body = Some(RpcStreamPacketBody::Init(init));
                Ok(())
            }
            2 => {
                let mut ack = RpcAck::default();
                prost::encoding::message::merge(wire_type, &mut ack, buf, ctx)?;
                self.body = Some(RpcStreamPacketBody::Ack(ack));
                Ok(())
            }
            3 => {
                let mut data = Bytes::default();
                prost::encoding::bytes::merge(wire_type, &mut data, buf, ctx)?;
                self.body = Some(RpcStreamPacketBody::Data(data));
                Ok(())
            }
            _ => prost::encoding::skip_field(wire_type, tag, buf, ctx),
        }
    }

    fn encoded_len(&self) -> usize {
        match &self.body {
            Some(RpcStreamPacketBody::Init(init)) => prost::encoding::message::encoded_len(1, init),
            Some(RpcStreamPacketBody::Ack(ack)) => prost::encoding::message::encoded_len(2, ack),
            Some(RpcStreamPacketBody::Data(data)) => prost::encoding::bytes::encoded_len(3, data),
            None => 0,
        }
    }

    fn clear(&mut self) {
        self.body = None;
    }
}

impl RpcStreamPacket {
    /// Creates a new Init packet.
    pub fn new_init(component_id: String) -> Self {
        Self {
            body: Some(RpcStreamPacketBody::Init(RpcStreamInit { component_id })),
        }
    }

    /// Creates a new Ack packet.
    pub fn new_ack(error: String) -> Self {
        Self {
            body: Some(RpcStreamPacketBody::Ack(RpcAck { error })),
        }
    }

    /// Creates a new Data packet.
    pub fn new_data(data: Bytes) -> Self {
        Self {
            body: Some(RpcStreamPacketBody::Data(data)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rpc_stream_init_encode_decode() {
        let init = RpcStreamInit {
            component_id: "test-component".to_string(),
        };

        let encoded = init.encode_to_vec();
        let decoded = RpcStreamInit::decode(&encoded[..]).unwrap();

        assert_eq!(init, decoded);
    }

    #[test]
    fn test_rpc_ack_encode_decode() {
        let ack = RpcAck {
            error: "test error".to_string(),
        };

        let encoded = ack.encode_to_vec();
        let decoded = RpcAck::decode(&encoded[..]).unwrap();

        assert_eq!(ack, decoded);
    }

    #[test]
    fn test_rpc_stream_packet_init() {
        let packet = RpcStreamPacket::new_init("my-component".to_string());

        let encoded = packet.encode_to_vec();
        let decoded = RpcStreamPacket::decode(&encoded[..]).unwrap();

        match decoded.body {
            Some(RpcStreamPacketBody::Init(init)) => {
                assert_eq!(init.component_id, "my-component");
            }
            _ => panic!("Expected Init body"),
        }
    }

    #[test]
    fn test_rpc_stream_packet_ack() {
        let packet = RpcStreamPacket::new_ack("".to_string());

        let encoded = packet.encode_to_vec();
        let decoded = RpcStreamPacket::decode(&encoded[..]).unwrap();

        match decoded.body {
            Some(RpcStreamPacketBody::Ack(ack)) => {
                assert!(ack.error.is_empty());
            }
            _ => panic!("Expected Ack body"),
        }
    }

    #[test]
    fn test_rpc_stream_packet_data() {
        let packet = RpcStreamPacket::new_data(Bytes::from(vec![1, 2, 3, 4]));

        let encoded = packet.encode_to_vec();
        let decoded = RpcStreamPacket::decode(&encoded[..]).unwrap();

        match decoded.body {
            Some(RpcStreamPacketBody::Data(data)) => {
                assert_eq!(&data[..], &[1, 2, 3, 4]);
            }
            _ => panic!("Expected Data body"),
        }
    }
}
