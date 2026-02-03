//! Generated code for the echo service.
//!
//! This module includes pre-generated protobuf types and service stubs.

// Re-export starpc's RpcStreamPacket types for use by the service stubs.
pub use starpc::rpcstream::RpcStreamPacket;

// Empty type for google.protobuf.Empty
#[derive(Clone, PartialEq, Eq, Hash, ::prost::Message)]
pub struct Empty {}

// Include the generated message types.
include!("../echo.pb.rs");

// Include the generated service stubs.
include!("../echo_srpc.pb.rs");
