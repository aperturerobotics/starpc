//! Message trait for protobuf messages.

use prost::Message as ProstMessage;

/// Trait for protobuf messages that can be sent over starpc.
pub trait Message: ProstMessage + Default + Send + Sync + 'static {}

// Blanket implementation for all prost messages.
impl<T: ProstMessage + Default + Send + Sync + 'static> Message for T {}
