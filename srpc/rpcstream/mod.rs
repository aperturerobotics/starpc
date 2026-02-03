//! RpcStream module for nested RPC calls.
//!
//! This module enables nesting RPC calls within RPC calls, supporting
//! component-based architectures where different components expose different
//! services via sub-streams.
//!
//! # Overview
//!
//! The rpcstream protocol works as follows:
//! 1. Client opens a bidirectional stream to the server
//! 2. Client sends `RpcStreamInit` with the target component ID
//! 3. Server looks up the component and sends `RpcAck`
//! 4. Both sides exchange `RpcStreamPacket::Data` containing nested RPC packets
//!
//! # Example
//!
//! ```rust,ignore
//! use starpc::rpcstream::{open_rpc_stream, RpcStreamGetter};
//!
//! // Client side: open a stream to a component
//! let stream = my_service.rpc_stream().await?;
//! let rpc_stream = open_rpc_stream(stream, "my-component", true).await?;
//!
//! // Server side: handle incoming rpc stream
//! let getter: RpcStreamGetter = Arc::new(|ctx, component_id, released| {
//!     // Look up the invoker for this component
//!     Some((invoker, release_fn))
//! });
//! handle_rpc_stream(stream, getter).await?;
//! ```

mod proto;
mod stream;
mod writer;

pub use proto::*;
pub use stream::*;
pub use writer::*;
