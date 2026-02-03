//! Starpc - Streaming Protobuf RPC Framework
//!
//! This crate provides a streaming RPC framework built on protobuf, offering
//! full-duplex bidirectional streaming with support for unary, server-streaming,
//! client-streaming, and bidirectional streaming RPC patterns.
//!
//! # Features
//!
//! - **Wire-compatible** with the Go and TypeScript implementations
//! - **Streaming support** for all RPC patterns
//! - **Transport agnostic** - works with TCP, WebSocket, or any AsyncRead/AsyncWrite
//! - **Code generation** via starpc-build crate
//!
//! # Quick Start
//!
//! ## Client
//!
//! ```rust,ignore
//! use starpc::{Client, SrpcClient};
//! use starpc::client::transport::SingleStreamOpener;
//! use tokio::net::TcpStream;
//!
//! // Connect to a server
//! let stream = TcpStream::connect("127.0.0.1:8080").await?;
//! let opener = SingleStreamOpener::new(stream);
//! let client = SrpcClient::new(opener);
//!
//! // Make a unary call
//! let response: MyResponse = client
//!     .exec_call("my.Service", "MyMethod", &request)
//!     .await?;
//! ```
//!
//! ## Server
//!
//! ```rust,ignore
//! use starpc::{Server, Mux, Handler};
//! use std::sync::Arc;
//!
//! // Create a mux and register handlers
//! let mux = Arc::new(Mux::new());
//! mux.register(Arc::new(MyServiceHandler))?;
//!
//! // Create the server
//! let server = Server::with_arc(mux);
//!
//! // Handle a connection
//! server.handle_stream(tcp_stream).await?;
//! ```
//!
//! # Wire Format
//!
//! Starpc uses a simple length-prefixed framing:
//! - 4-byte little-endian u32 length prefix
//! - Protobuf-encoded Packet message
//!
//! This format is compatible with the Go and TypeScript implementations.

pub mod client;
pub mod codec;
pub mod error;
pub mod handler;
pub mod invoker;
pub mod message;
pub mod mux;
pub mod packet;
pub mod proto;
pub mod rpc;
pub mod rpcstream;
pub mod server;
pub mod stream;
pub mod testing;
pub mod transport;

// Re-exports for convenience.
pub use client::{BoxClient, Client, OpenStream, SrpcClient};
pub use codec::{PacketCodec, MAX_MESSAGE_SIZE};
pub use error::{Error, Result};
pub use handler::{BoxHandler, Handler};
pub use invoker::{BoxInvoker, Invoker};
pub use message::Message;
pub use mux::{Mux, QueryableInvoker};
pub use packet::Validate;
pub use rpc::{ClientRpc, PacketWriter, ServerRpc};
pub use server::{Server, ServerConfig};
pub use stream::{ArcStream, BoxStream, Context, Stream, StreamExt};
pub use transport::{
    create_packet_channel, decode_optional_data, encode_optional_data, TransportPacketWriter,
};

// Re-export async_trait for use in generated code.
pub use async_trait::async_trait;
pub use prost::Message as ProstMessage;

/// Prelude module for convenient imports.
pub mod prelude {
    pub use crate::client::{Client, OpenStream, SrpcClient};
    pub use crate::error::{Error, Result};
    pub use crate::handler::Handler;
    pub use crate::invoker::Invoker;
    pub use crate::mux::Mux;
    pub use crate::packet::Validate;
    pub use crate::server::Server;
    pub use crate::stream::{Context, Stream, StreamExt};

    pub use async_trait::async_trait;
    pub use prost::Message as ProstMessage;
}
