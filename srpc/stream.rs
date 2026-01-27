//! Stream abstraction for RPC communication.
//!
//! This module provides the core `Stream` trait for bidirectional RPC
//! communication, along with context management for cancellation.

use async_trait::async_trait;
use bytes::Bytes;
use prost::Message;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

/// Context for an RPC stream, providing cancellation support.
///
/// The Context wraps a `CancellationToken` and provides a convenient API
/// for managing RPC lifecycles. Child contexts can be created that will
/// be cancelled when the parent is cancelled.
///
/// # Example
///
/// ```rust,ignore
/// let ctx = Context::new();
///
/// // Check if cancelled
/// if ctx.is_cancelled() {
///     return Err(Error::Cancelled);
/// }
///
/// // Wait for cancellation
/// ctx.cancelled().await;
///
/// // Create a child context
/// let child = ctx.child();
///
/// // Cancel the context
/// ctx.cancel();
/// ```
#[derive(Debug, Clone)]
pub struct Context {
    /// Cancellation token for this context.
    cancel_token: CancellationToken,
}

impl Default for Context {
    fn default() -> Self {
        Self::new()
    }
}

impl Context {
    /// Creates a new context.
    pub fn new() -> Self {
        Self {
            cancel_token: CancellationToken::new(),
        }
    }

    /// Creates a new context with a cancellation token.
    pub fn with_cancel_token(cancel_token: CancellationToken) -> Self {
        Self { cancel_token }
    }

    /// Creates a child context that will be cancelled when the parent is cancelled.
    pub fn child(&self) -> Self {
        Self {
            cancel_token: self.cancel_token.child_token(),
        }
    }

    /// Returns the cancellation token.
    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel_token
    }

    /// Cancels this context and all child contexts.
    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }

    /// Returns true if this context is cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancel_token.is_cancelled()
    }

    /// Waits until the context is cancelled.
    ///
    /// This is useful for implementing cooperative cancellation in handlers.
    pub async fn cancelled(&self) {
        self.cancel_token.cancelled().await
    }

    /// Returns a future that completes when the context is cancelled.
    ///
    /// Unlike `cancelled()`, this returns an owned future that can be stored.
    pub fn cancellation(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let token = self.cancel_token.clone();
        async move {
            token.cancelled().await;
        }
    }
}

/// Stream trait for bidirectional RPC communication.
///
/// This trait provides message send/receive operations for streaming RPCs.
/// The trait is object-safe by using bytes for the core methods.
///
/// # Implementation Notes
///
/// - All methods are async and may block waiting for I/O or messages
/// - `send_bytes` may return `Error::Completed` if `close_send` was already called
/// - `recv_bytes` returns `Error::StreamClosed` when the remote closes
/// - `close` cancels the context and releases all resources
#[async_trait]
pub trait Stream: Send + Sync {
    /// Returns the context for this stream.
    ///
    /// The context can be used to check for cancellation or to get
    /// a cancellation token for cooperative cancellation.
    fn context(&self) -> &Context;

    /// Sends raw bytes on the stream.
    ///
    /// # Errors
    ///
    /// - `Error::Completed` if `close_send` was already called
    /// - `Error::StreamClosed` if the connection was closed
    /// - `Error::Io` for transport errors
    async fn send_bytes(&self, data: Bytes) -> Result<()>;

    /// Receives raw bytes from the stream.
    ///
    /// # Errors
    ///
    /// - `Error::StreamClosed` if the remote closed the stream
    /// - `Error::Remote` if the remote sent an error
    /// - `Error::Cancelled` if the context was cancelled
    async fn recv_bytes(&self) -> Result<Bytes>;

    /// Closes the send side of the stream.
    ///
    /// After calling this, `send_bytes` will return `Error::Completed`.
    /// The receive side remains open until the remote closes.
    async fn close_send(&self) -> Result<()>;

    /// Closes both sides of the stream.
    ///
    /// This cancels the context and releases all resources.
    async fn close(&self) -> Result<()>;
}

/// Extension trait for typed message send/receive.
///
/// This trait provides convenience methods for sending and receiving
/// protobuf messages over a Stream.
#[async_trait]
pub trait StreamExt: Stream {
    /// Sends a typed message on the stream.
    ///
    /// The message is encoded using protobuf and sent as bytes.
    ///
    /// # Type Parameters
    ///
    /// - `M`: A protobuf message type that implements `prost::Message`
    async fn msg_send<M: Message + Send + Sync>(&self, msg: &M) -> Result<()> {
        let data = msg.encode_to_vec();
        self.send_bytes(Bytes::from(data)).await
    }

    /// Receives a typed message from the stream.
    ///
    /// The received bytes are decoded as the specified protobuf message type.
    ///
    /// # Type Parameters
    ///
    /// - `M`: A protobuf message type that implements `prost::Message + Default`
    ///
    /// # Errors
    ///
    /// - `Error::InvalidMessage` if the bytes cannot be decoded as the message type
    /// - All errors from `recv_bytes`
    async fn msg_recv<M: Message + Default>(&self) -> Result<M> {
        let data = self.recv_bytes().await?;
        M::decode(&data[..]).map_err(Error::InvalidMessage)
    }
}

// Blanket implementation for all Stream types.
impl<T: Stream + ?Sized> StreamExt for T {}

// Blanket implementation for Arc<T> where T: Stream
#[async_trait]
impl<T: Stream + ?Sized> Stream for Arc<T> {
    fn context(&self) -> &Context {
        (**self).context()
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        (**self).send_bytes(data).await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        (**self).recv_bytes().await
    }

    async fn close_send(&self) -> Result<()> {
        (**self).close_send().await
    }

    async fn close(&self) -> Result<()> {
        (**self).close().await
    }
}

// Blanket implementation for Box<T> where T: Stream
#[async_trait]
impl<T: Stream + ?Sized> Stream for Box<T> {
    fn context(&self) -> &Context {
        (**self).context()
    }

    async fn send_bytes(&self, data: Bytes) -> Result<()> {
        (**self).send_bytes(data).await
    }

    async fn recv_bytes(&self) -> Result<Bytes> {
        (**self).recv_bytes().await
    }

    async fn close_send(&self) -> Result<()> {
        (**self).close_send().await
    }

    async fn close(&self) -> Result<()> {
        (**self).close().await
    }
}

/// A boxed Stream trait object.
pub type BoxStream = Box<dyn Stream>;

/// A reference-counted Stream.
pub type ArcStream = Arc<dyn Stream>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_new() {
        let ctx = Context::new();
        assert!(!ctx.is_cancelled());
    }

    #[test]
    fn test_context_cancel() {
        let ctx = Context::new();
        ctx.cancel();
        assert!(ctx.is_cancelled());
    }

    #[test]
    fn test_context_child() {
        let parent = Context::new();
        let child = parent.child();

        assert!(!parent.is_cancelled());
        assert!(!child.is_cancelled());

        parent.cancel();

        assert!(parent.is_cancelled());
        assert!(child.is_cancelled());
    }

    #[test]
    fn test_context_child_independent() {
        let parent = Context::new();
        let child = parent.child();

        // Cancelling child doesn't affect parent
        child.cancel();

        assert!(!parent.is_cancelled());
        assert!(child.is_cancelled());
    }

    #[tokio::test]
    async fn test_context_cancelled_future() {
        let ctx = Context::new();

        // Spawn a task that cancels after a delay
        let ctx_clone = ctx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            ctx_clone.cancel();
        });

        // Wait for cancellation
        ctx.cancelled().await;
        assert!(ctx.is_cancelled());
    }
}
