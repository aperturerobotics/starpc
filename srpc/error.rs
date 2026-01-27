//! Error types for starpc.
//!
//! This module provides the error types used throughout the starpc library,
//! matching the error semantics of the Go and TypeScript implementations.

use thiserror::Error;

/// Errors that can occur in starpc operations.
#[derive(Error, Debug)]
pub enum Error {
    /// The requested RPC method is not implemented.
    #[error("method not implemented")]
    Unimplemented,

    /// A packet was received after the RPC was completed.
    #[error("unexpected packet after rpc was completed")]
    Completed,

    /// An unrecognized packet type was received.
    #[error("unrecognized packet type")]
    UnrecognizedPacket,

    /// An empty packet was received (no body or CallData with no content).
    #[error("invalid empty packet")]
    EmptyPacket,

    /// Invalid message format (protobuf decode error).
    #[error("invalid message: {0}")]
    InvalidMessage(#[from] prost::DecodeError),

    /// The method ID is empty.
    #[error("method id empty")]
    EmptyMethodId,

    /// The service ID is empty.
    #[error("service id empty")]
    EmptyServiceId,

    /// No RPC clients are available.
    #[error("no available rpc clients")]
    NoAvailableClients,

    /// The writer is not initialized.
    #[error("writer cannot be nil")]
    NilWriter,

    /// IO error during read/write operations.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// The stream was closed.
    #[error("stream closed")]
    StreamClosed,

    /// The RPC was aborted.
    #[error("rpc aborted")]
    Aborted,

    /// The context was cancelled.
    #[error("context cancelled")]
    Cancelled,

    /// The stream idle timeout was exceeded.
    #[error("stream idle timeout exceeded")]
    StreamIdle,

    /// Remote error from the other end.
    #[error("remote error: {0}")]
    Remote(String),

    /// Message size exceeds maximum allowed size.
    #[error("message size {0} exceeds maximum {1}")]
    MessageTooLarge(usize, usize),

    /// Message size is zero but data_is_zero flag is not set.
    #[error("unexpected zero length prefix")]
    MessageSizeZero,

    /// Expected CallStart packet but got a different packet type.
    #[error("expected CallStart packet")]
    ExpectedCallStart,

    /// CallStart was sent more than once.
    #[error("call start must be sent only once")]
    DuplicateCallStart,

    /// CallData received before CallStart.
    #[error("call start must be sent before call data")]
    CallDataBeforeStart,

    /// Protocol encode error.
    #[error("encode error: {0}")]
    Encode(#[from] prost::EncodeError),

    /// Channel send error (internal).
    #[error("channel closed")]
    ChannelClosed,
}

impl Error {
    /// Returns true if this error indicates the RPC was aborted.
    pub fn is_abort(&self) -> bool {
        matches!(self, Error::Aborted | Error::Cancelled)
    }

    /// Returns true if this error indicates the stream was closed.
    pub fn is_closed(&self) -> bool {
        matches!(self, Error::StreamClosed | Error::Cancelled)
    }

    /// Returns true if this error indicates a timeout.
    pub fn is_timeout(&self) -> bool {
        matches!(self, Error::StreamIdle)
    }

    /// Returns true if this error indicates the method is not implemented.
    pub fn is_unimplemented(&self) -> bool {
        matches!(self, Error::Unimplemented)
    }

    /// Creates a remote error from a string.
    pub fn remote(msg: impl Into<String>) -> Self {
        Error::Remote(msg.into())
    }
}

/// Result type alias using starpc's Error type.
pub type Result<T> = std::result::Result<T, Error>;

/// Error code constants matching the TypeScript implementation.
pub mod codes {
    /// Error code for RPC abort.
    pub const ERR_RPC_ABORT: &str = "ERR_RPC_ABORT";

    /// Error code for stream idle timeout.
    pub const ERR_STREAM_IDLE: &str = "ERR_STREAM_IDLE";
}

/// Checks if an error message indicates an abort.
pub fn is_abort_error_message(msg: &str) -> bool {
    msg == codes::ERR_RPC_ABORT || msg == "rpc aborted" || msg == "context cancelled"
}

/// Checks if an error message indicates a stream idle timeout.
pub fn is_stream_idle_error_message(msg: &str) -> bool {
    msg == codes::ERR_STREAM_IDLE || msg == "stream idle timeout exceeded"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        assert_eq!(Error::Unimplemented.to_string(), "method not implemented");
        assert_eq!(Error::Completed.to_string(), "unexpected packet after rpc was completed");
        assert_eq!(Error::EmptyMethodId.to_string(), "method id empty");
        assert_eq!(Error::Remote("test error".into()).to_string(), "remote error: test error");
    }

    #[test]
    fn test_error_predicates() {
        assert!(Error::Aborted.is_abort());
        assert!(Error::Cancelled.is_abort());
        assert!(!Error::StreamClosed.is_abort());

        assert!(Error::StreamClosed.is_closed());
        assert!(Error::Cancelled.is_closed());
        assert!(!Error::Aborted.is_closed());

        assert!(Error::StreamIdle.is_timeout());
        assert!(!Error::Cancelled.is_timeout());

        assert!(Error::Unimplemented.is_unimplemented());
        assert!(!Error::Cancelled.is_unimplemented());
    }
}
