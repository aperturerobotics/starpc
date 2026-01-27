//! Generated protocol buffer types for starpc.
//!
//! This module contains the Packet, CallStart, CallData types generated from
//! rpcproto.proto. These types define the wire protocol for starpc.

// Include the generated protobuf types.
include!(concat!(env!("OUT_DIR"), "/srpc.rs"));

// Re-export commonly used items.
pub use self::packet::Body;
